import { apiRoute } from '../../lib/server/http';
import { uploadEvidence } from '../../lib/server/evidence';
import { requireCsrf, requireSession } from '../../lib/server/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  return apiRoute(async () => {
    const session = await requireSession(request);
    requireCsrf(request, session);
    return Response.json(await uploadEvidence(request, session));
  });
}
