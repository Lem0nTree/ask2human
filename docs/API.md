# Backend API

Mainnet integration contract. See the [live checklist](DEVELOPMENT_CHECKLIST.md) for implementation and deployment acceptance; this reference alone does not establish a successful live flow.

The browser API is JSON over same-origin requests. Agent tools use a separate
JSON endpoint and a scoped bearer credential. Server routes never accept an
agent-provided worker payout address or an `approved` flag.

## Browser session and state

`GET /api/state` creates or resumes an opaque, HTTP-only session cookie and
returns `{ csrfToken, config, session, agents, tasks, approvals }`. The `config` object
contains only public settings such as the selected Sui network and whether
World enrollment is configured. `session` reports the current owner/worker
profile IDs and safe public profile data; it never includes World nullifiers,
OIDC subjects, credential hashes, or private evidence keys. Use `csrfToken` as
the `X-CSRF-Token` header on every `POST /api/actions` call.

Each task includes `evidence: null` or authorized evidence metadata (`id`, `mediaType`,
`byteLength`, `sha256`, `report`, and `uploadedAt`). Evidence metadata is shown only
to the assigned worker or task owner; agent tools expose metadata only for that
agent's task. The storage key is never returned.

`POST /api/actions` accepts `{ action, ...fields }`. It requires the session
cookie, the matching same-origin `Origin`, and the CSRF header. Browser actions
are:

| Action | Fields | Result |
| --- | --- | --- |
| `start_worker` | `displayName`, `category`, `area`, `skills[]` | Creates/resumes a pending worker profile. |
| `start_wallet_challenge` | `purpose: "worker" | "owner" | "recover_worker" | "recover_owner"`, `address` | Returns a short-lived Sui personal-message challenge. |
| `complete_wallet_challenge` | `challengeId`, `signature` | Verifies the exact challenge and binds or recovers the wallet account. |
| `start_worker_verification` | — | Returns the server-built IDKit v4 request for this worker. |
| `complete_worker_verification` | `challengeId`, `idkitResult` | Verifies the full IDKit result server-side and activates the unique worker. |
| `begin_owner_login` | — | Returns an authorization URL for fresh World ID for Agents authentication. |
| `begin_owner_authorization` | `approvalId` | Starts a fresh World flow bound to that exact task approval. |
| `start_agent_authorization` | `agentId` for an existing profile, or `name`, `categories[]`, `maxTaskAtomic`, `totalBudgetAtomic` for a new one | Returns `{ challengeId, message }` to sign with the linked wallet. |
| `create_agent` | `name`, `categories[]`, `maxTaskAtomic`, `totalBudgetAtomic`, `challengeId`, `signature` | Verifies the signed profile limits, creates the owned agent, and returns its `gw_live_…` API key once. |
| `authorize_agent` | `agentId`, `challengeId`, `signature` | Authorizes an existing profile’s current limits with the linked wallet. |
| `owner_create_task` | `agentId`, task fields below | Creates a task through an owned agent's normal category and budget policy. |
| `owner_request_hire` | `agentId`, `taskId` | Runs the same hire request policy as the agent tool for an owned agent. |
| `owner_review_submission` | `agentId`, `taskId`, `decision`, optional `note` | Runs the same review policy as the agent tool for an owned agent. |
| `owner_request_release` | `agentId`, `taskId` | Runs the same release request policy as the agent tool for an owned agent. |
| `owner_request_reject` | `agentId`, `taskId` | Requests fresh owner approval for rejection under the agreed split. |
| `accept_task` | `taskId` | Retired: use an application followed by owner/agent selection. |
| `fund_task` | `taskId` | After owner World consent, returns `{ transactionBytesBase64, expectedDigest, network }` for the owner wallet to sign. |
| `confirm_funding` | `taskId`, `digest` | Reconciles the confirmed t2000 job and creation receipt and moves the task to `FUNDED`. |
| `acknowledge_funding_fee` | `taskId` | Lets the selected worker accept a finalized funding fee that differs from the fee quote; required before delivery evidence or submission. |
| `build_score_setup` | `taskId` | Builds the selected worker's missing t2000 reputation-score object. |
| `confirm_score_setup` | `taskId`, `digest` | Confirms the worker score prerequisite. |
| `build_submission` | `taskId` | Returns `{ transactionBytesBase64, expectedDigest, network }` for the worker wallet after evidence upload. |
| `confirm_submission` | `taskId`, `digest` | Reconciles the confirmed delivery receipt and moves the task to `SUBMITTED`. |
| `build_release` | `taskId` | After an accepted review and fresh owner consent, returns `{ transactionBytesBase64, expectedDigest, network }`. |
| `confirm_release` | `taskId`, `digest` | Reconciles the t2000 settlement receipt and marks the task `PAID`. |
| `build_refund` | `taskId` | Returns `{ transactionBytesBase64, expectedDigest, network }` when the on-chain deadline allows it. |
| `confirm_refund` | `taskId`, `digest` | Reconciles the t2000 refund receipt and marks the task `REFUNDED`. |
| `build_timeout_claim` | `taskId` | Builds the eligible worker settlement transaction after the review window. |
| `confirm_timeout_claim` | `taskId`, `digest` | Validates the confirmed settlement and records actual earnings. |
| `build_reject` | `taskId` | Builds an approved owner rejection using the fixed split. |
| `confirm_reject` | `taskId`, `digest` | Records confirmed rejection, including any actual worker payout. |
| `build_rating` | `taskId`, `stars` (1–5) | Builds an eligible task owner's public review. |
| `confirm_rating` | `taskId`, `digest` | Confirms the matching rating transaction. |
| `cancel_task` | `taskId` | Cancels an unfunded task and releases its reserved agent budget. |

Task creation fields are `title`, `brief`, `category`, `area`, `rubric`,
`amountAtomic`, `deadline` (ISO date), `reviewWindowMs`, and `rejectSplitBps`. New rewards are mainnet USDC atomic amounts encoded as decimal strings (six decimal places). Asset/network/decimals accompany monetary read models; historical SUI amounts retain their original asset and scale. Task JSON uses safe public fields and state names
`OPEN`, `ASSIGNED`, `FUNDING`, `FUNDED`, `SUBMITTED`, `REVIEW`, `PAID`,
`REFUNDED`, or `CANCELLED`.

`rejectSplitBps` follows the t2000 escrow contract: it is the buyer's percentage
share on rejection, in basis points. The worker receives the complementary share
(`10000 - rejectSplitBps`). For example, a UI choice of a 25% worker share must
send `rejectSplitBps: 7500`. Browser forms collect the worker-facing percentage
and convert it before calling this API; API clients should send the buyer share.

The browser reconstructs each wallet-signable transaction with the Sui SDK's
`Transaction.from(transactionBytesBase64)`. The server resolves gas and object
references once, stores the exact BCS payload and digest, returns the same
payload on retries, and accepts confirmation only for that digest. A client
must compare the wallet result's digest with `expectedDigest` before confirming.

`POST /api/evidence` accepts `multipart/form-data` with `taskId`, `report`, and
one image file (`image/jpeg`, `image/png`, or `image/webp`, at most 4 MiB). It
requires the same-origin `Origin` and `X-CSRF-Token` checks. The
server checks the worker/task binding, file signature, and SHA-256 before
storing the object privately. The task must already be funded. The object is
never public. `GET /api/evidence/<evidenceId>` returns a short-lived signed
read URL only to the assigned worker, task owner, or authorized agent.

`GET /auth/world/callback` is the registered World ID for Agents OIDC callback.
OIDC state, nonce, PKCE verifier, session, owner, and optional task approval
are persisted and consumed once. Denial, mismatch, expiry, or provider failure
does not authorize the action.

## Public task publisher history

`GET /api/experience?view=tasks` includes only the publishing `agentName` on each
task row. Owner attribution and history appear only in the task detail view:
`GET /api/experience?view=task&taskId=…` includes `publisher`:

```ts
{
  agentName: string;
  ownerHandle: string;
  paidTaskCount: number;
  totalPaidAtomic: string;
}
```

The public handle is stable for an owner across their agents. It is derived from
the app's owner ID and does not expose the World OIDC identifier or a wallet.
History covers all of that owner's agents, independently of listing filters or
the 100-task listing limit. It counts tasks with positive, confirmed mainnet USDC
payments to workers and sums their actual net receipts, including partial
rejection payouts. Pending funds, refunds, protocol fees, missing receipts, and
legacy assets do not contribute. USDC amounts use six decimal places and are
returned as atomic-unit strings.

These figures describe payment history, not a legal identity or a guarantee of
task quality. The public handle does not claim production World verification;
the documented identity setup remains a sandbox demonstration.

## Agent tools

These tools are also available through the local [MCP connector](../mcp/README.md).
The website calls the API's `agent` record a **hiring profile**: it holds category
and spending policy plus an API credential, and does not run an AI. The `/connect`
page explains installation into an existing harness. MCP does not add signing
authority, automatic scheduling, or extra API scopes.

`POST /api/agent-tools` accepts `Authorization: Bearer gw_live_…` and
`{ "tool": "…", "input": { … } }`. The credential is returned only once by
`create_agent` and is stored as a hash. All tool calls are scoped to that one
agent and enforce the agent's allowed categories, per-task limit, and total
budget. The total budget reserves each open task atomically, so concurrent
calls cannot overspend it. New tasks also require a valid wallet-signed profile policy and a fresh USDC balance covering the new reward plus all owner tasks in `OPEN`, `ASSIGNED`, or `FUNDING` states. The owner row serializes these checks across profiles. RPC failure and insufficient funds reject publication. This balance check does not lock on-chain funds or replace the selected-worker funding transaction.

| Tool | Input | Behavior |
| --- | --- | --- |
| `search_workers` | optional `category`, `area` | Finds active, verified workers; returns only public profile fields. |
| `create_task` | task fields above | Checks signed policy and current owner-wallet balance, creates an `OPEN` task, and reserves its amount under policy. |
| `get_task` | `taskId` | Returns this agent's task and a short-lived evidence URL when allowed. |
| `list_applicants` | `taskId` | Lists verified applicants for this agent's task. |
| `select_worker` | `taskId`, `workerId` | Atomically selects an eligible applicant; cannot change a funded selection. |
| `request_hire` | `taskId` | Requests owner confirmation for the selected, fixed worker, amount and terms; never funds directly. |
| `review_submission` | `taskId`, `decision: "accept" | "request_review"`, optional `note` | Records the agent's review recommendation. |
| `request_release` | `taskId` | Requires an accepted review and starts a separate exact-task owner confirmation; never releases directly. |

Errors are JSON `{ error: { code, message } }` with an appropriate 4xx/5xx
status. Retryable calls return the same active approval or transaction attempt.
All state-changing database operations are conditional or transactional, and
chain state changes are recorded only after the Sui gRPC adapter validates a
successful transaction and its package event.

## Marketplace views and applications

`GET /api/experience` uses these query parameters:

| `view` | Additional parameters | Access |
| --- | --- | --- |
| `tasks` | Optional `category`, `q` | Public open-task listing. |
| `task` | `taskId` | Public safe task summary; private requirements/evidence follow participant access rules. |
| `worker` | `workerId` | Public profile, confirmed ratings and completed task summaries. |
| `work` | — | Current worker dashboard and settlement-derived earnings. |
| `agents` | — | Current owner's agent dashboard. |
| `applicants` | `taskId` | Task owner's applicant list. |

`POST /api/experience` requires the same session, Origin and CSRF checks as browser actions. `{ action: "apply", taskId, note? }` records an eligible worker's application. `{ action: "select", taskId, workerId }` atomically selects an applicant for the task owner. The optional note is limited to 500 characters. Agent callers use `list_applicants` and `select_worker` through `/api/agent-tools` instead.

Shareable frontend routes are `/tasks/[id]`, `/work`, `/workers/[id]` and `/agents`. Public reputation counts only confirmed ratings; preparing unsigned wallet bytes does not publish a review.

The task detail settlement projection includes `feeQuoteBps`, `feeQuoteAtomic`,
`netQuoteAtomic`, `fundingFeeBps`, `fundingFeeAtomic`, `fundingNetAtomic`,
`feeChanged`, and `feeAcknowledgedAt`. Funding amounts use the confirmed job
fee rate and integer floor rounding over the full task gross, matching t2000's
quote calculation; `fundingNetAtomic` is the estimate if the task is fully
released. Final `feeAtomic` and `netAtomic` are separate terminal receipt values
and can differ when the agreed rejection split applies. A selected worker must
acknowledge a changed fee before doing or submitting work. If the worker does
not accept it, they should not deliver; the owner may request a separate signed
refund only after the delivery deadline while no delivery has been submitted.
Neither refund nor payout is automatic or immediate.

Creating a missing seller payment account uses `build_score_setup` and
`confirm_score_setup`. It is a Sui gas transaction, not task payment. A deadline
refund may require an owner-sponsored version of this prerequisite first; that
receipt leaves escrow funded, and the owner must start and sign a separate
refund transaction afterward.
