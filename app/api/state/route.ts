import { NextRequest } from 'next/server';
import { apiRoute } from '../../lib/server/http';
import { getBrowserState } from '../../lib/server/marketplace';
import { appendSessionCookie, requestCookie, SESSION_COOKIE } from '../../lib/server/security';
import { readSession } from '../../lib/server/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  return apiRoute(async () => {
    const session = await readSession(request, true);
    if (!session) throw new Error('Session creation failed.');
    const state = await getBrowserState(session);
    const headers = new Headers();
    if (requestCookie(request, SESSION_COOKIE) !== session.rawToken) appendSessionCookie(headers, session.rawToken, request);
    return Response.json({ csrfToken: session.csrfToken, ...state }, { headers });
  });
}
