# World Mini App feasibility and publishing check

Checked: 2026-09-26. Scope: research and a proposed validation plan; no Mini App was registered, submitted, or published, and no funds were moved.

## Recommendation

Keep the Sui escrow architecture for the first feasibility prototype. Publication while retaining Sui is plausible, but is not yet established for ask2human. The reviewed World rules do not state a blanket requirement that every app use World Chain. This is an observation about the published rules, not an approval from World. Ask for clarification about this specific marketplace and signing flow before investing in a complete conversion. [Review policy](https://docs.world.org/mini-apps/guidelines/policy)

Native MiniKit transactions are documented for World Chain; the Pay result identifies its chain as `worldchain`. Neither API is a documented way to sign the existing Sui transactions. Retaining Sui requires a separate compatible signer. World wallet authentication, World ID verification, and proof of control of a Sui wallet must remain distinct. [Transactions](https://docs.world.org/mini-apps/commands/send-transaction), [Pay](https://docs.world.org/mini-apps/commands/pay)

## Findings in this project

| Area | Evidence | Readiness |
| --- | --- | --- |
| Web application | Existing Next.js app and shared server APIs | Reuse this repository and deployment; a separate repository is unnecessary |
| Sui wallet | `app/lib/client/dapp-kit.ts` uses Slush at `https://my.slush.app`; installed Slush implementation opens popup channels for connect, message signatures, and transactions | Blocking compatibility issue to investigate |
| World worker verification | IDKit v4 widget, server-signed requests, server verification, account-bound challenges | Good starting point; actual World App transport remains untested |
| Live identity environment | Public `https://ask2human.me/api/state` reported `worldIdentityEnvironment: staging` on the check date | Production enrollment must be validated before submission |
| Owner authentication | `app/lib/server/owner-auth.ts` uses OIDC with session-bound redirects and fresh protected approvals | Test login, return navigation, cookies, and approval freshness inside World App; confirm production issuer availability |
| MiniKit | No MiniKit dependency in `package.json` at inspection | Add initialization and relevant native functionality during the prototype |
| Browser assumptions | `window.confirm` for transaction/cancel/rating consent; private evidence uses `target="_blank"` | Replace with in-app dialogs and an evidence viewer in Mini App mode |
| Navigation | `/work` and `/agents` are long setup pages with a website header/footer | Adapt to compact mobile screens and persistent task navigation |
| Policies/support | No dedicated privacy/terms page routes found under `app` | Prepare accessible policy and support pages for the listing |

World's webview documentation prohibits new windows and says iOS alert dialogs are unsupported. Camera/file uploads, location, cookies, and storage are available subject to platform behavior and permissions. The popup dependency is therefore a concrete reason the current site should not be submitted unchanged. Native confirmation behavior also needs a device check. [Webview specifications](https://docs.world.org/mini-apps/more/webview-spec)

Current documentation places World ID verification in IDKit, including automatic native transport inside World App. MiniKit 2 no longer owns verification. Keep the existing backend verification and replay checks; confirm that the installed IDKit version supports this transport and the requested v4 proof settings. Do not reintroduce an obsolete `MiniKit.verify` flow. [IDKit for Mini Apps](https://docs.world.org/world-id/idkit/mini-apps), [MiniKit 2 migration](https://docs.world.org/mini-apps/migration/minikit-v2)

## Check plan and decision gates

### 1. Confirm the intended distribution and wallet policy

Prepare this question for the World review/support team; it has not been sent:

> Can ask2human be listed as a World Mini App with World ID for worker uniqueness and USDC escrow on Sui? Users must prove control of a Sui wallet and sign escrow funding, delivery, settlement, refund, and claim transactions. Which embedded Sui wallet or wallet handoff/return patterns are supported and acceptable on both iOS and Android?

The user does not remember the Solana Mini App name, so that specific example remains unverified. If an example becomes available, record the actual signing chain, wallet provider, whether funds bridge, whether execution is custodial, and whether the experience leaves World App. Merely displaying SOL or a Solana asset does not establish a usable Sui signing path. World has an official [World ID protocol integration on Solana](https://github.com/worldcoin/world-id-protocol-solana), but that is proof verification on Solana, not evidence of native Solana wallet signing in MiniKit.

**Exit evidence:** a documented supported path or clarification about the proposed flow. Absence of a prohibition alone is insufficient to mark this passed.

### 2. Build a small wallet compatibility prototype

Use a preview URL within the existing project, with dedicated test accounts and clearly separated records. Configure its World Developer Portal entry for device testing once implementation is authorized.

Test inside actual World App on iOS and Android:

- Launch, connect a Sui wallet, and complete a server-verified personal-message challenge.
- Sign a Sui transaction with the same linked account and independently confirm its digest/effects.
- Cancel signing, deny permissions, disconnect, change accounts, background the app, and resume without losing task state.
- Confirm the user can reliably return after any approved wallet handoff; preserve one-use challenge binding and expiry across navigation.
- Confirm recovery works on a later launch, not only in the initial session.

The [official Slush wallet source](https://github.com/MystenLabs/ts-sdks/blob/main/packages/slush-wallet/src/wallet/index.ts) also uses popup channels. Mysten documents [Slush app links](https://sdk.mystenlabs.com/slush-wallet/deep-linking), but payment links alone do not replace arbitrary t2000 escrow calls or guarantee return to World App. First evaluate whether a supported Slush flow can avoid popups. If it cannot, investigate a supported redirect/embedded Sui signer. Treat alternatives as candidates until documented and demonstrated; do not invent a deep link or substitute a server-controlled key for the user's wallet.

**Exit evidence:** recordings and transaction receipts from both mobile platforms with one selected signing approach. Obtain explicit approval for any funded mainnet test before execution. If no acceptable signing path exists, stop the Sui Mini App implementation and present the alternatives.

### 3. Validate identity and account continuity

- Initialize the current MiniKit SDK and detect World App while retaining ordinary browser behavior.
- Exercise IDKit's native transport with valid and rejected proofs; confirm nullifier uniqueness, challenge binding, environment checks, cancellation, and expiry remain enforced.
- Configure and verify production worker enrollment before release. Decide how staging identities are separated from production accounts; changing an environment variable must not promote test identities.
- Test owner OIDC login and fresh approvals with session continuity after redirects. If an alternative identity method becomes necessary, design explicit account linking and preserve the existing approval contract.
- If World wallet auth is introduced, verify it on the server and link it explicitly. A World wallet address does not prove ownership of the stored Sui address.

**Exit evidence:** the same intended worker/owner accounts survive app restart and approved navigation, with no duplicated or silently merged identities.

### 4. Adapt the mobile experience

Keep one codebase. Introduce a Mini App shell or entry route that reuses marketplace, task, worker, and owner components.

- Use bottom navigation for Tasks, My work, and Hire; display the current setup step prominently and collapse completed steps.
- Replace browser confirmations and separate-window evidence links with accessible in-app views.
- Handle safe areas, keyboard resize, back navigation, upload permissions, loading failures, and reconnects.
- State clearly that payouts are USDC on Sui, and explain any Sui gas requirement. Do not imply World App balances directly fund Sui escrow.
- Make retries preserve the frozen transaction and prevent duplicate submissions.

World recommends mobile app navigation, avoiding long scrolling website layouts, and quick initial loading. Those recommendations motivate a Mini App presentation layer rather than submitting the desktop layout unchanged. [App guidelines](https://docs.world.org/mini-apps/guidelines/app-guidelines)

**Exit evidence:** usable flows at small phone widths on both platforms, including denied camera access and interrupted networking.

### 5. Exercise the complete marketplace flow

For each platform, record:

1. Worker enrollment and Sui wallet recovery.
2. Owner login, payment wallet linking, spending-limit authorization, and task posting.
3. Application and worker selection.
4. Exact owner approval and confirmed escrow funding.
5. Evidence upload and confirmed worker delivery.
6. Owner review and confirmed settlement receipt in earnings.
7. A separate timeout-claim scenario and eligible refund/rejection scenarios.
8. Cancellation and interrupted signing recovery without duplicate settlement.

World ID success is not acceptance evidence for Sui payments. Keep the current rule that only confirmed settlement receipts count as earnings.

**Exit evidence:** a concise acceptance report with task IDs, public transaction digests, device/World App versions, and redacted screenshots. Keep proofs, tokens, private evidence, and credentials out of the report.

### 6. Prepare and submit the listing

Prepare the final app URL, name, description, icon, screenshots/content card, support contact, privacy/terms information, intended countries, and reviewer walkthrough. Address marketplace task moderation and evidence privacy in the product and reviewer notes.

Suggested description: “Find paid tasks for humans, hire verified workers, and track delivery and USDC payments.”

The review policy expects a functioning final product, live World SDK integration, complete information, reviewer access, support contact, and applicable safety/privacy requirements. Its MiniKit section asks for meaningful integration, while its submission section accepts live IDKit or MiniKit; clarify the intended IDKit-plus-Sui setup rather than assuming this wording guarantees acceptance. Approval and public listing are separate from loading a preview URL. [Review policy](https://docs.world.org/mini-apps/guidelines/policy), [App Store submission](https://docs.world.org/mini-apps/quick-start/app-store)

**Exit evidence:** all previous gates passed, review package prepared, then submission authorized and approved through the Developer Portal.

## Alternative if the Sui signing gate fails

Compare two explicit proposals: a supported Sui wallet architecture compatible with World App, or a World Chain payment/escrow implementation. Adding a bridge would introduce funding, settlement, refunds, and recovery across chains and requires a separate design. A native World Chain transfer must never be presented as proof that a Sui escrow is funded.

Do not migrate contracts or add bridging solely to gain a listing before resolving the signing and policy questions.
