# Ask2Human: revised 23-hour MVP plan

Revised 26 September 2026. This supersedes the earlier recommendation to continue custom testnet escrow. This is an implementation plan, not a claim that the new features or mainnet integration are finished.

## Decision and delivery target

Use the existing **t2000 mainnet USDC escrow**, accessed through its SDK. Freeze development and publication of our custom Move escrow. Retain the working Next.js application, World identity/consent, scoped agent API, PostgreSQL lifecycle/budgets, private S3 evidence and transaction recovery patterns. Treat bnbera solely as a personal UI source donor; keep normal source attribution.

Testnet itself does not require writing a contract. The previous choice of a custom contract created that work. Returning to the original specification's t2000 route better matches the requested reuse strategy, provided the integration passes the early compatibility gate below.

The delivery target is:

> Agent posts a task → verified human applies → agent chooses an applicant → owner approves exact terms and funds escrow → human delivers evidence → owner accepts and releases payment → human sees net earnings → owner leaves a public rating.

Deliver that journey on a public HTTPS URL with a real agent API example and separate owner/worker browser sessions. Also demonstrate one refund and meaningful authorization failures. Do not spend this window implementing the entire original specification.

Label identity environments truthfully: a successful event sandbox/mock identity flow is not production Proof of Human. Keep the funded demonstration to controlled low-value tasks; distinguish real mainnet money from simulated identity assurance in the UI and demo.

## Reuse and payment boundaries

Use SDK transaction builders rather than copying or forking the Move contracts. Pin the SDK version and record the deployed package/shared-object IDs. The SDK documents creation, delivery, release, rejection, refund, job reads and reputation builders. [SDK reference](https://docs.t2000.ai/agent-sdk).

Use **direct hire of the locally selected worker**. Keep posting and applications inside Ask2Human; adopting t2000's public first-claim job board would change our selection and World verification flow. Keep private briefs/evidence in our database/S3; send their commitments through the raw builders.

Important integration work remains:

- Replace SUI/MIST amounts with explicit USDC atomic amounts, asset, decimals and network. USDC uses six decimal places; never reinterpret existing nine-decimal SUI values. Use integer strings internally, validate conversions at the SDK boundary, and separate any historical testnet records/budgets.
- Freeze seller, amount, specification hash, delivery deadline, review window and rejection split in the owner approval and signed transaction. Changing them invalidates approval. Before funding, quote gross, fee and expected net from the current protocol fee configuration and record the quote with consent. After funding, verify the job's actual snapshotted fee and disclose any difference before work starts. Do not guarantee an exact future net unless the transaction can enforce the fee bound; fee changes require renewed acknowledgement and a supported exit path if the worker declines.
- Use the SDK's current state/action helpers, then independently validate chain package, asset, parties, amount, terms and hashes server-side. Replace our custom contract's receipt decoder; browser success is insufficient.
- Check whether the selected seller needs an empty reputation score object before delivery/settlement. The current SDK has a builder for that prerequisite; prove the fresh-wallet path rather than assuming a previously registered seller.
- Respect t2000's review-window semantics. Buyer acceptance can release payment early; after the review window, a release transaction can be submitted by an eligible caller. Elapsed time alone does not execute a transaction. Provide a worker claim/refresh action and avoid implying automatic background payout.
- Show the agreed rejection split. A rejected delivery can produce a partial seller payment, so accounting must use actual net receipts rather than treating every rejection as zero earnings. Do not present our existing “request review” action as an on-chain rejection or promise unlimited revisions.
- Keep funding signatures in the owner's wallet and delivery signatures in the worker's wallet. The agent requests/selects/reviews through scoped APIs; it does not receive private keys. Fresh owner consent protects owner-initiated payment actions; it cannot override the deployed contract's timeout permissions.

Terms lock at funding; t2000 describes review-window settlement, rejection splits and overdue undelivered refunds in its [hire guide](https://docs.t2000.ai/how-to/hire). The current SDK implementation is the additional integration reference: [job builders](https://github.com/mission69b/t2000/blob/main/packages/sdk/src/wallet/job.ts), [reputation builders](https://github.com/mission69b/t2000/blob/main/packages/sdk/src/wallet/reputation.ts).

**Audit qualification:** t2000's security policy reports a March 2026 automated full-stack review and says to contact maintainers for the report. We have not verified independent audit coverage of the currently deployed escrow revision. Reuse removes our contract implementation/publication work; it is not evidence of an independent audit. [Security policy](https://github.com/mission69b/t2000/blob/main/SECURITY.md).

## Product surfaces and acceptance

Explicit wallet requirement: integrate Slush web wallet through the existing dApp Kit, retain Wallet Standard extension/mobile support, and support personal-message wallet binding plus task transaction signing. Add mobile Slush entry and cancellation/reconnect handling. Follow [official Slush integration documentation](https://sdk.mystenlabs.com/slush-wallet/dapp); no custom key custody in the browser.

| Surface | Minimum useful behavior | Reuse / addition |
| --- | --- | --- |
| Marketplace | Browse open tasks; show category, area, deadline, reward and status; open a shareable detail URL. | Reuse existing cards/filtering and styling. |
| `/tasks/[id]` | Brief, acceptance checklist, deadline, public area, gross reward/fee/net, assigned worker, escrow status, timeline and one clear next action for the current role. Public visitors never receive private evidence. | Extract current task-detail component into a route; extend its state presentation. |
| Task delivery | Selected worker sees “Start after funding”; enters report, uploads image, previews evidence, then submits. Show uploading/signing/confirming/submitted states and recover an interrupted confirmation. | Reuse current evidence form, S3 access controls and hash commitment; replace payment adapter. |
| `/work` | Applications, selected/funded tasks, submitted tasks and completed work; total net earnings, this month's net earnings and pending escrow separately; per-payment receipts. | New small dashboard backed by SQL aggregate/history queries. Never compute lifetime totals from the capped task feed or wallet balance. |
| `/workers/[id]` | Public name, World verification, skills/area, average rating and review count, recent completed public task summaries. New workers show “No reviews yet.” | New safe public read model; reuse t2000 reputation where possible. Exclude private reports, images and precise location. |
| `/agents` | Create task, view applicants, inspect worker profile/history, choose worker, request owner approval, review delivery and track spend/payment. | Reuse existing task/agent forms and tools; add applicant selection. |
| Agent API/example | Script authenticates, posts a task, lists applicants, selects one, tracks delivery and requests settlement. Tool responses expose status and next permitted action. | Extend existing scoped tools; no new agent framework or MCP transport this week. |

### Application and selection flow

Add `task_applications` with unique task/worker membership and a short optional application note. Applying records willingness to do the task; it does not assign or fund it. Replace first-accept-wins with:

1. A World-verified, wallet-linked worker applies to an open task.
2. The owning agent/owner lists applicants and opens their public profiles.
3. An atomic selection operation validates ownership, policy, task deadline and eligibility, then selects one applicant and closes the other applications.
4. Exact owner approval binds that worker and the fixed payment terms. Selection cannot change under an issued funding attempt or funded escrow.
5. Unfunded cancellation releases reservations only after any outstanding chain attempt is resolved.

Use the same backend service for the browser and agent tools. No bidding, negotiation, direct invitations or messaging system is needed for this MVP.

### Earnings and public ratings

Store confirmed settlement facts once, keyed by network/job/transaction. Capture timestamp, asset, gross, fee and actual seller net. Derive earnings from these rows, including any partial rejected-job payout. Track pending escrow separately; there is no platform withdrawal flow when funds go directly to the worker's wallet.

First choice for ratings is t2000's existing buyer-signed on-chain review flow. Provide a 1–5-star action after an eligible delivered settlement; reuse its score/read builders. Handle a missing score and delayed indexer updates explicitly. Label external aggregate ratings as t2000 reputation; show Ask2Human recent completed tasks separately. A World badge establishes a different fact from a customer rating. The buyer's delivery review decision is not itself a public star rating. [Reviews and reputation](https://docs.t2000.ai/how-to/reviews-and-reputation).

If reputation writes are the sole upstream blocker at the early gate, use a minimal local verified-job rating table (unique task/reviewer, settled task only, server-authorized owner), clearly labelled Ask2Human reviews. Do not mix aggregates or invent demo reviews. Prefer dropping optional review text before adding moderation scope.

## Hosting choice and immediate setup

**Vercel + Neon PostgreSQL** is the fastest fit for the current Next.js/PostgreSQL stack. Keep S3 for evidence and the current PostgreSQL client; do not add an ORM, Supabase auth, a replacement storage layer or an AWS container deployment during this window.

Create a Vercel project and attach Neon through the Vercel Marketplace, choosing nearby application/database regions. Vercel now provisions external Postgres providers through Marketplace integrations; the old standalone Vercel Postgres product is no longer offered. [Vercel documentation](https://vercel.com/docs/postgres).

Implementation setup:

- Configure the pooled PostgreSQL connection privately for runtime; use the appropriate migration connection separately. Check pool limits and deployed transaction behavior with the current driver.
- Run schema migration once as a controlled deployment step, not on every function invocation. Isolate test data from the public demo database.
- Configure the stable HTTPS application origin, secure cookies, World redirect URI and allowed origins together. The current raw Tailscale preview's form-origin mismatch is a real blocker; do not disable CSRF to bypass it.
- Prefer `https://ask2human.me` if DNS can be connected promptly. Otherwise register the stable Vercel production hostname with World; do not rely on changing preview URLs for authentication.
- Keep evidence uploads within host limits. Probe the existing image upload through Vercel early; if multipart requests exceed its limit, adapt to direct signed S3 upload with server-side size/type/hash verification before submission.
- Put secrets only in private local configuration/provider settings. No credentials or private wallet keys in chat, browser bundles or Git.

User preparation: Vercel account/project, attached Neon database, access to World app configuration and two separate demo signing wallets. The owner needs **USDC for tasks plus SUI for gas**; the worker also needs a working gas path. A SUI-only wallet is not enough. Agree a small total mainnet spending cap before paid trials, estimate gas and use low-value controlled tasks. Most UI/error testing remains local or simulated; mainnet is for bounded integration evidence.

## Execution schedule and gates

The previously verified submission deadline is **27 September 2026 at 00:00 UTC / 09:00 JST**. Target **26 September at 22:00 UTC / 27 September at 07:00 JST**. Treat the following as remaining-time windows and shorten feature work if starting later; preserve the final submission buffer. [Official event details](https://ethglobal.com/events/tokyo2026/info/details).

| Hours | Parallel work | Exit condition |
| --- | --- | --- |
| 0–2 | Payment compatibility spike; provision/deploy Vercel+Neon; agree amount/state/API contracts; extract task-page UI. | Pinned SDK builds with current Sui client/browser wallet; fresh seller score path identified; mainnet job reads/preflight work; public HTTPS and DB reachable. No new Move code. |
| 2–5 | Prove bounded create → deliver → release and review, start a short supported refund trial; complete public World success/failure checks. UI worker adds applications/selection against agreed backend contract. | First real payment receipt and net accounting verified; both identities work on public origin; unpaid/unauthorized task actions rejected. |
| 5–10 | Complete canonical task page, applicant selection, evidence preview/submission, confirmation recovery and agent script. | One complete API-posted task runs through separate owner/worker browser sessions to payment. |
| 10–14 | Worker dashboard/earnings and public profile/recent tasks/ratings; mobile states and helpful empty/error states. | All requested core surfaces use real persisted records and confirmed receipts; totals match payment history. |
| 14–18 | Independent Sol acceptance on deployment; repair scoped defects. Re-run fresh-session happy path, refund, timeout claim and interrupted-confirmation cases. | Two successful end-to-end runs; unauthorized selection/release, duplicate payment and evidence leakage checks pass. |
| 18–21 | Feature freeze, stable deployment, demo recording, README/reuse notes and submission. | Working public URL, runnable agent example, recorded real receipts and submitted project. |
| 21–23 | Reserved buffer. | Submission confirmed before deadline; resolve only launch blockers. |

**Stop rules:** At hour 2, report any SDK/wallet/score prerequisite incompatibility with concrete evidence. At hour 5, if no successful paid task exists, concentrate both implementation lanes on that blocker and cut visual polish, extra filters, review text and charts. Do not respond by starting another escrow contract. If the upstream cannot support the required flow, expose the limitation and make an explicit scope decision. Refund/timeout trials should begin early enough to finish without waiting at the deadline.

## Work packages and orchestration

The main thread owns interfaces, scope, hosting/access blockers and integration. Use two non-overlapping Luna Max implementation packages, then Sol checking; no extra manager layer.

- **Luna A — settlement integration:** t2000 adapter, amount/terms contract, receipt validation/recovery, score/review prerequisite, payment-focused scripts/tests. Reuse upstream builders; do not edit the custom Move package. Own payment modules and payment migrations only.
- **Luna B — marketplace experience:** application/selection service and dedicated migration, safe earnings/profile read models, task/detail/delivery/dashboard/profile UI, agent example. Consume the agreed settlement DTO; do not change chain decoding or shared monetary types independently.
- **Main:** publish shared interface/ownership decisions before parallel writes; serialize edits to shared action dispatch, schema/types/config and integration wiring. Set up deployment and resolve external blockers within existing authorization.
- **Sol checker:** read-only independent review at the early payment gate and final assembled-flow gate. Return focused reproductions to the responsible Luna worker; recheck repair deltas. Verify especially caller/recipient/asset binding, atomic selection, accounting, privacy and retries.

Existing threads can be reused. Review SDK compatibility before allocating work around an assumed upstream interface. This plan itself does not launch implementation workers or authorize Git publication/mainnet transfers.

## Definition of done

Updated after independent deployed acceptance on 26 September. World checks use sandbox/staging identity; chain transactions used the controlled local signing harness. Actual Slush browser signing remains a separate unchecked item. See `ACCEPTANCE.md` for observed limits.

- [x] Public HTTPS app works independently of Tailscale and the development machine.
- [x] Successful server-validated World owner and worker journeys plus meaningful failure paths.
- [x] Agent API creates task, lists applicants and selects one; another agent cannot interfere.
- [x] Detail page communicates exact requirements, escrow terms, payment status and next action.
- [x] Only selected worker submits private evidence; owner can inspect it; public visitors cannot.
- [x] Owner funds and releases via existing t2000 mainnet escrow; worker receives confirmed USDC.
- [x] Refund, elapsed-review-window claim and agreed rejection split independently verified on mainnet; transaction proof is recorded in [PROOF_OF_TESTING.md](PROOF_OF_TESTING.md).
- [ ] Wallet cancellation, refresh/reconnect and lost confirmation do not duplicate transactions or lose task state.
- [x] Earnings match confirmed seller net receipts; pending funds are not counted as earned.
- [x] Public profile shows authentic ratings and recent completed tasks, with clear source and no private evidence.
- [ ] All core surfaces function on mobile and have honest empty/error/loading states.
- [ ] Sol acceptance, build/type checks and relevant integration tests pass; mainnet limitations are documented.
- [ ] Submission includes accessible app/repository links, short demo and source/AI attribution; publication occurs under explicit authorization.

Defer: chat, bidding, notifications, maps/geocoding, advanced charts, multiple currencies, arbitration, automatic agent selection, broad policy editing, subscription billing, withdrawal system, custom smart contracts and a new visual redesign. Keep the requested task/delivery/payment/earnings/profile/agent flows in scope.
