# Ask2Human implementation checklist

Started 26 September 2026, 02:16 UTC. Implements [the revised MVP plan](HACKATHON_COMPLETION_PLAN.md). A checked item means its stated evidence exists; implementation and live acceptance are tracked separately.

## Infrastructure

- [x] User created Neon in Singapore with Neon Auth disabled.
- [x] Server connected successfully to the new Neon database (PostgreSQL 18; no existing public tables).
- [x] User created Vercel `ask2human`, connected Neon and GitHub.
- [x] Vercel CLI authenticated successfully on this server.
- [x] Local `.env` permissions are 0600; required database/wallet configuration names are present. Secret values not printed.
- [x] Align local Sui runtime with mainnet; Vercel already uses mainnet. Local database remains local.
- [x] Link local checkout and inspect Vercel configuration.
- [x] Deploy existing schema migrations 001/002 to Neon (13 public tables).
- [x] Apply and verify integration migrations 003/004 and corrective migration 005 locally and on Neon, including frozen release fields, payment readiness/fee fields and task applications.
- [x] Configure private server environment using an explicit key allowlist; wallet private keys excluded.
- [x] Configure explicit application Neon URL; runtime prefers it over managed integration variables.
- [x] Configure Singapore application region (`sin1`) and attach canonical domain.
- [x] Add Cloudflare DNS-only apex record using the target supplied by Vercel.
- [x] Verify canonical domain HTTPS after production deployment: https://ask2human.me.
- [x] Public deployment passes anonymous sessions, cookie persistence, form-origin/CSRF and unauthorized evidence-upload checks. Authenticated upload and exact-byte participant retrieval also passed; anonymous retrieval is denied.

## Payment integration — Luna implementation, Sol checking

- [x] Pin compatible t2000 SDK and reuse current mainnet job/reputation builders.
- [x] Migrate monetary fields to explicit atomic units/assets without reinterpreting legacy SUI balances.
- [x] Implement exact task/terms/worker approval binding and frozen transaction recovery.
- [x] Implement funding, delivery, release, refund, rejection and elapsed-window claim; live path coverage is recorded separately below.
- [x] Handle new seller reputation-score prerequisite, including separate owner-sponsored refund preparation.
- [x] Record actual gross/fee/net settlement facts and chain delivery timestamps.
- [x] Validate package, asset, parties, hashes, terms, digest and terminal state server-side.
- [x] Independently check payment implementation and focused tests; Sol cleared the repaired code and bounded trial.
- [x] Run bounded mainnet funding → delivery → release trial and record public receipts; Sol independently verified 0.02 USDC gross, 0.001 fee and 0.019 worker net. See `ACCEPTANCE.md`.
- [x] Run refund and timeout/rejection checks where supported; record actual results separately in [proof of testing](PROOF_OF_TESTING.md).
- [x] Public rating transaction and onchain score independently verified: one review, five total stars, 5.0 average; public profile matches.

Mainnet trial policy: use supplied demo wallets only, <=0.10 USDC aggregate new task funding and <=0.08 SUI aggregate gas/worker gas funding, explicitly increased by the user on 26 September after the paid/rating trial (original limit was 0.05 SUI). Estimate before signing, stop if bounds cannot be enforced or any unexpected behavior occurs. No automatic swaps, unlimited approvals, or new contract publication. User deposited funds for development/testing; wallet secrets remain local and are never part of Vercel environment or output.

## Marketplace experience — Luna implementation

- [x] Slush web wallet and Wallet Standard connection integrated on mainnet; provider wiring checked against installed SDK and official docs. Public Chromium modal and mobile Slush return link passed; actual OAuth/signing remains below.
- [ ] Slush wallet binding, transaction signing, rejection/cancellation and reconnect behavior checked.
- [x] Implement shareable task page with requirements, terms, timeline and role-specific actions.
- [x] Independent public/participant task-page checks passed; repaired mobile status and fee text layout, exact terms and role actions verified.
- [x] Implement verified worker applications, atomic agent/owner selection and scoped API tools; local database checks pass.
- [x] Implement delivery preview, upload, signing/confirmation states and retry recovery; local regressions and independent code review pass. Live wallet flow remains below.
- [x] Implement worker dashboard with total/monthly net earnings, pending amounts and receipts; isolated database accounting checks pass.
- [x] Implement public worker profile, confirmed-only ratings and recent completed tasks; private evidence excluded in database checks.
- [x] Implement agent dashboard and runnable API example for posting/selecting/reviewing; deployed API workflow remains below.
- [ ] Mobile, empty, loading and failure states checked.
- [x] Local isolated PostgreSQL checks pass for evidence privacy, unauthorized selection, selection race, earnings, chain delivery timing and confirmed-only ratings; deployed acceptance remains separate.

## Public acceptance and submission

- [x] Repair v4 decimal proof parsing and add server-only test-window token support; independent review and 11 identity tests pass.
- [x] Prepare and independently review World setup helper, including app/RP validation before changing the test window.
- [x] Open authorized World staging window using dedicated team API key; expires 27 September 03:22 UTC. Token configured privately in Vercel.
- [x] Successful server-validated World worker verification using genuine staging proof; deployed session completion tracked below.
- [x] Independent real World sandbox owner login and fresh protected-approval adapter exchanges.
- [x] Successful deployed owner OIDC session callback, separate verified worker session, and fresh task-bound HIRE and RELEASE database approvals.
- [ ] Complete authorization failure acceptance: deployed injected denial, replay, missing-session and actual expired approval checks pass; actual provider cancellation remains unchecked.
- [x] Complete API-posted task through separate deployed owner/worker sessions to payment/rating, with controlled local wallet signing. Browser Slush signing remains a separate gate.
- [x] Independent Sol deployed core payment/rating, accounting, privacy and mobile acceptance passed; refund and Slush-specific acceptance remain separate.
- [x] Final assembled build (including TypeScript) passed on Vercel; latest regression suite has 44 passes and one deliberately skipped live S3 smoke, with local disposable PostgreSQL schemas only.
- [x] README/API/deployment/source documentation and original-spec platform report reflect the actual integration and distinguish remaining acceptance limits.
- [x] Prepare rehearsal/recording sequence in `docs/DEMO.md`.
- [ ] Record successful demo and finish submission materials; publication/submission authorization tracked separately.

## Update log

- 02:16–02:23 UTC: implementation packages dispatched to Luna; Neon connectivity and Vercel authentication verified. User requested Telegram milestone/blocker updates using the delivery skill. No mainnet transactions sent yet.

- 02:24 UTC: base Neon schema applied, DNS verified by Vercel, production server environment configured. Both wallet key/address pairs match; owner balances checked, worker gas balance is zero. Slush added to plan/checklist and assigned to frontend package. Telegram milestones delivered (messages 6/7).

- World sandbox authorization handoff succeeded in Chromium. Corrected token exchange to the registered `client_secret_basic` method; seven focused identity tests pass. Independent live exchange recheck remains pending.

- Independent Sol check: both real sandbox `owner_login` and `protected_approval` exchanges pass with the same verified identity and fresh authentication timestamps after the Basic-auth fix. Callback was intercepted before the public app; deployed session/database acceptance remains unchecked.

- Demo preparation: World consent currently shows inherited application name “Banana Attention”; requested display-name-only correction to “Ask2Human” from user. No identifiers, keys, actions or callback changes needed. Telegram message 9 delivered.

- Worker identity blocker isolated: genuine v4 simulator result reaches World, which refuses staging with `environment_not_allowed`. Added decimal-proof support and server-only staging-token plumbing; nine focused identity tests pass. User asked to save dedicated `WORLD_DEVELOPER_API_KEY` privately so the required 24-hour window can be opened (Telegram message 10). Worker verification remains unchecked.

- Frontend package handed off with typecheck and 4 client tests passing; independent Sol acceptance started. Missing runnable agent example and PostgreSQL experience coverage assigned as a focused follow-up. Public behavior acceptance remains pending.

- Independent frontend gate found and assigned repairs for first-hire authorization visibility, rating star input, wallet-cancellation retry, delivery-based claim timing, gross-earnings accounting and unfunded cancellation UI. Payment owner is also repairing public-state brief disclosure and nullable-join rating locking. No deployment or mainnet trial is claimed from the initial client tests.

- 03:23 UTC: user supplied the dedicated World API key; reviewed helper opened the 24-hour staging window and its verification token was configured privately in Vercel. User is updating the World display name. Independent payment gate found immutable Job type, score ID, rejection split/accounting, timeout-state and trial-recovery defects; repairs assigned before any mainnet spend. Canonical Agent ID registry verified read-only and configured.

- Independent Sol worker probe passed with a genuine simulator v4 proof: action/nonce/signal matched, official World verifier returned HTTP 200/success, and the adapter verified the response using the private staging token. No application rows were created; deployed identity journey remains pending.

- Payment acceptance remains blocked pending score-object/type-anchor, buyer-share rejection accounting, REVIEW timeout eligibility, owner-funded score prerequisite, registered-buyer rejection, durable bounded trial recovery and live fee disclosure repairs. Frontend repaired authorization/retry/earnings paths passed focused static review; pending-rating recovery and chain-based claim timing remain assigned. No chain writes have occurred.

- Slush-specific integration check found SDK 2.33 requires an explicit client for zkLogin personal-message verification. Added a mainnet gRPC client to server wallet verification while retaining expected-address binding; independent review passed for client requirements, standard/legacy address binding, failure handling and challenge single use. Actual Slush connect/sign/reconnect acceptance remains unchecked.

- Frontend repair handoff: typecheck, 9 client tests and 6 isolated PostgreSQL subtests passed using only the local Compose database. Buyer-share conversion, saved-star recovery, chain-based claim timing and truthful identity environment labels implemented. Sol final delta review pending; no public browser or mainnet completion claimed.

- Sol final frontend delta passed: rating stars preserved, chain delivery deadline used, rejection buyer-share conversion correct and identity demo labels accurate. Installed dApp Kit execution result handling matches its Transaction/FailedTransaction union; offline transaction round-trip preserves exact bytes/digest and retry paths avoid repeat signing of submitted receipts. Actual Slush browser signing remains pending.

- Fee/account-setup UI handoff: quoted and funded fee/net shown separately; changed-fee acknowledgement gates delivery; seller score setup is explicit, existing-score responses skip signing, and owner-sponsored refund preparation is distinguished from the actual refund. Typecheck, 11 client tests and 7 isolated local PostgreSQL checks pass. Sol delta review and complete payment gate remain pending.

- Both final repair packages handed off. Seller readiness now uses a confirmed chain-read/receipt marker, refund preparation and actual payment retain separate pending attempts, and direct evidence uploads enforce fee acknowledgement before storage. The assembled suite passed 38 tests with only the already-recorded live S3 smoke skipped; the production build and its TypeScript checks passed. Final independent payment/frontend review remains the mainnet execution gate.

- Sol accepted the seller-readiness and refund-stage UI repairs and the pre-storage fee guard. Final payment review found three narrow repairs: registered buyers must be looked up under the Registry's `agents` table, stale pre-funding fee approvals must be renewable, and trial completion must persist its run count atomically. The mainnet trial will run under an exclusive external lock with the same private checkpoint.

- Migrations 003/004 applied and verified on both local PostgreSQL and Neon. Node address-family auto-selection caused local-to-Singapore timeouts; a process-scoped IPv4-first connection succeeded without changing credentials or TLS. Database test fixture hardening is assigned separately; the completed 38-test run already used an explicitly verified local database and cleared hosted overrides.

- Sol accepted the registry-table, stale quote renewal, trial atomic completion, fixture isolation and UI quote-refresh repairs. The updated production build passed. First locked 20,000-atomic USDC trial completed create → deliver → release; a confirmed gas top-up was not repeated after an indexing-delay retry. Independent receipt/accounting check is running. Vercel production deployment started; public acceptance remains unchecked until verified.

- Vercel production deployment `dpl_EvQHUgjh8vcY7nY4fgyF9m3y5suY` is ready at https://ask2human.me. The deployment smoke passed public pages, persisted secure anonymous sessions, CSRF/origin checks, worker/agent authentication denials and private-evidence access denial. Sol independently verified the mainnet trial receipts and actual net payment; deployed identity acceptance has started. Slush browser feedback was requested from the user while independent work continues.

- Deployed owner and worker identity journeys passed in separate sessions, including wallet binding and genuine World staging worker proof. Fresh exact-task HIRE and RELEASE callbacks produced APPROVED records. Agent API posting/application/selection, funding, selected-worker evidence upload, authorized image retrieval, anonymous denial and delivery passed. Release preparation returned HTTP 500 before signing/broadcast; independent diagnosis is running. Slush modal/close/mobile return-link checks passed in Chromium; real Slush OAuth/signing is still unverified.

- Release preparation root cause confirmed under forced rollback: migrations omitted settlement release payload/digest columns. Corrective migration and fresh-schema regression assigned; no release signature/broadcast occurred. Deployed worker attempts to fund/release, owner attempts to submit as a worker, and anonymous applications were all rejected.

- 05:17 UTC: independent Sol accepted additive migration 005 and its two fresh-schema/idempotence tests. Applied it locally and to Neon; renewed expired RELEASE consent through the real deployed callback. Existing task release confirmed PAID (`B5sCpoeaUp5BHgq3GJT8v1WH1HTuUbg94NoZ1m2XTBTL`) and rating confirmed RATED (`e9XGA6A4XUg2oeGWNqGeeuQ3saQiJppr4oiSEc6iSDQ`). Independent accounting/profile acceptance is running. Public deployment `dpl_648pJgrkRBV6mgqhnQshhRunaf8x` includes home/mobile layout repairs; public HTTP smoke and targeted Chromium mobile layout checks passed. Total new trial funding is 40,000 atomic USDC and actual gas plus conservatively counted worker top-up is 39,118,608 MIST; remaining initial gas cap is 10,881,392 MIST.

- Sol independently verified the deployed paid journey: successful funding/delivery/release/rating chain receipts, released Job, worker lifetime/month net 19,000 atomic USDC, fee 1,000, pending zero, owner agent spent 20,000/reserved zero, public confirmed five-star review and recent completed task. Separate desktop/mobile contexts passed privacy and no-overflow checks. Same-digest release/rating reconfirmation returned PAID/RATED without signatures or broadcasts. Submission copy is prepared in `docs/SUBMISSION.md`; no Git publication or event submission occurred.

- Sol additionally verified actual release balance changes directly on Sui: worker +19,000 atomic USDC; protocol +1,000 to the receiver in the onchain FeeConfig. Worker AgentScore reads reviewCount=1, starsSum=5 and averageStars=5. Actual expired RELEASE approval was denied by the deployed authorization endpoint.

- User explicitly approved raising aggregate gas plus worker gas funding from 0.05 to 0.08 SUI to test refund, timeout claim and rejection. Aggregate task-funding cap remains 0.10 USDC. Previous spend remains included; this is not a fresh per-trial allowance.

- 05:41 UTC: resumed the three authorized terminal-path tests under the aggregate 80,000,000-MIST / 100,000-atomic-USDC limits. Sol verified the existing demo worker's AgentScore on mainnet; no additional score setup should be needed. The first refund task expired while the private execution runner was being reviewed; confirmed it had no Job or funding attempt, cancelled it through the deployed owner API, and released its agent reservation. No additional chain transaction or funding occurred. Fresh refund, timeout and rejection execution remain unchecked.

- 05:52 UTC: Sol approved the repaired private refund runner after separate owner/worker live-session checks. Fresh task `cfd3f354-5ca9-43ba-be9a-50268b762a5f` received genuine World HIRE authorization and 10,000 atomic USDC funding (`48Vxpy2Kyu5fJ4osCSay6YXRHiQZ6JTeKAZ5xeynMYty`). Before its deadline, `build_refund` returned 409 `refund_deadline_not_reached`. After the deadline, refund `2teN5NvJg84a9LcyREhjpzUBzTQfYHahzfEz41NfQPbp` succeeded and the app confirmed REFUNDED. Independent balance/accounting verification is running. Aggregate funding is 50,000 atomic USDC; receipt gas plus conservatively counted worker top-up is 45,399,672 MIST. User authorized a complete proof table followed by Git commit and push once the remaining tests and review finish.

- Sol independently accepted the overdue refund: owner received exactly +10,000 atomic USDC; no worker/protocol USDC payment; Job and both API views REFUNDED; zero refund fee/net/worker earnings; repeated confirmation preserved the same receipt without signing. Prior worker net remains 19,000. The refund reservation was released; only the separate prepared timeout task currently reserves 10,000. Refund acceptance is complete; timeout claim and rejection remain pending.

- 06:04 UTC: Sol independently accepted timeout claim and rejection receipts, actual balances, terminal Job states, API accounting and same-digest confirmation retries. Timeout paid worker 9,500 / protocol 500; rejection returned owner 5,000 and paid worker 4,750 / protocol 250 atomic USDC. Early timeout and missing-consent rejection were denied. All plans complete; agent reserved zero; worker net 33,250 and pending zero. Final aggregate: 60,968,632 MIST including worker top-up, 70,000 atomic USDC funded. Latest regressions 44 passed / 0 failed / 1 opt-in S3 skipped; typecheck passed. Actual Slush OAuth/sign/cancel/reconnect remains unverified.
