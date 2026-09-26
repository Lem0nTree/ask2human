import { handleWorldCallback } from '../../../lib/server/owner-auth';
import { apiRoute } from '../../../lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  return apiRoute(() => handleWorldCallback(request));
}
