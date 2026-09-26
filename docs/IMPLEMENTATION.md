> Historical implementation record: the revised MVP uses t2000 mainnet USDC and Slush. Do not publish or fund the custom testnet escrow as part of the current plan. Follow [the revised plan](HACKATHON_COMPLETION_PLAN.md) and [live checklist](DEVELOPMENT_CHECKLIST.md).

# Implementation decisions

The product specification and `DEVELOPMENT_PREPARATION.md` are the requirements.

- **Network:** Sui testnet, SUI (`0x2::sui::SUI`, 9 decimals). The prepared environment selects the specification's independent escrow fallback. No t2000 mainnet package IDs or real USDC are used.
- **Runtime:** one Next.js application for browser screens and backend routes, deployable to Vercel. PostgreSQL persists authorization and task state; private S3 stores evidence.
- **Reuse:** official World IDKit and OpenID Connect libraries, Mysten's transaction/wallet SDK, AWS S3 SDK, and the existing marketplace frontend supplied by the user when available. Source-specific adaptation and license notes accompany the integration modules.
- **Authority:** agent credentials delegate application actions only. Owner and worker wallets sign their own transactions. World authentication never substitutes for a wallet signature.
- **Chain receipts:** payment states require confirmed, validated chain evidence. A transaction draft or browser-reported digest alone is insufficient.
- **Identity:** enrollment deduplicates workers in PostgreSQL. Sandbox identity and test funds must be identified in the interface. No proof payload, nullifier, or private evidence belongs onchain.
- **Escrow terms:** the fixed worker may submit before the deadline; the funder releases a submitted job. The funder may refund an expired job only if it has no submission. Submitted disagreements require offchain review; this minimal module has no arbitration or automatic release.

## Implementation and acceptance order

1. Deploy/test the minimal testnet escrow and exercise funding, submission, release, and expired-unsubmitted refund.
2. Add World worker verification and owner OIDC adapters using current official documentation.
3. Persist marketplace policies, consent, wallet binding, tasks, evidence, and settlement reconciliation.
4. Adapt the supplied marketplace frontend to these APIs and wallet actions.
5. Run an independent Sol check, repair failures, and record verified behavior and any external blockers.

The database and S3 preparation are existing infrastructure, not evidence that application flows have passed. Live World browser validation and Vercel/domain setup need their own recorded results.
