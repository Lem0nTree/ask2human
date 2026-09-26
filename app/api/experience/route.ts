import { z } from 'zod';
import { apiRoute, readJson } from '../../lib/server/http';
import { HttpError } from '../../lib/server/errors';
import {
  applyForTask,
  getExperienceTask,
  getOwnerExperienceDashboard,
  getTaskApplicantsForOwner,
  getWorkerDashboard,
  getWorkerProfile,
  listPublicTasks,
  ownerSelectWorker,
} from '../../lib/server/experience';
import { requireCsrf, requireSession, readSession } from '../../lib/server/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const idSchema = z.string().uuid();
const writeSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('apply'), taskId: idSchema, note: z.string().trim().max(500).optional() }).strict(),
  z.object({ action: z.literal('select'), taskId: idSchema, workerId: idSchema }).strict(),
]);

export async function GET(request: Request) {
  return apiRoute(async () => {
    const url = new URL(request.url);
    const view = url.searchParams.get('view');
    const session = await readSession(request);

    if (view === 'tasks') {
      const category = url.searchParams.get('category')?.trim() || undefined;
      const query = url.searchParams.get('q')?.trim() || undefined;
      return { tasks: await listPublicTasks({ category, query }) };
    }
    if (view === 'task') {
      const taskId = idSchema.parse(url.searchParams.get('taskId'));
      return { task: await getExperienceTask(taskId, session) };
    }
    if (view === 'worker') {
      const workerId = idSchema.parse(url.searchParams.get('workerId'));
      return { worker: await getWorkerProfile(workerId) };
    }
    if (view === 'work') {
      return { dashboard: await getWorkerDashboard(session ?? await requireSession(request)) };
    }
    if (view === 'agents') {
      return { dashboard: await getOwnerExperienceDashboard(session ?? await requireSession(request)) };
    }
    if (view === 'applicants') {
      const ownerSession = session ?? await requireSession(request);
      const taskId = idSchema.parse(url.searchParams.get('taskId'));
      return { applicants: await getTaskApplicantsForOwner(ownerSession, taskId) };
    }
    throw new HttpError(404, 'view_not_found', 'Experience view was not found.');
  });
}

export async function POST(request: Request) {
  return apiRoute(async () => {
    const session = await requireSession(request);
    requireCsrf(request, session);
    const input = writeSchema.parse(await readJson(request, 16 * 1024));
    if (input.action === 'apply') return applyForTask(session, input.taskId, input.note);
    return ownerSelectWorker(session, input.taskId, input.workerId);
  });
}
