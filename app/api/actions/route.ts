import { actionSchema } from '../../lib/server/schemas';
import { apiRoute, readJson } from '../../lib/server/http';
import { requireCsrf, requireSession } from '../../lib/server/session';
import { createWorkerProfile, startWalletChallenge, completeWalletChallenge, startWorkerVerification, completeWorkerVerification } from '../../lib/server/identity';
import { beginOwnerLogin, beginOwnerApproval } from '../../lib/server/owner-auth';
import { startAgentAuthorization, authorizeExistingAgent } from '../../lib/server/profile-authorization';
import {
  createAgent, ownerCreateTask, ownerRequestHire, ownerReviewSubmission, ownerRequestRelease, ownerRequestReject,
  acceptTask, cancelTask, resolveReview,
} from '../../lib/server/marketplace';
import {
  buildFundingTransaction, confirmFunding, buildSubmissionTransaction, confirmSubmission,
  buildReleaseTransaction, confirmRelease, buildRefundTransaction, confirmRefund,
  buildScoreSetupTransaction, confirmScoreSetup, buildTimeoutClaimTransaction, confirmTimeoutClaim,
  buildRejectTransaction, confirmReject, buildRatingTransaction, confirmRating,
  acknowledgeFundingFee,
} from '../../lib/server/payments';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  return apiRoute(async () => {
    const session = await requireSession(request);
    requireCsrf(request, session);
    const input = actionSchema.parse(await readJson(request));
    switch (input.action) {
      case 'start_worker':
        return Response.json(await createWorkerProfile(session, input));
      case 'start_wallet_challenge':
        return Response.json(await startWalletChallenge(session, input.purpose, input.address));
      case 'complete_wallet_challenge':
        return Response.json(await completeWalletChallenge(session, input.challengeId, input.signature));
      case 'start_worker_verification':
        return Response.json(await startWorkerVerification(session));
      case 'complete_worker_verification':
        return Response.json(await completeWorkerVerification(session, input.challengeId, input.idkitResult));
      case 'begin_owner_login':
        return Response.json(await beginOwnerLogin(session));
      case 'begin_owner_authorization':
        return Response.json(await beginOwnerApproval(session, input.approvalId));
      case 'start_agent_authorization':
        if (input.agentId) {
          return Response.json(await startAgentAuthorization(session, { agentId: input.agentId }));
        }
        return Response.json(await startAgentAuthorization(session, {
          name: input.name!,
          categories: input.categories!,
          maxTaskAtomic: input.maxTaskAtomic!,
          totalBudgetAtomic: input.totalBudgetAtomic!,
        }));
      case 'create_agent':
        return Response.json(await createAgent(session, input));
      case 'authorize_agent':
        return Response.json(await authorizeExistingAgent(session, input));
      case 'owner_create_task': {
        const { action: _action, ...fields } = input;
        return Response.json(await ownerCreateTask(session, input.agentId, fields));
      }
      case 'owner_request_hire':
        return Response.json(await ownerRequestHire(session, input.agentId, input.taskId));
      case 'owner_review_submission':
        return Response.json(await ownerReviewSubmission(session, input.agentId, input));
      case 'owner_request_release':
        return Response.json(await ownerRequestRelease(session, input.agentId, input.taskId));
      case 'owner_request_reject':
        return Response.json(await ownerRequestReject(session, input.agentId, input.taskId));
      case 'accept_task':
        return Response.json(await acceptTask(session, input.taskId));
      case 'fund_task':
        return Response.json(await buildFundingTransaction(session, input.taskId));
      case 'confirm_funding':
        return Response.json(await confirmFunding(session, input.taskId, input.digest));
      case 'acknowledge_funding_fee':
        return Response.json(await acknowledgeFundingFee(session, input.taskId));
      case 'build_score_setup':
        return Response.json(await buildScoreSetupTransaction(session, input.taskId));
      case 'confirm_score_setup':
        return Response.json(await confirmScoreSetup(session, input.taskId, input.digest));
      case 'build_submission':
        return Response.json(await buildSubmissionTransaction(session, input.taskId));
      case 'confirm_submission':
        return Response.json(await confirmSubmission(session, input.taskId, input.digest));
      case 'build_release':
        return Response.json(await buildReleaseTransaction(session, input.taskId));
      case 'confirm_release':
        return Response.json(await confirmRelease(session, input.taskId, input.digest));
      case 'build_refund':
        return Response.json(await buildRefundTransaction(session, input.taskId));
      case 'confirm_refund':
        return Response.json(await confirmRefund(session, input.taskId, input.digest));
      case 'build_timeout_claim':
        return Response.json(await buildTimeoutClaimTransaction(session, input.taskId));
      case 'confirm_timeout_claim':
        return Response.json(await confirmTimeoutClaim(session, input.taskId, input.digest));
      case 'build_reject':
        return Response.json(await buildRejectTransaction(session, input.taskId));
      case 'confirm_reject':
        return Response.json(await confirmReject(session, input.taskId, input.digest));
      case 'build_rating':
        return Response.json(await buildRatingTransaction(session, input.taskId, input.stars));
      case 'confirm_rating':
        return Response.json(await confirmRating(session, input.taskId, input.digest));
      case 'cancel_task':
        return Response.json(await cancelTask(session, input.taskId));
      case 'resolve_review':
        return Response.json(await resolveReview(session, input.taskId, input.decision, input.note));
    }
  });
}
