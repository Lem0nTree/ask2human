# Agent-to-Human Marketplace — Product and Integration Specification

**Working name:** Groundwork  
**Version:** Hackathon MVP, 26 September 2026; minimal-code Sui route reviewed  
**Target:** ETHGlobal Tokyo 2026; World IDKit, World ID for Agents, and Sui DeFi & Payments  
**Status:** Product specification and implementation choices, not a deployed system

## 1. Product promise

An AI agent can commission a person to perform a small, verifiable real-world task, while the marketplace ensures that each worker account belongs to a unique human, a responsible human controls the agent's consequential spending, and task funds have a clear settlement path.

**Demo task:** “Visit this Tokyo electronics shop, confirm whether this specified component is in stock, report its displayed price, and upload a photo of the shelf label before 17:00.” The agent posts the request and reviews the response; a worker accepts it and supplies the evidence. The person funding the agent has a visible spending policy. The completed job pays out on Sui: on mainnet if reusing t2000's published escrow, or on testnet if deploying our own minimal escrow.

The promise has three separate kinds of trust:

| Question | Mechanism | What it does **not** prove |
| --- | --- | --- |
| Is this worker account backed by a unique human? | World IDKit Proof of Human; verified server-side and associated with one marketplace worker record. | Legal name, location, professional skill, or truthfulness of submitted evidence. |
| Is this agent allowed to commission this job at this price? | The marketplace's owner/agent policy; World ID for Agents provides a fresh authentication step for a protected action. | That an AI model is itself human, or that World authentication signs a blockchain transaction. |
| Has the buyer funded the job and what happened to the funds? | A Sui Move escrow, preferably t2000's deployed job contract for the fastest build, and wallet-signed transactions observed with the Sui SDK. | Whether a photograph depicts the actual shop or the work is satisfactory. |

**Positioning:** The customer is an agent operated by a person or organization. The supplier is a verified human worker. The product is a workflow for buying real-world observations and actions; cryptocurrency is the settlement rail, not the product's main reason to exist.

## 2. Boundaries and decisions

1. **Worker assurance:** Require IDKit Proof of Human when a worker activates an account and before accepting any paid task. Choose this credential because preventing duplicate worker accounts is a real marketplace need. Keep other credentials out of the required onboarding path; a document credential would add friction without proving that a stock check was performed. A fresh user-presence check is an optional future control for high-risk assignments.
2. **Owner assurance:** Link each agent account to a marketplace owner authenticated through the event's official World ID for Agents development environment. Require fresh authentication for a hire above the owner's approved budget or for a change to payout policy. The protected action is **committing funds to a named task at a stated amount**, not logging in.
3. **Money / least code:** Reuse [t2000's MIT-licensed Sui escrow and TypeScript job builders](https://docs.t2000.ai/agent-sdk) if a small real-USDC **mainnet** demonstration is acceptable. Its published mainnet contract already funds a named seller, records a deliverable, and settles or refunds. The published SDK addresses point to mainnet; a testnet option requires publishing/configuring a package and its supporting objects, or writing a minimal Move escrow. Sui Payment Kit handles payments and receipts but does not provide task-conditional escrow.
4. **World and Sui connection:** Verify World results on the service backend; authorize marketplace actions there; send only task/payment state and optionally a non-identifying task hash to Sui. No World proof, personal identity data, photo, or World nullifier is stored on Sui.
5. **Agent interface:** Expose a narrowly scoped agent tool interface (MCP is attractive because World demonstrated an MCP authentication challenge), plus a browser interface for owners and workers. The API is the source of authorization; an LLM's instructions are never the source of payment authority.
6. **Reality of the demo:** The event's World ID for Agents environment uses mock identities. Mainnet t2000 settlement uses real USDC and its current fee/limits; a testnet contract uses test funds. Label the demo chain and whether identity proofs are simulated. Product claims about Sybil resistance apply to a future production integration with real proofs, not to event sandbox identities.
7. **Market differentiation:** [t2000 already offers agents/humans, on-site jobs and photo proof](https://docs.t2000.ai/how-to/open-job). Our demonstrable new layer is World ID verified unique human workers, signed payout-wallet binding, and World ID for Agents authorization for task funding. Do not present generic agent hiring or on-site jobs as inventions of this MVP.

## 3. Actors and permissions

| Actor | Allowed actions | Required gate |
| --- | --- | --- |
| Agent owner | Register agent, set per-task and total spending limits, fund a Sui wallet or task, approve exceptional commitments, review disputes. | Authenticated marketplace session; World ID for Agents for protected actions; Sui wallet signature when moving funds from an owner-controlled wallet. |
| Purchasing agent | Search workers, draft and publish tasks, recommend matches, review evidence, request payout. | Agent-specific API credential with an owner binding and limited scopes; backend budget policy. |
| Human worker | Register, verify uniqueness, link payout wallet, accept eligible jobs, upload evidence. | IDKit verification and possession of the linked wallet (wallet-signed challenge). |
| Marketplace service | Validate proofs/tokens and policies, store task data, build permitted Sui transactions, record receipts, and coordinate evidence review. | Server-only secrets; task-level authorization; no assumption that the service can unilaterally settle t2000 jobs. |

The **owner** has World ID for Agents; the agent carries an application credential delegated by that owner. An agent does not receive “proof of humanity.” The worker's IDKit nullifier and the owner's pairwise OIDC subject are different identifiers and should not be treated as globally comparable identities.

## 4. User journeys

### A. Worker joins and accepts

1. The worker creates a marketplace profile with service category, area, availability, and a Sui wallet address on the selected network. Display a clear statement that Proof of Human verifies uniqueness, not name or skills.
2. The worker signs a short, expiring wallet challenge containing the marketplace domain, account ID, nonce, and wallet address. The backend verifies the signature and binds the payout address to this account.
3. The worker opens the IDKit widget with a **server-generated RP signature** and an action scoped to worker enrollment. Bind the proof to the marketplace worker account or wallet using the supported `signal` field.
4. The backend forwards the **full IDKit response** to the current World ID v4 verification endpoint, checks the expected environment and action/signal binding, and stores only the minimum account-scoped nullifier/verification result needed to stop duplicate worker enrollment. A second account using the same uniqueness identifier cannot activate as another worker.
5. Once verified, the worker can accept an available task in our application. The backend locks exactly one worker to the task record; the agent/owner then funds a **direct hire to that verified wallet**, fixing the recipient onchain. A cancelled, rejected, or unverified IDKit path leaves acceptance disabled. Do not use t2000's public first-claim board for this MVP: its native claim gate checks an Agent ID/reputation, not our World ID proof.

The v4 SDK supports `@worldcoin/idkit` for a React widget and `@worldcoin/idkit-core` for custom flows; server-side signing and verification are required. If repeat presence checks are later needed, use World ID's session approach or a separately designed fresh request; **do not** make the enrollment action a fresh proof for every task.

### B. Agent hires a worker

1. The owner registers an agent and a marketplace policy: allowed task categories, per-task maximum, total available balance, and circumstances requiring a fresh owner check.
2. The agent calls `create_task` with a concise brief, location area, required evidence, deadline, and maximum payout. The backend rejects prohibited or ambiguous requests and records a task ID.
3. When a verified worker accepts, the backend evaluates the **final** task ID, worker wallet, coin type, amount, and owner policy. For the MVP, return a World ID for Agents authentication challenge to the owner before the exceptional hire is committed. A later pre-funded allowance could let routine hires proceed within a delegated limit. Do not accept an agent-authored “approved” flag.
4. Show the owner the exact task, worker and amount for confirmation, then complete the event's official World ID for Agents OIDC flow. The backend verifies token signature and claims using the issuer's discovery/JWKS information, checks its expected issuer, audience, expiry, nonce/state, and the freshness required for that protected action, then matches the pairwise `(issuer, sub)` to the owner of this agent. Only an explicit confirmation for those details authorizes the hire.
5. A World authentication result **unlocks the application action only**. If funds are drawn from the owner's wallet, that owner must also sign the Sui funding transaction; World ID is not a substitute for that signature. The approved action must remain tied server-side to this task, amount, worker and expiration so it cannot be reused for another hire.
6. On cancellation, denial, token failure, timeout, changed amount, or changed worker, no funding/assignment operation occurs. Record the reason without exposing identity material to the agent.

The World workshop's MCP example uses this same pattern: an agent reaches a protected action, the service requests a human authentication step, and the agent retries after completion. In that example, the verified relationship persists for later bookings: **do not** imply the owner must repeat a full proof for every ordinary task. Our exceptional-hire confirmation is a product policy; request fresh authentication when its risk requires it. The event's official development environment is required for the World ID for Agents prize; the ordinary IDKit widget is **not** a substitute for it.

### C. Work and settlement

1. For the least-code path, the owner signs a **Sui mainnet USDC** direct-hire transaction built with t2000's `buildCreateJobTx`, funding a `Job<USDC>` with the verified worker's fixed wallet address, task-brief hash, deadlines and review terms. The service waits for a confirmed chain result and records its digest and job object ID. Do not substitute a testnet client or test token while retaining t2000's mainnet package IDs. A testnet-only demo instead deploys the minimal Move escrow described below.
2. The worker uploads a short report and evidence to private offchain storage. The service records an evidence hash and submission time. A photo or GPS tag is **evidence for review**, not cryptographic proof of physical presence.
3. The worker signs and submits the deliverable commitment through t2000's job transaction builder; offchain evidence remains in our storage. The agent checks it against the rubric and recommends `accept` or `request_review`; the owner signs the buyer-side settlement transaction after review. The SDK's current settlement builders include reputation-related inputs, so use the documented builder flow and complete its prerequisites. The escrow pays **the seller fixed at job creation**, never a new address supplied at payout time.
4. Use the existing job's deadline/refund and review-window behavior rather than inventing a second state machine. In t2000, a delivered job can release to the worker when the review window lapses, even without the buyer's later approval; the deadline can refund a job that never delivers. State these terms before funding. A contested submission goes into **our offchain review workflow**; t2000 does not provide general third-party arbitration and handles rejection using the split fixed at creation. The demo must not claim that the chain can decide whether physical work was done.

## 5. Payment contract and SDK integration

### Recommended route: connect existing escrow blocks

| Block | Reuse | Our thin integration |
| --- | --- | --- |
| Sui chain/wallet | `@mysten/sui`, `@mysten/dapp-kit-react`; Sui wallet signs each transaction | Configure **mainnet** for t2000's published job contract and check chain IDs before signing. |
| Task escrow | [t2000 `a2a_escrow` Move package](https://github.com/mission69b/t2000/tree/main/contracts/a2a_escrow), already deployed on mainnet | Direct hire to the World-verified worker's signed address; pin an offchain brief hash and record job ID. |
| Job calls | `@t2000/sdk`: `preflightCreateJob`, `buildCreateJobTx`, `buildDeliverJobTx`, `buildReleaseJobTx`, `buildRejectJobTx`, `buildRefundJobTx`, `getJob` | Wrap with our World/owner policy and a task-to-job mapping; keep wallet signatures with their actual actors. |
| Identity | World IDKit and official World ID for Agents integration | Confirm one human per worker record; bind the proof to the wallet; check the owner's consent for a specific task and amount. |

**Happy path:** IDKit verified worker + signed wallet → World-authorized agent hire → owner-signed `buildCreateJobTx` → worker-signed deliver transaction → owner-signed release transaction → observe Sui job state/digests. The World checks live in our backend. The existing t2000 contract does **not** enforce World proofs: a transaction sent outside our app can bypass our UI gates. A direct hire still guarantees that this particular funded job pays only its onchain named seller; our backend must check that this address was verified and consented before building/signing the job.

**Dependencies and limits:** Published [t2000 escrow addresses and SDK defaults](https://docs.t2000.ai/on-chain) are **mainnet**. It currently charges **5% of seller payout**, with limits and no general arbitration; verify its current onchain config and SDK release before the demo. The repo is MIT-licensed; attribute borrowed code if copied. Its original source is a **reference or existing third-party dependency**, not a ready-made testnet deployment. Settlement on newer contract versions may depend on t2000 agent score/reputation objects and the correct latest package ID; use its SDK's current builders and a full trial job before relying on it. Do not silently fork or strip its large contract during the hackathon.

### Testnet / independent-contract fallback

If the team requires only test funds, a standalone deployment, onchain World gating, or full control of timeout/dispute rules, write/deploy **one small Sui Move module**: a shared job object holding `Coin<T>`/`Balance<T>`, funder, fixed verified worker, brief hash, deadline and terminal state, with `create_and_fund`, worker `submit`, buyer `release`, and a narrowly defined `refund`. Use [t2000's contract and tests](https://github.com/mission69b/t2000/tree/main/contracts/a2a_escrow/tests) as design references, or study [Sui's official escrow sample](https://github.com/MystenLabs/sui/blob/main/examples/trading/contracts/escrow/sources/shared.move) for object handling. The official sample implements an **atomic swap**, not a ready-made paid-task contract; Payment Kit's immediate transfers are likewise not job escrow. Connect the module through `@mysten/sui` transaction `moveCall` builders and dApp Kit wallet signing; avoid rebuilding payment plumbing and reputation unless needed. If publishing the full t2000 package to testnet instead, budget time to provision its FeeConfig and reputation dependencies and configure package IDs and SDK token types.

In either route, save confirmed successful digests and reconcile job objects/events after retries; a locally built PTB is not proof of payment. Never log World proofs, identity material or private evidence onchain.

## 6. Minimum data model and API

| Record | Essential fields | Storage |
| --- | --- | --- |
| `owners` | marketplace ID, World Agents `(issuer, sub)`, policy, linked Sui address | Backend |
| `agents` | agent ID, owner ID, scopes, current spend, API credential reference | Backend |
| `workers` | worker ID, IDKit verification status, deduplication nullifier, signed payout address, skills claimed | Backend; no sensitive proof payload onchain |
| `tasks` | task ID, owner/agent, brief, area, price, deadline, evidence rubric, assignee, state | Backend; hash and settlement state on Sui |
| `approvals` | task ID, exact approved amount/worker, OIDC issuer/subject, freshness, expiry, consumed flag | Backend |
| `settlements` | task ID, `mainnet:t2000` or own `testnet` rail, package/job IDs, funding/delivery/release/refund digests, reconciled status | Backend and Sui |

**Agent tools:** `search_workers`, `create_task`, `get_task`, `request_hire`, `review_submission`, `request_release`. `request_hire` and `request_release` are **requests** to the policy service, not raw signing tools; neither accepts an arbitrary payout destination.  
**Worker endpoints:** `start_verification`, `complete_verification`, `link_wallet`, `accept_task`, `submit_evidence`, `get_payout`.  
**Owner screens:** spending policy, pending step-up challenge, funding transaction, approval decision, dispute review, settlement history.

**Task state machine:** Offchain `DRAFT → OPEN → ASSIGNED → FUNDED → SUBMITTED → PAID/REFUNDED`; blocked/expired actions become `CANCELLED`, and disagreements enter an offchain `REVIEW` state. Map each step to the selected contract's actual states and timeout/rejection rules; do not imply t2000's contract implements our own `APPROVED` or `DISPUTED` states. A task can have **one** terminal settlement. The chosen worker must be fixed before onchain funding.

## 7. Hackathon acceptance and demo

**One happy path:** agent proposes a concrete local observation → worker proves uniqueness with IDKit, signs their Sui address and accepts → owner confirms this worker and amount through World ID for Agents → owner signs the chosen Sui escrow funding transaction → worker submits a report and signs deliver → buyer signs release → Sui pays the fixed worker. Show the actual chain, both successful World validations, and onchain transaction/object references.

**Two failure paths:** (1) worker cancels or fails IDKit, so task acceptance never occurs; (2) owner denies or lets the Agents challenge expire, so the agent cannot fund the hire. Also demonstrate that a changed amount or different payout wallet invalidates the approved action. If time permits, show escrow refund after expiry.

**World prize materials:** for each World integration, report time to first success, friction encountered, a missing capability/documentation point, and the one suggested improvement. Show backend validation and a meaningful blocked flow. **Sui prize materials:** demonstrate a working programmable money movement on Sui, not just a static wallet UI. Reusing another marketplace's deployed contract may make our independent payments contribution less compelling than a small adapted Move module; explain our original verified-human/agent-authorization work clearly. Record incremental git commits and make the demo self-contained. ETHGlobal's deadline is **27 September 2026, 09:00 JST** and it allows up to three partner selections; both World tracks share one partner selection.

### Workshop fit check

- **World recording:** IDKit gives applications a choice of human credentials; Proof of Human is the proportional choice for one-account-per-worker. Its World ID for Agents demonstration is a Codex-to-MCP restaurant booking: the server blocks the booking, challenges the agent's human, receives a private stable identifier after verification, and allows the booking; subsequent bookings can reuse that identity. Our protected commitment of funds is a stronger marketplace-specific trust moment, provided the owner actually confirms the task and the backend blocks a failed challenge. The workshop warns that sandbox identities are fake.
- **Sui recording:** It teaches a *development process*—research, plan, implement, and consult Sui's official Docs MCP to avoid outdated API assumptions. Its mention of Sui Kiosk concerns digital asset marketplaces; it is **not** a prerequisite or a good reason to tokenize human jobs. The reason this product fits Sui is the separately published **DeFi & Payments** prize: task escrow and release/refund are a programmable payment flow on Sui. Consult current SDK docs; demonstrate transactions on the actual selected network.

### Build order under the event deadline

1. Decide mainnet t2000 reuse versus testnet Move deployment; run one complete fund → deliver → release trial on that network before building more UI.
2. IDKit backend verification and duplicate worker rejection.
3. Official World ID for Agents OIDC step-up bound to the exact hire action; denied/expired case.
4. Integrate wallet binding and direct-hire job builders; show rejection/refund semantics and record a short demo.

Do not claim that a simple transfer satisfies an escrow requirement; if the escrow is incomplete at submission, describe the actual payment behavior accurately. If step-up integration is incomplete, submit to the IDKit track only rather than implying both World tracks were met. If relying only on a third-party Sui protocol, make our original technical work and the payment integration legible to judges.

## 8. Explicit exclusions and open product choices

- **Not legal KYC:** Proof of Human establishes uniqueness at the credential's assurance level, not legal identity. Passport/Identity Check should only be added for a task category that truly requires it; Identity Check currently has preview restrictions.
- **Not proof of work:** Deliverable quality is assessed by buyer/reviewer; photos and geolocation may be falsified.
- **Mainnet is a deliberate opt-in:** The lowest-code t2000 route settles real USDC on mainnet, even though World ID for Agents uses sandbox identities. If that is unacceptable for the demo, use the testnet fallback; do not describe t2000 mainnet transactions as testnet simulations. A later production launch needs a fresh security review of operator keys, owner-to-agent delegation, disputes, wallet recovery, country-specific payment obligations, and location/task safety.
- **No automatic agent custody by default:** A World authentication result is neither wallet delegation nor a transaction signature. The MVP funds from an owner's signed wallet transaction; fully autonomous pre-funded budgets need a separate capped and revocable onchain design.
- **Choice before implementation:** The t2000 path uses its specified mainnet USDC type and currently deployed addresses. The testnet fallback can use testnet SUI for a small independent contract or an explicitly verified testnet coin type. Freeze the full coin type, decimals, network, package ID, and wallet network in demo fixtures.

## 9. Primary sources checked

1. [ETHGlobal Tokyo 2026 prize definitions](https://ethglobal.com/events/tokyo2026/prizes) and [submission rules](https://ethglobal.com/events/tokyo2026/info/details).
2. [World IDKit integration and server verification](https://docs.world.org/world-id/idkit/integrate); [credential choice and user presence](https://docs.world.org/world-id/idkit/credentials).
3. [World ID for Agents / Human Continuity sandbox documentation](https://sandbox.auth.world.org/docs); [official event plugin](https://github.com/worldcoin/world-id-agent-plugin); [World workshop recording](https://www.youtube.com/watch?v=MElIfoDffuw). The workshop transcript describes the MCP step-up demonstration; the sandbox documentation describes OIDC pairwise subjects and fresh authentication.
4. [Sui TypeScript SDK and React dApp Kit](https://sdk.mystenlabs.com/dapp-kit/getting-started/react); [building Move calls in PTBs](https://docs.sui.io/develop/transactions/ptbs/building-ptb); [wallet signing and execution](https://sdk.mystenlabs.com/dapp-kit/actions/sign-and-execute-transaction); [Payment Kit semantics](https://docs.sui.io/onchain-finance/payment-kit).
5. [t2000 open source repository (MIT)](https://github.com/mission69b/t2000), [escrow Move source](https://github.com/mission69b/t2000/tree/main/contracts/a2a_escrow), [SDK job builders](https://docs.t2000.ai/agent-sdk), [published mainnet addresses](https://docs.t2000.ai/on-chain), [fees and limits](https://docs.t2000.ai/fees-and-limits), and [on-site jobs/claim rules](https://docs.t2000.ai/how-to/open-job).
6. [Sui official shared object escrow example](https://github.com/MystenLabs/sui/blob/main/examples/trading/contracts/escrow/sources/shared.move) (object swap, not job payment) and [Sui DeFi & Payments qualification requirements](https://ethglobal.com/events/tokyo2026/prizes).

**Source boundary:** World and Sui document their SDKs and primitives. t2000 already supplies a marketplace, on-site tasks, SDK, and a deployed Sui escrow; our new product layer is World-verified human worker onboarding and agent-owner authorization attached to direct hires. A custom testnet escrow remains a **fallback design**, not a deployed feature of this project. Verify current sandbox portal details, contract IDs and fees during registration/build because integrations may change.
