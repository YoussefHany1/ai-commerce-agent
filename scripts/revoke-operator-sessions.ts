import { bumpOperatorEpoch, bumpOperatorSessionEpoch } from '../src/lib/operatorSession.js';
import { operatorRepo } from '../src/db/repos.js';

/**
 * Invalidates operator dashboard sessions.
 *
 * Two scopes, because an operator is a person and "log out everyone" is no longer the
 * only useful verb:
 *
 *   npm run operator:revoke-sessions                    every operator on the install
 *   npm run operator:revoke-sessions -- --email a@b.c   just that one person
 *   npm run operator:revoke-sessions -- --id <uuid>     just that one person
 *
 * With no selector it moves the install-wide epoch, which is what a suspected leak of
 * the shared configuration needs. With a selector it moves only that operator's epoch,
 * so the one browser you suspect is dropped without signing everybody else out. The
 * epochs live in Redis, so either takes effect across every web replica immediately.
 *
 * Note what this cannot do: it does not touch Supabase. The credential that would let
 * someone mint a fresh session stays valid. Suspend the account, or reset its password,
 * for that — see `npm run operator:suspend`.
 */

const args = process.argv.slice(2);

function argValue(flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i === -1) return undefined;
  const value = args[i + 1];
  // A flag with no value would otherwise resolve to the next flag, or to undefined and
  // quietly fall through to the global bump — the one outcome an operator running this
  // by hand is least likely to intend.
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} needs a value`);
  }
  return value;
}

const email = argValue('--email');
const id = argValue('--id');

if (email && id) {
  throw new Error('give --email or --id, not both');
}

async function resolveTarget(): Promise<{ id: string; label: string } | null> {
  if (id) return { id, label: `operator ${id}` };
  if (!email) return null;

  const operator = await operatorRepo.findByEmail(email);
  if (!operator) {
    // Failing loudly matters more than the usual uniform 401: this is an operator
    // running a script with shell access, not a caller probing for accounts.
    throw new Error(
      `no operator with email ${email}. Check the address, or run without a selector to log out every operator.`,
    );
  }
  return { id: operator.id, label: `${operator.name} <${operator.email}>` };
}

const target = await resolveTarget();

if (!target) {
  const epoch = await bumpOperatorSessionEpoch();
  console.log(`operator session epoch bumped to ${epoch}; all operator dashboard sessions are now invalid`);
} else {
  const epoch = await bumpOperatorEpoch(target.id);
  console.log(`epoch for ${target.label} bumped to ${epoch}; that operator's sessions are now invalid, others are unaffected`);
}

process.exit(0);
