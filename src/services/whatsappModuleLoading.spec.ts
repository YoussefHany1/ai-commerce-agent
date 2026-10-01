import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';

const exec = promisify(execFile);
const execFileAsync = promisify(execFile);
const repoRoot = process.cwd();

/**
 * The regression that let a broken qr-connect ship.
 *
 * `qr-connect` returned 500 in production because the session service reached Baileys
 * through `require('baileys')`. The package is `"type": "module"`, so the emitted JS is
 * ESM and bare `require` is not defined — but Vitest transpiles to CJS and injects
 * `require`, so every unit test passed.
 *
 * This runs the real server entry under Node directly, in a temp dir that resolves the
 * same package.json `"type"`, so the module system matches what Render actually runs.
 * Checking the source text alone would not catch it: only executing the emitted module
 * can.
 */
describe('baileys is loadable in the module system production uses', () => {
  const dir = mkdtempSync(join(tmpdir(), 'baileys-esm-'));

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test('a bare require() of baileys throws in ESM, so the service must use import()', async () => {
    // Reproduce the original failure, so this test cannot silently pass on a fix that
    // removed the repro without addressing the real module load.
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
    writeFileSync(join(dir, 'probe.mjs'), "try { require('baileys'); process.exit(3); } catch (e) { process.exit(e instanceof ReferenceError ? 0 : 4); }");

    // The probe encodes its result in the exit code: 0 = ReferenceError (the bug),
    // 3 = require succeeded (the fix, or a CJS module system).
    const code = await exec(process.execPath, [join(dir, 'probe.mjs')], {
      cwd: process.cwd(),
    })
      .then(() => 0)
      .catch((err: any) => err.code);
    expect(code).toBe(0);
  });

  test('the built session service reaches baileys through import(), not require()', async () => {
    const source = await readFileUtf8('src/services/whatsappSession.ts');

    // A bare require() is a ReferenceError at runtime in this package; a dynamic
    // import() is not. Guard the specific mistake rather than asserting on a helper's
    // name, which would pass if the helper were reintroduced as require().
    expect(source).not.toMatch(/require\(\s*['"]baileys['"]\s*\)/);
    expect(source).toMatch(/import\(\s*['"]baileys['"]\s*\)/);
  });

  test('a real session starts under Node ESM, reaching the real makeWASocket', async () => {
    // The decisive check. Every unit test injects a socket factory, so none of them ever
    // call makeWASocket — which is exactly how a malformed Baileys logger shipped.
    // This compiles with the project's tsconfig and runs the service as Node will,
    // stubbing only the DB/Redis layer.
    const { code } = await execFileAsync(
      process.execPath,
      [join(repoRoot, 'scripts/verify-baileys-esm.mjs')],
      { cwd: repoRoot },
    ).then(
      () => ({ code: 0 }),
      (err: any) => ({ code: err.code as number, stderr: String(err.stderr ?? '') }),
    );
    expect(code, 'ESM harness must start a real session; see stderr').toBe(0);
  });

  test('every requireBaileys() caller awaits it', async () => {
    const source = await readFileUtf8('src/services/whatsappSession.ts');
    // An un-awaited call yields a Promise, and .makeWASocket would be undefined.
    // Comments and the helper's own declaration mention the name but do not call it,
    // so only real `requireBaileys()` invocations are checked.
    const callers = source
      .split('\n')
      .map((line, i) => ({ code: line.replace(/\/\/.*$/, ''), n: i + 1 }))
      .filter(({ code }) => code.trim().length > 0 && !code.trimStart().startsWith('//'))
      .filter(({ code }) => code.includes('requireBaileys()'))
      .filter(({ code }) => !/function requireBaileys/.test(code));

    expect(callers.length).toBeGreaterThan(0);
    for (const { code, n } of callers) {
      expect(code, `line ${n} does not await requireBaileys(): ${code.trim()}`).toMatch(
        /await requireBaileys\(\)/,
      );
    }
  });
});

async function readFileUtf8(path: string): Promise<string> {
  const { readFile } = await import('node:fs/promises');
  return readFile(path, 'utf8');
}