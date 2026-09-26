# ask2human

**Live demo: [ask2human.me](https://ask2human.me).** The MVP uses existing t2000 mainnet USDC escrow, Vercel and Neon. Follow the [live checklist](docs/DEVELOPMENT_CHECKLIST.md) for the distinction between implemented features and independently verified journeys. Custom Move publication is retired from the MVP path.

A marketplace where agents commission real-world observations from verified human workers. World IDKit verifies worker uniqueness, World ID for Agents authenticates the owner approving a hire, and t2000 escrow on Sui mainnet fixes the selected worker who receives USDC payment.

This is a hackathon implementation using sandbox identity and real mainnet USDC for controlled demonstrations. Evidence is reviewed offchain; a photo does not prove physical presence. Submitted disagreements have an offchain review path, not onchain arbitration.

## Hire a human

Open `/agents` for the guided hiring flow: sign in with World, link your payment wallet, set spending limits in a hiring profile, then post a task. The profile is the API's `agent` record; it does not create or run an AI. Connecting a wallet and posting a task do not deposit funds. After choosing one applicant, approve the exact hire and sign the escrow funding transaction. Review delivery and approve payment release from the task page.

Applications remain open until selection or the delivery deadline. There is no separate application window, background applicant check, or outbound notification service. The review window starts at on-chain delivery; after it expires, the worker can initiate a payment claim. See the [workflow guide](docs/HIRING_WORKFLOW.md).

## Connect your own AI with MCP

The local [MCP connector](mcp/README.md) exposes the eight existing agent tools to a harness that supports stdio MCP servers. It uses your profile's scoped API key and calls the hosted API; the owner retains browser approval and wallet signing. It does not run a scheduler or hold wallet keys.

```sh
npm ci --prefix mcp
npm test --prefix mcp
```

Configure your harness to run `node /absolute/path/to/ask2human/mcp/bin/ask2human-mcp.js` with `ASK2HUMAN_API_KEY` in its environment. The default API is `https://ask2human.me`; `ASK2HUMAN_BASE_URL` optionally selects another origin. Visit `/connect` for the installation steps and example configuration. This is a source-installable package, not a published npm release.

## Run locally

Use Node.js 22 or newer and the existing PostgreSQL Compose service.

```sh
npm ci
# For a new checkout only: copy .env.example to .env and fill the values.
docker compose up -d db
npm run db:migrate
npm run dev
```

The development server binds to `127.0.0.1:3001` (port 3000 is occupied by another local project). Keep `.env` private and outside Git. Existing installations must preserve their configured `.env` and PostgreSQL volume.

```sh
npm run typecheck
npm test
npm run build
```

## Design and infrastructure

- [Product specification](Agent_to_Human_Marketplace_Product_Spec.md)
- [Prepared infrastructure](DEVELOPMENT_PREPARATION.md)
- [Historical implementation decisions](docs/IMPLEMENTATION.md)
- [Proof of testing and transaction table](docs/PROOF_OF_TESTING.md)
- [Acceptance evidence](docs/ACCEPTANCE.md)
- [Live implementation checklist](docs/DEVELOPMENT_CHECKLIST.md)
- [Full implementation report and specification checklist](docs/PLATFORM_REPORT.md)
- [Browser and agent API](docs/API.md)
- [World identity integration](docs/WORLD.md)
- [Archived custom escrow and testnet trial](docs/SUI.md)
- [Vercel deployment](docs/DEPLOYMENT.md)
- [Submission draft and verified demo links](docs/SUBMISSION.md)

The application uses one Next.js project with PostgreSQL and private S3 storage. Browser wallets hold signing authority. Agent API credentials can request actions under the owner's policy; they cannot sign payments. New task amounts are integer USDC atomic units (1 USDC = 1,000,000 units), explicitly tagged with asset, decimals and mainnet network. Historical testnet SUI records retain their original units. Slush and Wallet Standard wallets provide account connection, personal-message signatures and transaction signatures.

The public application runs on Vercel in Singapore with Neon PostgreSQL and private S3 evidence storage. Its canonical origin and World callback use `https://ask2human.me`. The development machine is not the production web host.

## Reuse

The frontend adapts layout, styles, navigation, cards, and UI primitives from the user's [bnbera](https://github.com/Lem0nTree/bnbera) marketplace. [Source provenance](docs/FRONTEND_SOURCES.md) records the donor revision and files. Identity, wallet, transaction, and storage plumbing use the official SDKs. Payment integration reuses the pinned t2000 SDK builders and existing deployed contracts. The previous custom testnet contract remains archived in this checkout and is not the MVP deployment path. Reusing a protocol does not establish independent audit coverage of its current deployed revision.

Implementation-specific source notes and verification records accompany the modules under `docs/`.

## Remaining live acceptance

The public deployment, migrations 001–005, separate owner/worker World sandbox sessions, exact-task authorization and a bounded SDK mainnet payment trial passed. Deployed agent posting, worker selection, funding and private evidence delivery also passed; the full application payment and rating journey passed independent chain, accounting and profile acceptance. Refund, elapsed-review-window claim and the rejection split also passed independent chain and accounting checks. Actual Slush OAuth/signing and the recorded browser-wallet demo remain separate gates. World staging expires on 27 September 2026 at 03:22 UTC. Follow the [live checklist](docs/DEVELOPMENT_CHECKLIST.md) and [acceptance record](docs/ACCEPTANCE.md) for current results.

Do not run the legacy custom-contract publish/trial scripts for this MVP. Keep owner and worker wallet private keys only in private local test configuration; the deployed app receives no wallet private keys. Earlier local/testnet evidence is dated separately from current public/mainnet acceptance. See [t2000 integration notes](docs/T2000.md) for payment constraints and dependency qualifications.
