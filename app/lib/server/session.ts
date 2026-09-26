import { constantTimeStringEqual, csrfTokenForSession, randomToken, sameOrigin, SESSION_COOKIE, SESSION_TTL_SECONDS, sha256, requestCookie, uuid } from './security';
import { db } from './db';
import { HttpError } from './errors';

export type Session = {
  id: string;
  rawToken: string;
  csrfToken: string;
  workerId: string | null;
  ownerId: string | null;
  expiresAt: Date;
};

export async function readSession(request: Request, createIfMissing = false): Promise<Session | null> {
  const token = requestCookie(request, SESSION_COOKIE);
  if (token) {
    const tokenHash = sha256(token);
    const [row] = await db()`
      SELECT id, csrf_hash, worker_id, owner_id, expires_at
      FROM sessions WHERE token_hash = ${tokenHash} AND expires_at > now()
    `;
    if (row) {
      const csrfToken = csrfTokenForSession(token);
      if (sha256(csrfToken) !== row.csrf_hash) throw new HttpError(401, 'session_invalid', 'Session is invalid.');
      await db()`UPDATE sessions SET last_seen_at = now() WHERE id = ${row.id}`;
      return {
        id: row.id,
        rawToken: token,
        csrfToken,
        workerId: row.worker_id,
        ownerId: row.owner_id,
        expiresAt: row.expires_at,
      };
    }
  }
  if (!createIfMissing) return null;

  const rawToken = randomToken();
  const csrfToken = csrfTokenForSession(rawToken);
  const id = uuid();
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000);
  await db()`
    INSERT INTO sessions (id, token_hash, csrf_hash, expires_at)
    VALUES (${id}, ${sha256(rawToken)}, ${sha256(csrfToken)}, ${expiresAt})
  `;
  return { id, rawToken, csrfToken, workerId: null, ownerId: null, expiresAt };
}

export async function requireSession(request: Request): Promise<Session> {
  const session = await readSession(request);
  if (!session) throw new HttpError(401, 'session_required', 'Start a browser session first.');
  return session;
}

export function requireCsrf(request: Request, session: Session): void {
  if (!sameOrigin(request)) throw new HttpError(403, 'origin_rejected', 'This request must come from this site.');
  const supplied = request.headers.get('x-csrf-token') ?? '';
  if (!supplied || !constantTimeStringEqual(supplied, session.csrfToken)) {
    throw new HttpError(403, 'csrf_rejected', 'The request token is missing or invalid.');
  }
}
