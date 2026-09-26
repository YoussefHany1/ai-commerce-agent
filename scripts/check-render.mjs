/**
 * Validates render.yaml against the published Blueprint spec.
 *
 * A Blueprint renders successfully and then fails at runtime, which is the worst
 * moment to find out: `APP_BASE_URL` sourced from a bare hostname stops the API from
 * booting, and an unknown `property` value fails the sync outright. Both happened
 * here and neither was caught by the first version of this script, which is why it
 * now checks against the documented value sets rather than spot-checking patterns.
 *
 * Spec: https://render.com/docs/blueprint-spec
 * Run:   node scripts/check-render.mjs   (npm run check:render)
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml');

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const doc = yaml.load(readFileSync(join(root, 'render.yaml'), 'utf8'));

/** Every property the spec documents for `fromService.property`. */
const SERVICE_PROPERTIES = new Set([
  'host',
  'port',
  'hostport',
  'slug',
  'connectionString',
  'connectionPoolString',
  'user',
  'password',
  'database',
]);

/** Plan IDs from the spec's per-type tables, unioned. */
const PLANS = new Set([
  'free',
  '0.1c-256mb',
  '0.5c-512mb',
  '1c-1g',
  '1c-2g',
  '2c-4gb',
  '2c-8gb',
  '4c-8gb',
  '8c-16gb',
  '16c-32gb',
  '32c-64gb',
  '48c-96gb',
  '64c-128gb',
  '96c-192gb',
  '128c-256gb',
  '128c-384gb',
  '128c-512gb',
  '256c-512gb',
  // Key Value tables plans by RAM.
  '256mb',
  '1g',
  '5g',
  '10g',
  '25g',
  '50g',
  '100g',
]);

/**
 * Variables that must hold a parseable absolute URL. `host` and `hostport` are
 * scheme-less by definition ("the service's hostname on the private network"), so
 * feeding one of these to a URL consumer is a silent misconfiguration.
 */
const URL_VARS = new Set(['APP_BASE_URL', 'NEXT_PUBLIC_API_URL', 'API_URL', 'CORS_ORIGINS']);

/**
 * Variables Render sets on every service. These are legitimate `envVarKey` sources
 * even though the Blueprint never declares them; see
 * https://render.com/docs/environment-variables
 */
const PLATFORM_VARS = new Set([
  'RENDER',
  'RENDER_EXTERNAL_HOSTNAME',
  'RENDER_EXTERNAL_URL',
  'RENDER_SERVICE_NAME',
  'RENDER_SERVICE_TYPE',
  'RENDER_INSTANCE_ID',
  'RENDER_GIT_BRANCH',
  'RENDER_GIT_COMMIT',
  'PORT',
  'HOSTNAME',
  'NODE_ENV',
  'WEB_CONCURRENCY',
]);

const problems = [];
const services = doc.services ?? [];
const serviceNames = new Set(services.map((s) => s.name));
const databases = doc.databases ?? [];
const databaseNames = new Set(databases.map((d) => d.name));

if (doc.databases === null) {
  problems.push('databases is present but empty; the spec expects a list, so drop the key entirely');
}

const envByService = new Map(
  services.map((s) => [s.name, new Map((s.envVars ?? []).map((e) => [e.key, e]))]),
);

/** Resolves a fromService/fromDatabase reference to the object it names. */
function resolve(ref) {
  if (ref.fromService) return envByService.get(ref.fromService.name) ?? null;
  if (ref.fromDatabase) {
    return databaseNames.has(ref.fromDatabase.name) ? 'database' : null;
  }
  return null;
}

for (const service of services) {
  const runtimeKeys = new Set((service.envVars ?? []).map((e) => e.key));

  if (service.plan !== undefined && !PLANS.has(String(service.plan))) {
    problems.push(
      `${service.name}: plan '${service.plan}' is not a plan ID from the spec ` +
        `(e.g. free, 0.5c-512mb, 1c-2g)`,
    );
  }

  // Key Value instances require an explicit inbound rule, and an empty list is the
  // documented way to say "private only".
  if (service.type === 'keyvalue' || service.type === 'redis') {
    if (service.ipAllowList === undefined) {
      problems.push(`${service.name}: Key Value instances require an ipAllowList field`);
    }
  }

  for (const arg of service.buildArgs ?? []) {
    // NEXT_PUBLIC_ values are baked into the client bundle by design and are also
    // read at runtime; both sides resolve to the same host, so there is no drift.
    if (runtimeKeys.has(arg.key) && !arg.key.startsWith('NEXT_PUBLIC_')) {
      problems.push(
        `${service.name}: ${arg.key} is both a build arg and a runtime env var, ` +
          'so Render would generate two different values',
      );
    }
  }

  const entries = [
    ...(service.envVars ?? []).map((e) => ({ entry: e, where: 'envVars' })),
    ...(service.buildArgs ?? []).map((e) => ({ entry: e, where: 'buildArgs' })),
  ];

  for (const { entry, where } of entries) {
    const label = `${service.name} ${where} ${entry.key}`;

    if (/SECRET|PASSWORD|TOKEN|HASH|ADMIN_API_KEY/.test(entry.key) && entry.key.startsWith('NEXT_PUBLIC_')) {
      problems.push(`${label} looks like a secret but is exposed to the browser`);
    }

    // Render's generateValue produces an alphanumeric string. That is fine for
    // an opaque secret, but ENCRYPTION_KEY is parsed as hex by
    // Buffer.from(key, 'hex'), which silently drops non-hex characters and
    // yields a wrong-length aes-256-gcm key. The app would boot and then fail on
    // the first token write, so this must be supplied as `openssl rand -hex 32`.
    if (entry.key === 'ENCRYPTION_KEY' && entry.generateValue) {
      problems.push(
        `${label} uses generateValue, which yields an alphanumeric string; aes-256-gcm needs ` +
          '64 hex characters, so use `sync: false` and the output of `openssl rand -hex 32`',
      );
    }

    const ref = entry.fromService;
    if (!ref) {
      if (entry.fromDatabase && !databaseNames.has(entry.fromDatabase.name)) {
        problems.push(
          `${label} references database '${entry.fromDatabase.name}', which this blueprint ` +
            'does not declare; it must exist in the workspace or be wired differently',
        );
      }
      continue;
    }

    // A reference is either a property or an env var key, never both.
    const unknownKeys = Object.keys(ref).filter((k) => !['type', 'name', 'property', 'envVarKey'].includes(k));
    if (unknownKeys.length > 0) {
      problems.push(`${label} fromService has unknown field(s): ${unknownKeys.join(', ')}`);
    }
    if (ref.property && ref.envVarKey) {
      problems.push(`${label} sets both 'property' and 'envVarKey'; pick one`);
    }
    if (!ref.property && !ref.envVarKey) {
      problems.push(`${label} fromService needs either 'property' or 'envVarKey'`);
    }

    if (ref.property && !SERVICE_PROPERTIES.has(ref.property)) {
      problems.push(
        `${label} requests property '${ref.property}', which the spec does not define ` +
          `(valid: ${[...SERVICE_PROPERTIES].join(', ')})`,
      );
    }

    if (URL_VARS.has(entry.key) && (ref.property === 'host' || ref.property === 'hostport')) {
      problems.push(
        `${label} is fed by '${ref.property}', which is a scheme-less private hostname. ` +
          'Use envVarKey: RENDER_EXTERNAL_URL for a public origin, or set the value by hand',
      );
    }

    if (!envByService.has(ref.name)) {
      problems.push(
        `${label} references service '${ref.name}', which this blueprint does not declare; ` +
          'it must exist in the workspace',
      );
      continue;
    }

    if (ref.envVarKey) {
      if (PLATFORM_VARS.has(ref.envVarKey)) {
        // Platform-provided, so there is nothing to look up and nothing to fill in.
        continue;
      }
      const source = envByService.get(ref.name).get(ref.envVarKey);
      if (!source) {
        problems.push(`${label} pulls env var '${ref.envVarKey}', which ${ref.name} does not define`);
      } else if (source.sync === false) {
        problems.push(
          `${label} pulls env var '${ref.envVarKey}' from an unfilled (sync: false) placeholder`,
        );
      } else if (URL_VARS.has(entry.key) && ref.envVarKey !== 'RENDER_EXTERNAL_URL') {
        problems.push(
          `${label} copies '${ref.envVarKey}' from ${ref.name}; a URL must come from ` +
            'RENDER_EXTERNAL_URL to carry a scheme',
        );
      }
    }
  }
}

// The web service must not be able to verify cookies unless the API and the proxy
// agree on the session epoch, which lives in the one Redis both point at.
const web = services.find((s) => s.name === 'agent-web');
if (web) {
  const webRedis = (web.envVars ?? []).find((e) => e.key === 'REDIS_URL');
  if (!webRedis?.fromService) {
    problems.push('agent-web: REDIS_URL should be the same fromService reference the API uses');
  }
  if ((web.envVars ?? []).every((e) => e.key !== 'SESSION_SECRET')) {
    problems.push('agent-web: SESSION_SECRET is required; without it every request is unauthenticated');
  }
}

if (problems.length > 0) {
  console.error('render.yaml problems:');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log(`render.yaml: ${services.length} services, no structural problems found`);
