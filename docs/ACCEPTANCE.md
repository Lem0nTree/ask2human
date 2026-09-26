# Acceptance record

This file distinguishes automated checks, live infrastructure trials, and human browser flows. Only completed checks should be reported as passing.

## Required automated coverage

- Worker verification failure and duplicate enrollment block paid acceptance.
- Wallet binding validates an expiring, one-use, account- and domain-bound signature.
- Concurrent acceptance has exactly one winner.
- Agent scopes, ownership, categories, per-task limits, and total reserved spend are enforced on the backend.
- OIDC callback rejects incorrect state, nonce, issuer, audience, expiry, owner, and freshness.
- Funding consent is tied to task, worker, amount, coin, and expiration; changing those facts invalidates it.
- Evidence is private and accessible only to task participants.
- Funding, submission, release, and refund states require matching confirmed Sui receipts; retries are idempotent.
- Escrow release and refund cannot both succeed; an expired but submitted task cannot take the unsubmitted refund path.
- The production build and browser marketplace work without fabricated live workers or payments.

## External acceptance

- Existing t2000 Sui mainnet escrow: actual fund → deliver → release transaction/object references.
- A real expired-undelivered refund and elapsed-review-window claim on mainnet within the agreed trial budget.
- World sandbox worker verification in the browser, plus cancelled/failed verification.
- World Agents login and fresh exact-hire approval through the registered HTTPS callback, plus denial/expiry.
- An application evidence upload and authorized read against private S3.
- Vercel deployment, custom domain, and HTTPS callback reachability.

The independent checker records evidence and unresolved blockers here after implementation.

## Independent checker evidence — 25 September 2026

- `npm test`: 10 passed, 1 skipped. The skipped test is the opt-in live S3 smoke; it was run separately. `npm run typecheck` passed. These checks ran after the funding-approval, release-review, and protected OIDC freshness repairs.
- Temporary PostgreSQL schemas exercised atomic agent budget reservation, one-winner worker acceptance, private browser state, one-use wallet challenges, funding retry with an older denied approval under a sequential-scan plan, and rejection of both agent and owner review changes after release transaction bytes were issued. Each fixture schema was dropped after its test. The two payment regression tests passed after the repairs.
- World adapter tests used synthetic proofs and a stub verifier to exercise invalid proof bindings, verifier mismatches, OIDC state/callback rejection, and the protected-approval `auth_time` boundary. They do not establish a successful live World login or proof.
- The opt-in application S3 smoke passed with a synthetic worker and funded task in a temporary PostgreSQL schema: a small generated PNG and report uploaded through `uploadEvidence`, assigned worker and task owner received working signed reads, unrelated session and agent were denied, direct unauthenticated object access did not return the object, and a duplicate upload was rejected. The schema was dropped. This was a real bucket request, not an S3 mock.
- The configured application IAM profile denies `DeleteObject` and `ListObjectsV2`. Two private generated checker objects remain from the smoke and its initial run. Their exact keys were recorded in a temporary private cleanup manifest, but that `/tmp` file did not survive the resumed environment. An administrator with delete access will need to locate the objects from bucket records. No more storage fixtures should be created for this check.

Live Sui funding, submission, release, and refund; successful World sandbox flows; production build and browser marketplace acceptance; and Vercel/domain validation are still unverified here. Local unit, database, and storage results do not imply those external flows passed.

## Independent checker continuation — 26 September 2026

- `npm test` passed again: 10 passed, 1 skipped (the opt-in live S3 smoke). `npm run test:sui` passed the local Sui transaction builder and BCS receipt checks. Neither command creates a live chain payment or storage object.
- The previously recorded live S3 result remains valid as historical evidence, but its two generated objects remain without a currently available key manifest. The application IAM profile still lacks deletion rights; the live smoke was not repeated.
- The public testnet owner wallet balance was checked independently and remains zero, blocking a funded on-chain trial. No successful World browser login, deployed HTTPS callback, Vercel deployment, or custom-domain validation has been observed.
- After the frontend handoff, `npm run build` completed and emitted a fresh `.next/BUILD_ID`; `npm run typecheck` passed. The built application started on `127.0.0.1:3001`, and `GET /api/state` returned HTTP 200 JSON.
- Obscura loaded the production homepage backed by the local database: it showed zero live tasks and agents, the empty marketplace state, worker onboarding and owner login sections, and valid navigation anchors. Desktop and narrow-window Chromium captures confirmed the wallet connection button and responsive layout. No wallet extension was attached, so wallet signing, IDKit completion, fresh owner approval, and frozen transaction retry could only be reviewed in code; they were not browser-executed.
- Obscura logged a `wallet-standard:app-ready` Event error and did not render the dApp Kit button, while headless Chromium rendered it. This limits Obscura's wallet-component observation; it is not evidence of an application failure in Chromium.
- After a focused frontend correction, a second `npm run build` completed successfully with TypeScript and all expected routes. The production server was restarted; Obscura again showed the empty database-backed marketplace, worker and owner sections, and the updated sandbox/testnet and evidence-review copy. Headless Chromium again showed the wallet button; `GET /api/state` returned HTTP 200 JSON. Static review confirmed FUNDING controls now route a pending HIRE approval to World authorization and show wallet signing only for APPROVED or ISSUED approvals. A connected wallet and real approval were unavailable, so this control was not exercised end to end in the browser.

## Mainnet integration phase — World adapter check, 26 September 2026

- Independent Sol checker completed the legitimate World Agents sandbox browser authorization handoff. An actual exchange initially failed because the registration requires `client_secret_basic` while the library default was `client_secret_post`. The adapter now explicitly selects `ClientSecretBasic`.
- After the repair, both real `owner_login` and `protected_approval` exchanges passed through the current adapter. The checker verified identity continuity and fresh authentication time without retaining or exposing authorization codes, tokens, or subjects. The seven focused World adapter regression tests also pass.
- These flows intercepted the callback before the public application and wrote no application database records. Deployed sessions, one-use callback persistence and exact task-bound approval remain separate acceptance items. Sandbox identities do not establish production Proof of Human.

- Independent worker probe obtained a genuine v4 `proof_of_human` from the normal staging simulator UI. The simulator uses decimal proof words; a hex-only local predicate was corrected with uint256 bounds while preserving exact payload forwarding and all identity bindings.
- The live verifier then returned 403 `environment_not_allowed`. Current World v4 requires an explicit 24-hour window and server-only token. Added token plumbing and configuration-error handling; independent Sol review passed, with 11 focused adapter tests passing. This remains a blocked live worker acceptance item until the team API key enables the window. No worker was marked verified by these probes.

## World worker readiness — 26 September 2026

Independent Sol check generated a genuine v4 `proof_of_human` through the normal World staging simulator in Chromium. Action, nonce and wallet-linked signal matched. The server adapter sent the server-only staging token; the official verifier returned HTTP 200, `success: true`, the expected staging environment and matching action/nullifier. Adapter verification passed. Proofs, identity identifiers and credentials were not retained in reports. This was adapter readiness, without application database writes; deployed worker session completion remains pending. The current window expires 27 September 03:22 UTC.

## Slush signature compatibility review

The installed Sui SDK 2.33.1 requires an explicit network client for zkLogin personal-message verification. The server now supplies a mainnet gRPC client and the expected wallet address. Independent Sol review confirmed standard/legacy zkLogin address checks and fail-closed handling of malformed signatures, invalid proofs, address mismatches and RPC failures before binding. Session, expiry and single-use checks remain enforced. This is code/SDK acceptance; actual Slush OAuth connection and signing have not yet been exercised.

## Marketplace repair acceptance

Luna reports passing typecheck, 9 client regressions and 6 PostgreSQL subtests in a disposable schema on the local Compose database. Coverage includes unauthorized selection, concurrent one-winner selection, evidence privacy, chain delivery timing, uncapped confirmed earnings and confirmed-only public ratings. Sol independently reviewed the repair delta: saved-star recovery, chain delivery deadlines, 25% worker share → 7500 buyer basis points, and explicit World environment labels pass.

Wallet execution handles the installed dApp Kit Transaction/FailedTransaction response union, checks success and expected digest before server confirmation, retains cancelled preparations, and reconciles already-submitted receipts without another signature. An offline SDK round-trip preserved transaction bytes and digest. These checks do not constitute live Slush OAuth/signing or deployed end-to-end acceptance.

## Deployed acceptance preparation

Private acceptance harnesses are prepared outside the repository. Sol reviewed the identity/session and agent-task preparation paths, and the payment runner's frozen-byte retries, exact task terms, receipt handling and spend limits. Before platform funding, the runner counts actual gas and worker gas funding from the first SDK trial and reserves gas for both delivery and release. A rating requires a confirmed `RATED` response. Default invocation performs no requests or signatures. These are preparation checks only: execution requires the payment and deployment gates to pass.

## Confirmed t2000 mainnet trial — 26 September 2026

An independently reviewed, exclusively locked trial completed funding, delivery and release through the existing deployed t2000 contracts. Sol independently read all five successful checkpointed receipts and the released Job, verifying parties, specification/delivery hashes and immutable terms.

Job: `0xb173282881b06f8a72c79558647aac62d38ed326b51aedd98aecd008918e95e0`.

| Stage | Mainnet transaction digest |
| --- | --- |
| Worker gas top-up | `ELfWeQ1RB9wYrGTLmkjGQPRE7yo6Vi1dxAnWrd5PLTNA` |
| Seller score setup | `GEs7E5k7nrEpRGTszQSrRNWCzQbxQypSgR6FFL2u6aut` |
| Funding | `2ro9FmmyLesq2tfAyE8vbTfURwJK6DRWaKo7QU2xpN27` |
| Delivery | `6bqaD4nErNHyk1Pz7XNYjuSJbL5yQWnquww5m3EaPKhR` |
| Release | `BRtuUhBkXbQSKYkFy6fpc6ke4gsMVSp3Bvg57Q7pfLCD` |

Confirmed gross was 20,000 USDC atomic units (0.02 USDC). The 500-basis-point fee was 1,000; the worker's actual release balance change was +19,000 (0.019 USDC), and the protocol received 1,000. Actual gas across all five receipts was 12,003,892 MIST. Counting the 15,000,000-MIST worker top-up conservatively as well, usage was 27,003,892 MIST against the 50,000,000 initial cap.

The first attempt stopped before score signing because the node's balance index had not caught up with the confirmed top-up. A read verified the 15,000,000 balance; resuming the same locked checkpoint completed without another top-up or funding job. The final checkpoint is `done`, `runs: 1`, with no pending frozen stage. This establishes the SDK/mainnet lifecycle, not the deployed application workflow, Slush browser signing, rating, rejection or refund acceptance.

## Public deployment and identity acceptance — 26 September 2026

The canonical application is live at https://ask2human.me on Vercel, backed by Neon Singapore with migrations 001–004 applied. The deployment smoke passed public routes, persisted secure/HttpOnly/SameSite cookies, same-origin/CSRF enforcement and anonymous evidence denial. Sol completed separate deployed owner and worker sessions: real World sandbox owner callback, wallet personal-message binding, and genuine staging worker verification. Fresh task-bound HIRE and RELEASE callbacks each produced the expected APPROVED record.

Chromium checked the public Slush modal, dismissal, and mobile return link to the canonical origin. Public home/work/agents pages fit a 390-pixel viewport. These checks do not establish external Slush OAuth, signatures or reconnect behavior.

A deployed negative-authentication probe injected a provider `access_denied` callback into a legitimately created anonymous login flow. The callback redirected to `denied`, left the session anonymous, and its replay redirected to `failed`. A separate callback without its session failed and consumed its state; replay with the original session still failed without login. This checks application callback behavior, not a user's actual provider cancellation or an expired browser ceremony.

The deployed task `35dc7c07-3a92-4374-be37-d404aedbfbe7` has passed agent API posting, verified worker application, agent selection, owner funding and worker delivery. Funding receipt: `G9Rw8zXHqSkDPZVvguWUr1CMEN84P3kqFqzU5jYj4V6J`; delivery receipt: `5QHWc3mz6sUB3Zd4PtrYToVu4EJft3xDSrWnrBjHpp61`. The selected worker uploaded an actual marketplace inspection image and report through the public application; owner and worker each retrieved the exact image bytes from private S3, while anonymous application access was denied. Duplicate funding confirmation returned the existing FUNDED state without another transfer. Release preparation is under diagnosis after a server-side 500; no release transaction was signed or broadcast by that failed request.


## Deployed release repair and complete paid transaction path — 26 September 2026

Release preparation exposed PostgreSQL error 42703: migrations 001–004 lacked the settlement release digest/payload columns referenced by the application. Additive migration 005 adds all three fields without altering prior monetary data. Sol independently accepted it, and two local tests passed including complete fresh-schema migration, repeat application of 005, and an issued-release replay. Migration 005 was then applied and its three fields verified on Neon and locally.

After renewing the expired owner approval through the real deployed World callback, the existing task reached PAID with release `B5sCpoeaUp5BHgq3GJT8v1WH1HTuUbg94NoZ1m2XTBTL`. Its five-star public rating reached RATED with transaction `e9XGA6A4XUg2oeGWNqGeeuQ3saQiJppr4oiSEc6iSDQ`. No replacement task funding occurred. These transactions were signed by the controlled private local test harness; this does not establish Slush browser signing. Independent chain, accounting and profile checks are recorded separately when complete.

Aggregate initial-trial funding is 40,000 USDC atomic units. Actual receipt gas plus the conservatively counted worker top-up totals 39,118,608 MIST, leaving 10,881,392 against the initial 50,000,000-MIST cap. The platform release cost 2,806,816 MIST and rating cost 5,960,436 MIST.

The latest assembled test run passed 44 tests with zero failures and one intentionally skipped opt-in S3 smoke. All database fixtures used the explicitly checked loopback database with hosted overrides cleared. Public deployment `dpl_648pJgrkRBV6mgqhnQshhRunaf8x` passed the HTTP smoke. A Chromium 390-pixel task-page check confirmed stacked heading/status, a readable unsqueezed badge, spaced fee/next-action panels, and no horizontal overflow.

Additional deployed denials passed: worker cannot fund or release, owner cannot submit as a worker, and anonymous users cannot apply. The genuinely expired earlier RELEASE approval was read from the database and rejected by `begin_owner_authorization` with 409 `approval_expired`. This adds actual approval-expiry evidence to the injected-denial/replay checks; it does not assert provider-UI cancellation was exercised.

Independent Sol reads confirmed the release transaction transferred exactly +19,000 atomic USDC to the verified worker and +1,000 to the onchain FeeConfig receiver. The worker AgentScore contains one review, five total stars and an average of 5. Deployed worker earnings are lifetime/month net 19,000 and pending zero; owner agent spent is 20,000 and reserved zero. Public profile shows the confirmed review and safe recent-work summary. Separate desktop/mobile contexts passed; repeated release/rating confirmation returned PAID/RATED without signing or broadcasting.

An actual provider-cancellation probe used a new anonymous Chromium context. World sandbox showed no visible Cancel/Deny action and automatically completed sign-in; therefore no genuine provider-cancellation callback is claimed. Saved owner/worker acceptance sessions were untouched. A separate anonymous context still received 401 `owner_required` for protected release.

## Deployed overdue refund (26 September, 05:52 UTC)

Task `cfd3f354-5ca9-43ba-be9a-50268b762a5f` received a fresh genuine World HIRE approval and 10,000 atomic USDC funding, receipt `48Vxpy2Kyu5fJ4osCSay6YXRHiQZ6JTeKAZ5xeynMYty` (2,944,680 MIST gas). Before its 05:51:34.430 UTC deadline, the deployed refund builder denied the owner with 409 `refund_deadline_not_reached` without a transaction. After the deadline, receipt `2teN5NvJg84a9LcyREhjpzUBzTQfYHahzfEz41NfQPbp` (3,336,384 MIST gas) confirmed REFUNDED.

Sol independently verified the successful receipt, refunded onchain Job and exactly +10,000 canonical USDC atomic returned to the owner, with no worker or protocol USDC payment. Owner and worker API views agree on state and digests. Settlement fee/net are zero; the refund contributes zero worker earnings. Lifetime worker net remains 19,000 from the earlier paid task. Repeating `confirm_refund` returned the same state and digest without signing or broadcasting. Agent spent remains 20,000; its current 10,000 reservation belongs to the separate prepared timeout task, not the refunded task. The local refund checkpoint is complete. Aggregate funding is 50,000 atomic USDC and actual gas plus the conservatively counted worker top-up is 45,399,672 MIST against the authorized 100,000 / 80,000,000 limits.

## Deployed review-window claim (26 September, 05:59 UTC)

Task `85b33c1a-7b93-4c44-80d7-9199ddff1a27` received genuine World HIRE authorization, 10,000 atomic USDC funding (`AQ16oYQNkfxxQ8Rrs4Zk2L2fZM7rfjWmoGkU617ey4Hq`, 2,944,680 MIST), an actual public-page screenshot/report upload and delivery (`DHW9VETTfhkS4tSihHZrxfP5fZ6Gb3dBAs9bB61CDUX8`, 402,784 MIST). The agent requested review. An early worker claim was denied with 409 `review_window_open`; after the 60-second chain-based window, the worker signed claim `ExPw3dAQaMzBQ8g4M3cYZfpdw6WKoLCZEQZA1Bndj6Uh` (2,806,816 MIST), which confirmed PAID without fresh owner RELEASE approval.

Sol verified all three receipts, the released Job and immutable terms, worker +9,500 and protocol +500 canonical USDC atomic, no owner payment, and matching owner/worker API state. Settlement gross/fee/net are 10,000/500/9,500. Worker lifetime gross/fee/net became 30,000/1,500/28,500; agent spent became 30,000. Repeating `confirm_timeout_claim` preserved PAID, the digest and amounts without signing or broadcasting.

## Deployed rejection split and final trial totals (26 September, 06:03 UTC)

Task `0933540a-704a-46a3-9ae8-94b9880f5c1a` received genuine World HIRE approval, 10,000 atomic USDC funding (`5ZV8fAhwYeNHb1tLNi6iD4pQVtpXL1h1X7xAvQtZNG8t`, 2,944,680 MIST), actual public-page screenshot/report evidence and delivery (`G4cN4cBooTT3xr7U3coTd5ptf8XAuk8yQ8EPPq3hMCt6`, 402,784 MIST). Agent review requested the explicitly agreed test rejection. Before fresh consent, the rejection builder returned 409 `owner_approval_required`. A genuine World REJECT callback then approved the exact task terms.

The runner stopped before signing when the rejection's frozen gas budget exceeded its initial 5M per-stage limit. Sol reviewed a rejection-only 7M limit within the user's unchanged aggregate 80M cap. The same saved bytes/digest were resumed, not rebuilt or funded again. Rejection receipt `31Xnd2Hhs3s3TDfe4XHPNTgfWPbgWYfvQuscQznZwP8a` used 6,067,216 MIST and confirmed REJECTED.

Sol independently verified every receipt and the rejected Job (5,000-bps buyer split, 500-bps fee). Actual canonical USDC atomic balance changes were +5,000 owner, +4,750 worker and +250 protocol. Both API views agree. The rejection contributes worker gross/fee/net of 5,000/250/4,750. Final worker lifetime gross/fee/net are 35,000/1,750/33,250, pending zero; agent spent is 35,000 and reserved zero. Repeating `confirm_reject` returned the same digest and amounts without signing or broadcasting. All local trial plans are complete with no unresolved transaction.

Final cumulative task funding across SDK, paid/rated app, refund, timeout and rejection trials is **70,000 atomic USDC (0.07 USDC)**. Actual receipt gas plus conservatively counted worker gas funding totals **60,968,632 MIST (0.060968632 SUI)**, below the authorized **100,000 atomic USDC / 80,000,000 MIST** caps. Final local regression run: **44 passed, 0 failed, 1 opt-in S3 test skipped**; TypeScript checks passed. See [the proof table](PROOF_OF_TESTING.md) for scenario-by-scenario evidence and remaining browser-wallet limits.
