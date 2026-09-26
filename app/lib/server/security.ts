import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE = 'groundwork_session';
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 14;

export function uuid(): string {
  return randomUUID();
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export function csrfTokenForSession(sessionToken: string): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) throw new Error('SESSION_SECRET must contain at least 32 characters');
  return createHmac('sha256', secret).update(`groundwork:csrf:${sessionToken}`).digest('base64url');
}

export function constantTimeStringEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function requestCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get('cookie');
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const equals = part.indexOf('=');
    if (equals < 0) continue;
    if (part.slice(0, equals).trim() === name) {
      try {
        return decodeURIComponent(part.slice(equals + 1).trim());
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

export function appendSessionCookie(headers: Headers, token: string, request: Request): void {
  const secure = new URL(request.url).protocol === 'https:';
  const attributes = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    `Max-Age=${SESSION_TTL_SECONDS}`,
  ];
  if (secure) attributes.push('Secure');
  headers.append('Set-Cookie', attributes.join('; '));
}

export function sameOrigin(request: Request): boolean {
  const configured = process.env.APP_URL;
  const expectedOrigin = configured ? new URL(configured).origin : new URL(request.url).origin;
  const requestOrigin = new URL(request.url).origin;
  const origin = request.headers.get('origin');
  if (origin) {
    if (origin === expectedOrigin) return requestOrigin === expectedOrigin;
    // Local development may use a loopback port while APP_URL stays pinned to the
    // registered production callback. Production builds never take this branch.
    const local = process.env.NODE_ENV !== 'production' && ['localhost', '127.0.0.1', '[::1]'].includes(new URL(requestOrigin).hostname);
    return local && origin === requestOrigin;
  }
  const referer = request.headers.get('referer');
  if (referer) {
    try {
      const refererOrigin = new URL(referer).origin;
      if (refererOrigin === expectedOrigin) return requestOrigin === expectedOrigin;
      const local = process.env.NODE_ENV !== 'production' && ['localhost', '127.0.0.1', '[::1]'].includes(new URL(requestOrigin).hostname);
      return local && refererOrigin === requestOrigin;
    } catch {
      return false;
    }
  }
  return false;
}

export function publicAppOrigin(): string {
  const value = process.env.APP_URL;
  if (!value) throw new Error('APP_URL is required for signed messages and callback URLs');
  return new URL(value).origin;
}
