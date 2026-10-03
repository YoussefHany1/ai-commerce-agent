import { clientRepo, operatorRepo } from '../db/repos.js';

/**
 * Resolving a verified Supabase identity to exactly one local account.
 *
 * Two flows start from a Supabase identity and must agree on who it is: the OAuth /
 * reset `exchange`, and the password sign-in. They differ in two deliberate ways, and
 * those differences are parameters rather than two copies of the lookup — a copy is how
 * the two surfaces would drift on the conflict and suspension rules, which are exactly
 * the rules an attacker benefits from getting wrong.
 *
 *   - `autoProvision` is the OAuth-only behaviour: a token that verifies but reaches no
 *     row creates a client, because a merchant who signs in with Google must land
 *     somewhere. Password sign-in never provisions: an account has to already exist.
 *   - `linkOperatorByEmail` binds an unlinked operator row by the address a password
 *     just proved. The exchange does *not* do this: an operator holding an address must
 *     not have a merchant row silently linked beneath them. The password path keeps the
 *     binding for operators invited before their identity was linked.
 *
 * The operator/client refusal is shared by both. The two `supabase_uid` unique indexes
 * are per-table, so the schema permits one identity linked on both sides; preferring
 * either would hand one of two real people the other's privileges, so it is a refusal.
 *
 * Throws on database failure — callers map that to 503 rather than treating it as "no
 * account", which would report an outage as bad credentials.
 */

export type ResolvedIdentity = {
  kind: 'operator' | 'client';
  id: string;
  name: string;
  email: string;
};

export type IdentityResolution =
  | { status: 'ok'; identity: ResolvedIdentity }
  | { status: 'none' }
  | { status: 'conflict'; operatorId: string; clientId: string };

export type ResolveSupabaseInput = {
  userId: string;
  email?: string;
  name?: string;
  /** OAuth-style flows only: create a client when no row matches. */
  autoProvision?: boolean;
  /** Password sign-in only: bind an operator row that has no `supabase_uid` yet. */
  linkOperatorByEmail?: boolean;
};

export function normalizeIdentityEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function resolveSupabaseIdentity(input: ResolveSupabaseInput): Promise<IdentityResolution> {
  const { userId, name, autoProvision, linkOperatorByEmail } = input;
  const email = input.email ? normalizeIdentityEmail(input.email) : undefined;

  // Both sides in one round trip: "which kind" is only meaningful once both are asked.
  const [operator, clientByUid] = await Promise.all([
    operatorRepo.getBySupabaseUid(userId),
    clientRepo.getBySupabaseUid(userId),
  ]);

  if (operator && clientByUid) {
    return { status: 'conflict', operatorId: operator.id, clientId: clientByUid.id };
  }

  if (operator) {
    if (operator.status !== 'active') return { status: 'none' };
    return { status: 'ok', identity: operatorIdentity(operator) };
  }

  let client = clientByUid;
  if (!client && email) {
    const [byEmail, operatorByEmail] = await Promise.all([
      clientRepo.findByEmail(email),
      operatorRepo.findByEmail(email),
    ]);

    if (linkOperatorByEmail && operatorByEmail && !byEmail) {
      // An operator whose identity was never linked. Bind now, on a credential that
      // just proved the address — and only when no merchant row shares it, or binding
      // would make one person both.
      if (operatorByEmail.status !== 'active') return { status: 'none' };
      await operatorRepo.setSupabaseUid(operatorByEmail.id, userId);
      return { status: 'ok', identity: operatorIdentity(operatorByEmail) };
    }

    if (byEmail && !operatorByEmail) {
      await clientRepo.setSupabaseUid(byEmail.id, userId);
      client = byEmail;
    } else if (!byEmail && !operatorByEmail && autoProvision) {
      const displayName = name || email.split('@')[0];
      const newId = await clientRepo.create({
        name: displayName,
        email,
        passwordHash: null,
        supabaseUid: userId,
      });
      client = await clientRepo.get(newId);
    }
  }

  // A client matched by uid is authoritative even when suspended: falling through to
  // the email fallback would let a suspended account sign in through its address.
  if (!client || client.status !== 'active') return { status: 'none' };
  return { status: 'ok', identity: clientIdentity(client) };
}

function operatorIdentity(o: { id: string; name: string; email: string }): ResolvedIdentity {
  return { kind: 'operator', id: o.id, name: o.name, email: o.email };
}

function clientIdentity(c: { id: string; name: string; email: string }): ResolvedIdentity {
  return { kind: 'client', id: c.id, name: c.name, email: c.email };
}
