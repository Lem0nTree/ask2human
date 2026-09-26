import { apiRoute, readJson } from '../../lib/server/http';
import { agentRequestSchema, toolInputSchemas } from '../../lib/server/schemas';
import { authenticateAgent, createTaskForAgent, getTaskForAgent, requestHire, requestRelease, reviewSubmission, searchWorkers } from '../../lib/server/marketplace';
import { agentListApplicants, agentSelectWorker } from '../../lib/server/experience';
import { assert } from '../../lib/server/errors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  return apiRoute(async () => {
    const agent = await authenticateAgent(request);
    const body = agentRequestSchema.parse(await readJson(request, 128 * 1024));
    assert(agent.scopes.includes(body.tool), 403, 'agent_scope_required', 'Agent credential does not permit this tool.');
    switch (body.tool) {
      case 'search_workers':
        return Response.json(await searchWorkers(agent, toolInputSchemas.search_workers.parse(body.input)));
      case 'create_task':
        return Response.json(await createTaskForAgent(agent, toolInputSchemas.create_task.parse(body.input)));
      case 'get_task':
        return Response.json(await getTaskForAgent(agent, toolInputSchemas.get_task.parse(body.input).taskId));
      case 'list_applicants':
        return Response.json(await agentListApplicants(agent, toolInputSchemas.list_applicants.parse(body.input).taskId));
      case 'select_worker': {
        const input = toolInputSchemas.select_worker.parse(body.input);
        return Response.json(await agentSelectWorker(agent, input.taskId, input.workerId));
      }
      case 'request_hire':
        return Response.json(await requestHire(agent, toolInputSchemas.request_hire.parse(body.input).taskId));
      case 'review_submission':
        return Response.json(await reviewSubmission(agent, toolInputSchemas.review_submission.parse(body.input)));
      case 'request_release':
        return Response.json(await requestRelease(agent, toolInputSchemas.request_release.parse(body.input).taskId));
    }
  });
}
