/**
 * The rules for what a session cookie must contain, with no runtime dependencies.
 *
 * This lives apart from `session.ts` because two runtimes have to agree on it. The Node
 * side signs and verifies HMACs and consults Redis; the Edge middleware can do neither,
 * so it can only check the cookie's shape. When those rules lived in two files they
 * drifted — the Edge copy stayed on the v2 format after v3 added the operator's
 * identity, and rejected every cookie the Node side had just written, or accepted
 * shapes the proxy would refuse. One copy, imported by both, makes that a build error
 * instead of a login loop.
 *
 * Deliberately runtime-neutral: no `node:crypto`, no `server-only`, no Redis. Importing
 * it from Edge code must stay possible.
 */

/**
 * Payload format version. Bumping this invalidates every existing cookie, which is
 * the intended coupling.
 *
 * v3 exists because an operator became a person. v2 could describe a client in full
 * (id, sid, name, email) but an operator was only `{kind: 'operator', epoch}` — no
 * identity and no sid, because a shared password needed neither: the epoch *was* the
 * session. Now an operator has an id to display, a name for the shell, and a
 * per-device sid to revoke, and the cookie carries the per-operator epoch *and* the
 * install-wide one, since either may invalidate it. None of that fits the old shape,
 * so the version moves and every operator is signed out once.
 */
export const PAYLOAD_VERSION = 3;

export type SessionKind = 'operator' | 'client';

export type SessionPayload = {
  /** Payload format version, so a future change can invalidate old cookies. */
  v: number;
  /** Issued-at, epoch seconds. */
  iat: number;
  /** Expiry, epoch seconds. */
  exp: number;
  /** Who owns this session: the install (operator) or a dashboard account (client). */
  kind: SessionKind;
  /**
   * The account's own epoch: the per-operator epoch for `operator`, the account's
   * client session epoch for `client`. A suspension or a per-person revocation moves
   * it and this cookie stops verifying.
   */
  epoch: string;
  /**
   * `operator` only: the install-wide epoch, the kill switch behind
   * `revoke-operator-sessions` and `POST /api/operators/revoke-all`. It is a separate
   * field rather than folded into `epoch` so one bump can log out everyone without
   * touching anyone's per-person epoch.
   */
  globalEpoch?: string;
  /** The raw session id the proxy forwards in `x-client-session`/`x-operator-session`. */
  sid?: string;
  /** `operator` only: which person, so the shell can say who is signed in. */
  operatorId?: string;
  /** `client` only: the dashboard account id, displayed in the shell. */
  clientId?: string;
  /** Display name for the shell. */
  name?: string;
  /** Contact for the shell. */
  email?: string;
};

export function isSessionPayload(value: unknown): value is SessionPayload {
  if (typeof value !== 'object' || value === null) return false;
  const p = value as SessionPayload;
  if (p.v !== PAYLOAD_VERSION) return false;
  if (typeof p.iat !== 'number' || typeof p.exp !== 'number') return false;
  if (p.kind !== 'operator' && p.kind !== 'client') return false;
  if (typeof p.epoch !== 'string' || !p.epoch) return false;
  // Every session is a sid now — an operator has per-device revocation too, so the
  // proxy needs something to forward just as it does for a client.
  if (typeof p.sid !== 'string' || !p.sid) return false;
  if (p.kind === 'client') {
    if (typeof p.clientId !== 'string' || !p.clientId) return false;
    // A client has no install-wide epoch; its `epoch` is the whole story.
    if (p.operatorId !== undefined || p.globalEpoch !== undefined) return false;
    return true;
  }
  // An operator must carry both epochs and an identity. Accepting an operator payload
  // without them would mean falling back to the v2 behaviour, where a bare global epoch
  // authenticated nobody in particular — reintroducing exactly what v3 replaced.
  if (typeof p.operatorId !== 'string' || !p.operatorId) return false;
  if (typeof p.globalEpoch !== 'string' || !p.globalEpoch) return false;
  if (p.clientId !== undefined) return false;
  return true;
}
