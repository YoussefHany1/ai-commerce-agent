import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createClient } from '@supabase/supabase-js';
import postgres from 'postgres';
import { clientRepo } from '../src/db/repos.js';
import { hashPassword } from '../src/lib/passwordHash.js';

const API = process.env.API_BASE ?? 'http://localhost:3010';
const SUPABASE_URL = process.env.SUPABASE_URL!;
const ANON = process.env.SUPABASE_ANON_KEY!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const DB_URL = process.env.VERIFY_DB_URL ?? process.env.DATABASE_URL!;
const REDIS_URL = process.env.REDIS_URL ?? 'redis://:dev-redis@localhost:6379';

const admin = createClient(SUPABASE_URL, SERVICE, { auth: { persistSession: false } });
const anon = createClient(SUPABASE_URL, ANON, { auth: { persistSession: false } });
const sql = postgres(DB_URL, { max: 1 });

const stamp = Date.now();
const emailA = `ph17-a-${stamp}@example.com`;
const emailB = `ph17-b-${stamp}@example.com`;
const results: string[] = [];
const createdUids: string[] = [];

function mark(name: string, ok: boolean, detail = ''): void {
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}
async function api(path: string, opts: { method?: string; body?: unknown; sid?: string } = {}) {
  const res = await fetch(`${API}${path}`, {
    method: opts.method ?? 'POST',
    headers: {
      'content-type': 'application/json',
      ...(opts.sid ? { 'x-client-session': opts.sid } : {}),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const redirectTo = new URL('login/reset', process.env.APP_BASE_URL).toString();

try {
  // ---- Check 1: self-service register -> email-confirm OTP -> exchange -> login ----
  const pw1 = `pw-${randomBytes(6).toString('hex')}-Ab1!`;
  let r = await api('/api/auth/client/register', { body: { name: 'Live Reg A', email: emailA, password: pw1 } });
  mark('register (email_confirm:false, uniform 200)', r.status === 200 && r.body.ok === true, `HTTP ${r.status}`);

  const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
    type: 'signup',
    email: emailA,
    // The API never reads this — the link is verified as a signup OTP, not used as a
    // password — but supabase-js requires a password on a signup link to be valid.
    password: pw1,
    options: { redirectTo },
  });
  const signupToken = linkData?.properties?.hashed_token ?? null;
  mark('admin.generateLink(signup) delivers OTP', !linkErr && !!signupToken, linkErr?.message ?? '');

  const { data: otpData } = await anon.auth.verifyOtp({ email: emailA, token: signupToken!, type: 'signup' });
  const signupAccessToken = otpData?.session?.access_token ?? null;
  mark('verifyOtp(signup) confirms identity + session', !!signupAccessToken);

  if (signupAccessToken) {
    const ex = await api('/api/auth/exchange', { body: { accessToken: signupAccessToken } });
    mark('exchange trades confirmed session for sid', ex.status === 200 && !!ex.body.sid, `HTTP ${ex.status}`);
  }

  const ln = await api('/api/auth/client/login', { body: { email: emailA, password: pw1 } });
  mark('login works post-confirmation (Supabase path)', ln.status === 200 && !!ln.body.sid, `HTTP ${ln.status}`);
  const wrong = await api('/api/auth/client/login', { body: { email: emailA, password: 'definitely-wrong-pw' } });
  mark('login wrong password -> uniform 401', wrong.status === 401 && wrong.body.error === 'invalid_credentials');

  const me = await api('/api/auth/client/me', { sid: ln.body.sid });
  mark('guarded /me resolves sid to account (client RLS)', me.status === 200 && me.body.client?.email === emailA, `HTTP ${me.status}`);

  const uidA = signupAccessToken
    ? ((await admin.auth.admin.listUsers({ page: 1, perPage: 1000 })).data.users.find((u) => u.email === emailA)?.id ?? null)
    : null;
  if (uidA) createdUids.push(uidA);

  // ---- Check 2: legacy import + recovery link round-trip ----
  const legacyPw = 'legacy-scrypt-pass-1';
  const legacyHash = await hashPassword(legacyPw);
  const legacyId = await clientRepo.create({ name: 'Live Legacy', email: emailB, passwordHash: legacyHash });
  const preRow = await clientRepo.findByEmail(emailB);
  mark('legacy pre-import row has a scrypt hash', preRow?.passwordHash === legacyHash, `id ${legacyId}`);

  const proc = spawnSync(
    process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['run', 'client:import-supabase'],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DATABASE_URL: DB_URL,
        REDIS_URL,
        SUPABASE_URL,
        SUPABASE_SERVICE_ROLE_KEY: SERVICE,
        SUPABASE_ANON_KEY: ANON,
        APP_BASE_URL: process.env.APP_BASE_URL,
      },
      encoding: 'utf8',
    },
  );
  const outText = `${proc.stdout ?? ''}${proc.stderr ?? ''}`;
  const linkMatch = /recovery:\s*(\S+)/.exec(outText);
  mark('import script links identity + prints recovery link', proc.status === 0 && !!linkMatch, linkMatch ? 'link printed' : outText.split('\n').slice(-2).join(' ').slice(0, 200));

  const postRow = await clientRepo.findByEmail(emailB);
  mark('post-import: supabase_uid set, scrypt hash withdrawn', !!postRow?.supabaseUid && postRow.passwordHash === null);

  const recoveryToken = linkMatch ? new URL(linkMatch[1]).searchParams.get('token') : null;
  let uidB: string | null = null;
  if (recoveryToken) {
    const prev = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
    uidB = prev.data.users.find((u) => u.email === emailB)?.id ?? null;
    if (uidB) createdUids.push(uidB);
  }

  const newPw = 'fresh-recovery-password-1!';
  let recoveryOk = false;
  if (recoveryToken && uidB) {
    const otp = await anon.auth.verifyOtp({ email: emailB, token: recoveryToken, type: 'recovery' });
    if (otp.data.session?.access_token) {
      // A session minted *before* the password rotation, so the checks below have a
      // stale credential to prove dead rather than only asserting the new one works.
      const pre = await api('/api/auth/exchange', { body: { accessToken: otp.data.session.access_token } });
      const sidBefore = pre.body.sid ?? null;
      mark('recovery link: pre-reset exchange mints a session', pre.status === 200 && !!sidBefore, `HTTP ${pre.status}`);

      const up = await anon.auth.updateUser({ password: newPw });
      if (!up.error) {
        // Password rotation can roll the session tokens, so the fresh one is read back
        // from the live client rather than reused from before updateUser.
        const { data: afterRot } = await anon.auth.getSession();
        const fresh = afterRot.session?.access_token ?? otp.data.session.access_token;

        // One call now does the whole job: the API moves the epoch and mints together,
        // so a second exchange is neither needed nor wanted.
        const ex = await api('/api/auth/exchange', { body: { accessToken: fresh, rotate: true } });
        const sidAfter = ex.body.sid ?? null;
        recoveryOk = ex.status === 200 && !!sidAfter;
        mark('recovery: single exchange with rotate:true mints a session', recoveryOk, `HTTP ${ex.status}`);

        // The point of rotate: every pre-reset session is dead, and the person who
        // completed the reset is not logged out of the session they just made.
        if (sidBefore) {
          const stale = await api('/api/auth/client/me', { sid: sidBefore });
          mark('recovery: pre-reset session is revoked by rotate', stale.status === 401, `HTTP ${stale.status}`);
        }
        if (sidAfter) {
          const live = await api('/api/auth/client/me', { sid: sidAfter });
          mark('recovery: post-rotate session works', live.status === 200 && live.body.client?.email === emailB, `HTTP ${live.status}`);
        }

        const lnf = await api('/api/auth/client/login', { body: { email: emailB, password: newPw } });
        mark('login with new password (Supabase path)', lnf.status === 200 && !!lnf.body.sid, `HTTP ${lnf.status}`);
      } else {
        mark('recovery link: password rotation', false, up.error.message);
      }
    } else {
      mark('recovery link: verifyOtp(recovery) session', false, otp.error?.message ?? 'no session');
    }
    const lold = await api('/api/auth/client/login', { body: { email: emailB, password: legacyPw } });
    mark('legacy scrypt password now rejected (hash withdrawn)', lold.status === 401, `HTTP ${lold.status}`);
  } else {
    mark('recovery link: verifyOtp -> rotate exchange', false, 'no recovery token');
  }

  // ---- Cleanup ----
  for (const uid of createdUids) {
    try {
      await admin.auth.admin.deleteUser(uid);
      console.log(`  cleaned identity ${uid}`);
    } catch (e) {
      console.error(`  cleanup failed for ${uid}: ${(e as Error).message}`);
    }
  }
  await sql`delete from clients where id in (${sql([legacyId])})`;
  await sql`delete from clients where email in (${sql([emailA, emailB])})`;
  console.log('  cleaned client rows');
} catch (err) {
  mark('verifier (unexpected error)', false, (err as Error).message);
} finally {
  await admin.auth.signOut().catch(() => {});
  await sql.end({ timeout: 3 }).catch(() => {});
}

const failed = results.filter((r) => r.startsWith('FAIL'));
console.log(`\nPhase A live check (${failed.length} failed / ${results.length} total)`);
for (const r of results) console.log(r);
process.exit(failed.length > 0 ? 1 : 0);