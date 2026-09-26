# Hackathon demo runbook

This is the rehearsal and recording sequence, not evidence that the journey has passed. Use the [live checklist](DEVELOPMENT_CHECKLIST.md) and [acceptance record](ACCEPTANCE.md) for observed results.

## Preparation

- Open `https://ask2human.me` in two separate browser profiles: task owner and worker.
- Connect the appropriate Slush/Wallet Standard wallet in each profile. Keep seed phrases and private keys out of recordings, browser consoles and screenshots.
- Use World sandbox identity honestly: the money is real mainnet USDC; the identity demonstration uses the configured sandbox environment.
- Use a harmless, observable task with an explicit acceptance checklist, a small USDC reward, and enough delivery time. Make the agreed review window and rejection split visible before funding.
- Use a dedicated scoped agent API credential. Show the API command and safe response, never its bearer token. Do not place a live token in a terminal recording or script committed to Git.

## Recorded journey

1. **Agent commissions work.** Show the agent dashboard and post a task through the scoped API example. Open its shareable task URL and read the requirements, deadline and payment terms.
2. **Human applies.** In the worker profile, complete World verification and wallet binding. Apply for the task. Explain that an application does not yet assign work or fund escrow.
3. **Agent selects a worker.** List applicants using the agent API, open the selected person's public profile, and select that applicant. Show the fixed recipient and reward.
4. **Owner authorizes and funds.** Complete fresh World approval for the exact task/worker/terms. Review the Slush transaction and sign. Wait for confirmed funding before starting work; show the public chain receipt.
5. **Human delivers.** Upload a small image and written report, inspect the preview, sign the delivery transaction, and wait for confirmation. Evidence remains visible only to authorized participants.
6. **Owner reviews and pays.** View the private delivery from the owner profile, accept it, complete the required fresh approval and sign settlement. Show the final transaction receipt.
7. **Human sees earnings.** Open the worker dashboard. Explain gross reward, protocol fee and actual net received; link the confirmed payment. There is no platform withdrawal step when settlement pays the wallet directly.
8. **Owner rates the work.** Submit an eligible public rating and open the public worker profile with the completed task. Distinguish customer reputation from the World badge.

## Short failure demonstration

Choose one reproducible denial that does not move funds: an unrelated session cannot view private evidence, an unverified worker cannot apply, or an agent credential cannot select another agent's applicant. A cancelled wallet signature must leave a recoverable pending action rather than displaying successful payment.

Record refund, rejection and elapsed-window claim trials separately. A review-window deadline permits a claim transaction; it does not itself execute a payout. Report only paths actually checked.

## Submission assets

- Public application URL and repository URL, once publication is authorized.
- Short demo recording showing the complete journey above.
- One paragraph explaining the use case: agents can delegate observable real-world tasks to verified humans, with explicit human spending approval and verifiable escrow settlement.
- Integration attribution: World IDKit, World ID for Agents, Mysten Sui/dApp Kit/Slush, t2000 SDK/contracts, Neon PostgreSQL and private S3. bnbera is the author's UI source donor, not a continuing product.
- Public transaction receipts and truthful environment labels. Do not claim independent audit coverage that has not been verified.

Creating this runbook does not publish a repository, submit a hackathon entry or assert completion of pending acceptance items.
