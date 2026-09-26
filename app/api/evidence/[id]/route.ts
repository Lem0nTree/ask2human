import { apiRoute } from '../../../lib/server/http';
import { createEvidenceReadUrl } from '../../../lib/server/evidence';
import { requireSession } from '../../../lib/server/session';
import { HttpError } from '../../../lib/server/errors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return apiRoute(async () => {
    const { id } = await context.params;
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new HttpError(404, 'evidence_not_found', 'Evidence was not found.');
    const session = await requireSession(request);
    return Response.json(await createEvidenceReadUrl(id, { session }));
  });
}
