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

/**
 * Plan IDs from the spec's per-type tables, unioned. Web services take the named
 * plans (free, starter, ...); private services and Key Value take RAM-based ids.
 */
const PLANS = new Set([
  'free',
  'starter',
  'standard',
  'pro',
  'pro_max',
  'pro_plus',
  'pro_ultra',
  'pro_ultra_plus',
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
 * Keys Render refuses on a free plan. It validates these at *sync* time, so a
 * single offending key fails the whole Blueprint apply rather than one service —
 * the dashboard and Redis come back unprovisioned too, and the error names only
 * the service index.
 *
 * preDeployCommand is the one this repo hit: it is how migrations used to run on
 * Render, and Render answers "pre-deploy command is not supported for free tier
 * services". Migrate out of band instead (see DEPLOYMENT.md), or pay for starter.
 */
const PAID_ONLY_KEYS = [
  'preDeployCommand',
  'cronSchedule',
  'maxScale',
];

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
        `(e.g. free, starter, 0.5c-512mb, 1c-2g)`,
    );
  }

  // Free plan, paid-plan-only key. Render fails the entire Blueprint sync on
  // this, naming only `services[n]`, so catch it where the service is named.
  if (String(service.plan) === 'free') {
    for (const key of PAID_ONLY_KEYS) {
      if (service[key] !== undefined) {
        problems.push(
          `${service.name}: ${key} is not supported on the free plan, and Render rejects the ` +
            `whole Blueprint with "services[n]: ${key} is not supported for free tier services". ` +
            `Remove it, or change the plan to 'starter'`,
        );
      }
    }
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
      } else if (source.generateValue) {
        // A `generateValue: true` source is re-rolled every time the Blueprint is
        // applied, but a `fromService` copy only refreshes when the *consuming*
        // service is redeployed. Nothing ties the two together, so re-applying the
        // Blueprint can leave the consumer holding the previous value with no error
        // reported anywhere.
        //
        // ADMIN_API_KEY hit exactly this and is worth spelling out: the BFF attaches
        // the key to every proxied call and the API validates it, so a stale copy
        // makes every operator-guarded route 401. The dashboard reads any 401 as an
        // expired session and bounces the operator back to /login in a loop, even
        // though the password was right and the session cookie was never the problem.
        problems.push(
          `${label} copies '${ref.envVarKey}' from ${ref.name}, which uses generateValue; ` +
            'Render re-rolls that on every Blueprint apply but refreshes this copy only when ' +
            `${label.split(' ')[0]} is redeployed, so the two can silently drift. Set ` +
            '`sync: false` on both sides and give them the same literal value',
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
  // The web service must NOT hold the install-wide admin key. The proxy forwards a
  // verified session id and the API resolves the person behind it, so this value is
  // unused — and an unused full-privilege credential sitting in a second service is
  // exactly the thing this rewrite set out to remove. A stale copy is worse than none:
  // it still looks like a working configuration to whoever reads the dashboard.
  const webAdminKey = (web.envVars ?? []).find((e) => e.key === 'ADMIN_API_KEY');
  if (webAdminKey) {
    problems.push(
      'agent-web: ADMIN_API_KEY must be removed. Sessions are forwarded as a header the ' +
        'API resolves per person; the proxy never sends this key (web/lib/server/upstream.ts), ' +
        'so keeping it only leaves a second full-privilege copy to rotate and leak',
    );
  }
  // The anon key lets the web server finish the browser-side flows; the service-role
  // key would let it bypass RLS entirely, so its presence is a hard failure rather
  // than a warning.
  for (const required of ['SUPABASE_URL', 'SUPABASE_ANON_KEY']) {
    if ((web.envVars ?? []).every((e) => e.key !== required)) {
      problems.push(
        `agent-web: ${required} is required; without it the OAuth callback and password-reset ` +
          'flows cannot complete and sign-in dead-ends',
      );
    }
  }
  if ((web.envVars ?? []).some((e) => e.key === 'SUPABASE_SERVICE_ROLE_KEY')) {
    problems.push(
      'agent-web: SUPABASE_SERVICE_ROLE_KEY must never be set here. It bypasses RLS on every ' +
        'table and can rewrite any auth user; the API service is the only one that needs it',
    );
  }
}

// The other end of that same credential: the API validates the key the BFF sends.
const api = services.find((s) => s.name === 'agent-api');
if (api && (api.envVars ?? []).every((e) => e.key !== 'ADMIN_API_KEY')) {
  problems.push(
    'agent-api: ADMIN_API_KEY is required; src/lib/auth.ts answers 503 auth_not_configured ' +
      'without it, so every operator-guarded route fails',
  );
}

if (problems.length > 0) {
  console.error('render.yaml problems:');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log(`render.yaml: ${services.length} services, no structural problems found`);
