# Ask2Human — submission draft

This is prepared submission copy, not a submitted entry. The user authorized GitHub publication; attach the final recording and arrange judge access before submitting.

## Links

- Public application: https://ask2human.me
- Completed demonstration task: https://ask2human.me/tasks/35dc7c07-3a92-4374-be37-d404aedbfbe7
- Demonstration worker and confirmed review: https://ask2human.me/workers/a17b1a5f-f5b7-4b74-884f-87bdbbadd2f4
- Repository: https://github.com/Lem0nTree/ask2human — currently private; judges need access or a separately authorized visibility change.
- Demo recording: pending.

## Short description

Ask2Human lets an agent commission a small task, choose a verified worker and review private evidence. The human owner authorizes the exact worker and payment terms through World ID for Agents, then signs an escrow transaction. The worker delivers evidence and receives USDC directly on Sui; earnings and confirmed customer ratings remain visible in the marketplace.

## What we built

The scoped agent API posts tasks, lists applicants, selects a worker and requests owner approval. Separate owner and worker sessions enforce identity and wallet binding. The task page exposes the agreed deadline, review window, rejection split and protocol fee. Image/report evidence is private to authorized participants. Frozen transactions and receipt reconciliation support safe confirmation retries. Worker dashboards show confirmed net earnings; public profiles show completed work and confirmed reviews.

The demo runs on Vercel with Neon PostgreSQL and private S3 storage. The agent example is `scripts/agent-example.ts` and the API is documented in `docs/API.md`.

## Integration and reuse

- World IDKit v4 verifies worker proofs server-side. World ID for Agents supplies fresh owner authentication for exact task approvals. These are separate identity flows.
- Mysten dApp Kit, Wallet Standard and Slush provide wallet integration. Actual Slush OAuth/signing remains an acceptance gate; controlled test transactions were signed locally using dedicated demo wallets.
- The pinned t2000 SDK and its existing Sui mainnet escrow/reputation contracts handle USDC jobs and public reviews. We did not publish a new escrow contract for this MVP.
- Next.js/React, PostgreSQL and AWS SDK provide application, database and private evidence plumbing.
- bnbera is the author's earlier personal UI source donor, not a continuing product. Adapted files and revisions are recorded in `docs/FRONTEND_SOURCES.md`.
- Implementation used AI assistance: Luna Max for bounded implementation, Sol for independent checks, and the primary Codex thread for orchestration, integration and blocker resolution.

## Demonstrated result and limits

An API-posted task completed verified worker application and selection, fresh owner funding approval, mainnet funding, private evidence upload/delivery, separate release approval, payment and a confirmed five-star rating. Independent checks matched 0.02 USDC gross, 0.001 fee and 0.019 worker net, zero pending balance, and owner spending of 0.02 USDC. Refund, timeout claim and the agreed rejection split also passed independent mainnet receipt, balance and application-accounting checks. Repeated confirmations did not broadcast another transaction. The [proof table](PROOF_OF_TESTING.md) links every trial receipt and identifies unverified browser-wallet behavior.

The money is real mainnet USDC; identity is an explicitly labelled World staging/sandbox demonstration, not production Proof of Human. Identity verification does not establish location, skill or evidence truthfulness. Human review is not an evidence oracle or arbitration service. Protocol reuse does not establish independently verified audit coverage of the deployed revision. Dependency audit findings and pending browser-wallet acceptance are recorded in `docs/PLATFORM_REPORT.md` and `docs/DEVELOPMENT_CHECKLIST.md`.

## Before submission

- [x] Public application, completed task and confirmed review available.
- [x] Real payment and dashboard accounting independently checked.
- [x] Source reuse and AI assistance described.
- [ ] Finish remaining acceptance checks and state their exact limits.
- [ ] Record the actual browser demonstration, without secrets or invented signing footage.
- [x] User authorized publication of the reviewed code to the existing GitHub repository; repository access is confirmed.
- [ ] Attach recording/repository and submit under explicit user authorization.
