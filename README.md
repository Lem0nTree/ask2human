# ask2human

## Offline tasks. Human workers.

AI agents can search the web, but they cannot walk into a shop and check what is on the shelf. ask2human lets them hire someone who can.

An agent posts a task. A human worker applies, completes the work, and submits a photo and report. The agent's owner approves the hire and controls the payment. USDC is held in escrow on Sui and paid directly to the worker's wallet.

**[Try ask2human](https://ask2human.me)** · **[See a completed task](https://ask2human.me/tasks/35dc7c07-3a92-4374-be37-d404aedbfbe7)** · **[See the worker's review](https://ask2human.me/workers/a17b1a5f-f5b7-4b74-884f-87bdbbadd2f4)** · **[Read the testing proof](docs/PROOF_OF_TESTING.md)**

Built for **ETHGlobal Tokyo 2026**. The demo uses real mainnet USDC and World sandbox/staging identities.

## Why use it?

A shop visit, a local price check, or a photo of a public notice can answer a question that an agent cannot resolve online. Today, arranging that work means finding someone, agreeing on payment, collecting evidence, and keeping track of what happened.

ask2human brings those steps into one task:

- **For agents:** an API and MCP connector to post work, find applicants, and follow delivery.
- **For owners:** spending limits, approval of the exact worker and amount, and control over wallet signatures.
- **For workers:** clear terms before starting, a funded reward, and payment to their own wallet.
- **For both sides:** a record of delivery, payment, and reviews. Task details also show the owner's paid-task count and total paid to workers across their agents.

For example, an agent researching local shops could ask a worker to photograph a storefront and confirm its opening hours. This is an example use case; the recorded acceptance tasks below tested the application and payment flow.

## How it works

1. **Set a budget.** The owner signs in with World, links a wallet, and creates a hiring profile with allowed categories and spending limits.
2. **Post a task.** The agent publishes the brief, reward, deadline, and required evidence. The app checks the owner's USDC balance against outstanding listings.
3. **Choose a worker.** A worker completes World verification, links a payout wallet, and applies. The agent selects an applicant.
4. **Fund the work.** The owner confirms the exact hire through a fresh World authentication and signs the escrow transaction. The worker and payment terms are fixed at funding.
5. **Deliver and pay.** The worker uploads private evidence and records delivery. After review, the owner approves and signs payment release. The owner can then leave an onchain rating.

The agreed terms also cover a refund for overdue, undelivered work, a worker payment claim after the review window ends, and a payout split if the owner rejects delivery. These paths have real transaction receipts below.

## Hackathon challenges

Our target challenges are World’s **Best Use of IDKit** and **Best Use of World ID for Agents**, and Sui’s **DeFi & Payments**. See the [official prize descriptions](https://ethglobal.com/events/tokyo2026/prizes). The sections below explain our contribution to each challenge.

### World — Best Use of IDKit

We use World IDKit to check worker uniqueness before allowing a worker to take part. The server verifies the proof and binds enrollment to the worker's wallet.

This gives the marketplace a way to limit duplicate worker accounts. It also separates the human check from customer reviews: a worker can prove uniqueness before they have any work history. It does not prove their skills, location, or the truth of a photo.

### World — Best Use of World ID for Agents

We use World's Human Continuity authentication to recognize the same owner when they return or use another agent profile. Before funding, release, or rejection, the app requires fresh owner authentication and checks an approval tied to the exact task terms.

This gives workers a shared payment history for the owner behind different agents. It also gives the owner a clear approval step when an agent requests a payment action. The agent's API key cannot sign a payment, and World authentication does not replace the owner's wallet signature.

Public task details show a pseudonymous owner handle and payment history. They do not expose a legal name or the private World identifier.

### Sui — DeFi & Payments

We use the existing **t2000 escrow and reputation contracts on Sui mainnet**. The reward is funded before work begins. Delivery, release, refund, timeout claims, rejection splits, and ratings have recorded onchain outcomes.

Workers receive USDC directly, with no separate platform withdrawal. Owners and workers can check the receipts, while the app shows the actual worker payout after fees.

Our contribution is the marketplace around those contracts: agent tools, human verification, owner approvals, worker selection, private evidence, and payment accounting. We reused t2000's SDK and deployed contracts; we did not publish a new escrow contract for this MVP.

## Proof: real USDC transactions

On **26 September 2026**, we tested five funded scenarios on Sui mainnet, using **0.07 USDC in total**. Small amounts let us test real settlement without a large demo budget. Every link below opens a mainnet transaction.

| Scenario | Transaction receipts | Confirmed result |
| --- | --- | --- |
| SDK payment trial | [Fund](https://suiscan.xyz/mainnet/tx/2ro9FmmyLesq2tfAyE8vbTfURwJK6DRWaKo7QU2xpN27) · [Deliver](https://suiscan.xyz/mainnet/tx/6bqaD4nErNHyk1Pz7XNYjuSJbL5yQWnquww5m3EaPKhR) · [Release](https://suiscan.xyz/mainnet/tx/BRtuUhBkXbQSKYkFy6fpc6ke4gsMVSp3Bvg57Q7pfLCD) | 0.02 USDC funded; worker received 0.019 USDC. |
| Deployed marketplace task | [Fund](https://suiscan.xyz/mainnet/tx/G9Rw8zXHqSkDPZVvguWUr1CMEN84P3kqFqzU5jYj4V6J) · [Deliver](https://suiscan.xyz/mainnet/tx/5QHWc3mz6sUB3Zd4PtrYToVu4EJft3xDSrWnrBjHpp61) · [Release](https://suiscan.xyz/mainnet/tx/B5sCpoeaUp5BHgq3GJT8v1WH1HTuUbg94NoZ1m2XTBTL) · [Rate](https://suiscan.xyz/mainnet/tx/e9XGA6A4XUg2oeGWNqGeeuQ3saQiJppr4oiSEc6iSDQ) | 0.02 USDC funded; worker received 0.019 USDC and a confirmed five-star review. |
| Overdue refund | [Fund](https://suiscan.xyz/mainnet/tx/48Vxpy2Kyu5fJ4osCSay6YXRHiQZ6JTeKAZ5xeynMYty) · [Refund](https://suiscan.xyz/mainnet/tx/2teN5NvJg84a9LcyREhjpzUBzTQfYHahzfEz41NfQPbp) | Owner recovered 0.01 USDC. No worker payout or protocol fee. |
| Worker claim after review timeout | [Fund](https://suiscan.xyz/mainnet/tx/AQ16oYQNkfxxQ8Rrs4Zk2L2fZM7rfjWmoGkU617ey4Hq) · [Deliver](https://suiscan.xyz/mainnet/tx/DHW9VETTfhkS4tSihHZrxfP5fZ6Gb3dBAs9bB61CDUX8) · [Claim](https://suiscan.xyz/mainnet/tx/ExPw3dAQaMzBQ8g4M3cYZfpdw6WKoLCZEQZA1Bndj6Uh) | Worker received 0.0095 USDC after the trial's 60-second review window, without another owner release approval. |
| Agreed rejection split | [Fund](https://suiscan.xyz/mainnet/tx/5ZV8fAhwYeNHb1tLNi6iD4pQVtpXL1h1X7xAvQtZNG8t) · [Deliver](https://suiscan.xyz/mainnet/tx/G4cN4cBooTT3xr7U3coTd5ptf8XAuk8yQ8EPPq3hMCt6) · [Reject](https://suiscan.xyz/mainnet/tx/31Xnd2Hhs3s3TDfe4XHPNTgfWPbgWYfvQuscQznZwP8a) | From 0.01 USDC: owner received 0.005, worker 0.00475, and protocol 0.00025. |

The SDK trial also has receipts for [worker gas funding](https://suiscan.xyz/mainnet/tx/ELfWeQ1RB9wYrGTLmkjGQPRE7yo6Vi1dxAnWrd5PLTNA) and [reputation setup](https://suiscan.xyz/mainnet/tx/GEs7E5k7nrEpRGTszQSrRNWCzQbxQypSgR6FFL2u6aut).

Separate checks matched chain receipts to application balances, earnings, and reviews. Repeating settlement confirmation did not send another payment. Early refund and timeout requests were blocked. Private evidence was available to the task participants and denied to anonymous visitors. The [full proof record](docs/PROOF_OF_TESTING.md) separates chain receipts from API, database, browser, and storage checks.

**Demo limits:** World identity checks use sandbox/staging. Mainnet transactions were signed through a controlled local test harness; they do not prove that Slush browser signing works end to end. That browser-wallet test and the final demo recording remain pending. Evidence is reviewed offchain; the app does not prove physical presence or provide onchain arbitration.

## Technical details

### Architecture

| Part | Implementation |
| --- | --- |
| Web app and API | Next.js 16, React 19, TypeScript; hosted on Vercel |
| Database | PostgreSQL on Neon; tasks, approvals, budgets, and settlement records |
| Worker identity | World IDKit v4; proof verification on the server |
| Owner identity | World Human Continuity OIDC; one-use callbacks and fresh, task-bound approvals |
| Wallets | Mysten dApp Kit, Wallet Standard, and Slush integration |
| Payments and reviews | Pinned `@t2000/sdk` 11.7.0; existing Sui mainnet contracts |
| Evidence | Private S3 objects with authorized, signed reads |
| Agent connection | Scoped HTTP API and a local stdio MCP connector |

Wallets hold signing authority. The deployed app and MCP connector do not hold wallet private keys. Transaction bytes are saved before signing, and confirmed receipts are checked before updating payment records. Amounts use integer USDC atomic units: **1 USDC = 1,000,000 units**.

A hiring profile stores an agent's permissions and budget; it does not create or run an AI. The external agent decides when to check applicants and call tools. There is no built-in scheduler or outbound notification service.

### Connect an agent

Create a hiring profile at [ask2human.me/agents](https://ask2human.me/agents), authorize its limits, and save its scoped API key privately. Then install the connector from this repository:

```sh
npm ci --prefix mcp
npm test --prefix mcp
```

Configure your MCP client to run `node /absolute/path/to/ask2human/mcp/bin/ask2human-mcp.js` with `ASK2HUMAN_API_KEY` in its environment. It calls `https://ask2human.me` by default. The connector is installed from source; it is not published on npm.

See the [MCP setup guide](mcp/README.md), [API reference](docs/API.md), and [agent example](scripts/agent-example.ts). Owner approval and wallet signing stay in the browser flow.

### Run locally

Use Node.js 22 or newer and Docker. For a new checkout, copy `.env.example` to `.env` and configure the services. Keep secrets out of Git. Preserve an existing `.env` and database volume.

```sh
npm ci
docker compose up -d db
npm run db:migrate
npm run dev
```

The app runs at `http://127.0.0.1:3001`.

```sh
npm run typecheck
npm test
npm run build
```

Some integration tests require separately configured services. A skipped test is not evidence that its live flow passed. Use the [acceptance record](docs/ACCEPTANCE.md) for recorded results.

### What we learned

World's owner flow required the correct OIDC client authentication method. Worker staging verification also needed an explicit time window and server token. These steps are documented in the [World integration notes](docs/WORLD.md).

Our feedback for the World tracks:

| Integration | Friction we hit | Suggested improvement |
| --- | --- | --- |
| IDKit | A genuine staging proof was rejected until the verification window and server token were configured. | Put staging activation and expiry checks directly in the first-integration checklist. |
| World ID for Agents | The first token exchange failed because the client authentication method did not match the registration. | Show the registered authentication method alongside a working OIDC client example. |

We recorded successful exchanges and the fixes, but did not measure time to first success.

For payments, a successful transaction and an updated app record are separate steps. Delayed chain reads and interrupted confirmations made receipt recovery important. We kept transaction bytes and checked existing receipts so retries could finish the same payment. See the [t2000 integration notes](docs/T2000.md).

### Reuse and build credits

The frontend adapts the author's earlier [bnbera marketplace](https://github.com/Lem0nTree/bnbera); [source provenance](docs/FRONTEND_SOURCES.md) lists the files and revision. Identity, wallet, and storage integrations use their official SDKs. The older custom testnet escrow remains archived and is not used by this MVP. Do not run the legacy publish or trial scripts for the mainnet demo.

We used Codex for implementation and review, including separate implementation and verification passes. Protocol reuse and automated checks do not amount to an independent security audit; remaining findings are recorded in the [platform report](docs/PLATFORM_REPORT.md).

## Further reading

- [Hiring workflow](docs/HIRING_WORKFLOW.md)
- [Proof of testing and every transaction receipt](docs/PROOF_OF_TESTING.md)
- [Current implementation and remaining checks](docs/DEVELOPMENT_CHECKLIST.md)
- [World identity integration](docs/WORLD.md)
- [t2000 payment integration](docs/T2000.md)
- [Deployment guide](docs/DEPLOYMENT.md)
- [Submission checklist](docs/SUBMISSION.md)
