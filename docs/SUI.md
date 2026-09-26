> Historical implementation record: the revised MVP uses t2000 mainnet USDC and Slush. Do not publish or fund the custom testnet escrow as part of the current plan. Follow [the revised plan](HACKATHON_COMPLETION_PLAN.md) and [live checklist](DEVELOPMENT_CHECKLIST.md).

# Sui testnet escrow

The app's minimal escrow is in `contracts/sui_escrow`. It pays native SUI to a worker address fixed when a job is created. The brief and worker submission are represented by 32-byte hashes; the task description and submitted work stay offchain.

The shared `Job` holds a `Balance<SUI>`, funder, worker, brief hash, deadline, and optional commitment hash. Creation requires a positive amount, a 32-byte brief hash, and a future deadline. Only the fixed worker can submit one 32-byte commitment, strictly before the deadline. Only the funder can release after a submission, or refund at/after the deadline while no submission exists. Release and refund consume and delete the shared job, so they cannot both settle the same job.

The module emits `JobCreated`, `WorkSubmitted`, `JobReleased`, and `JobRefunded` events with the public fields needed for backend reconciliation. `app/lib/sui/escrow.ts` validates successful finalized transactions, sender/actor and package/module/event type, then decodes event BCS. An API must still compare the event fields to its persisted task, wallet, amount, deadline, and expected digest; a client assertion or transaction builder is not proof of funding.

The app uses `@mysten/sui` 2.33.1 and `SuiGrpcClient`. The default endpoint is `https://fullnode.testnet.sui.io:443`; set `SUI_RPC_URL` to another Sui gRPC full-node endpoint when needed. Every publish/trial script checks the endpoint's chain identifier and stops unless it is Sui testnet.

## Build and test

Install the Sui CLI outside the repository. Give Move commands a pre-created testnet CLI config with an empty keystore so CLI startup cannot create an unrelated wallet. In the example below, `SUI_CLI_CONFIG` points to that config file.

```sh
sui move --client.config "$SUI_CLI_CONFIG" build --force \
  --install-dir contracts/sui_escrow --path contracts/sui_escrow
sui move --client.config "$SUI_CLI_CONFIG" test --force \
  --path contracts/sui_escrow
npx tsx scripts/sui-escrow-test.ts
```

The Move suite covers successful release and refund, fixed-worker and funder authorization, deadline rules, refund rejection after submission, early release/refund rejection, and rejection of a second settlement. The TypeScript test checks transaction builders and BCS receipt parsing.

## Development wallets and testnet trial

`npx tsx scripts/sui-wallets.ts` creates fresh independent owner and worker Ed25519 wallets under `/home/pi/.config/ask2human` (or `SUI_DEV_WALLET_DIR`). It prints only public addresses and writes the Bech32 keys as mode-0600 files inside a mode-0700 directory. Keep that directory outside the repository and do not display the key files.

Fund the owner address with at least `500000000` MIST from the Sui testnet faucet before publishing. Testnet faucets are rate limited; the current official options are listed in the [SDK faucet guide](https://sdk.mystenlabs.com/sui). The publish script checks balance before it builds a transaction and does not request funds. It publishes the compiled `job_escrow` module and transfers the package upgrade capability to the owner. It prints only the package ID, public owner address, and publication digest.

```sh
npm run sui:publish
# Set the returned package ID in the private .env, then:
npm run sui:trial
```

The trial funds worker gas from the owner wallet if needed, creates and funds a job, signs and submits a worker commitment, releases funds as the owner, then creates a separate short-deadline job and refunds it after expiry. It checks finalized event receipts and expected public task terms. It prints public addresses, object IDs, and transaction digests only. Do not set a mainnet endpoint or use mainnet funds.

`buildCreateAndFundTx`, `buildSubmitTx`, `buildReleaseTx`, and `buildRefundTx` return SDK `Transaction`s. `resolveEscrowTxForSigning` freezes a transaction with resolved shared-object refs and gas fields, and returns its digest and base64 transaction bytes; persist these together and require the confirmed digest to match. `validateEscrowReceipt` returns the decoded fields for backend reconciliation. `amountMist` and `deadlineMs` are decimal strings; hashes are 32-byte `Uint8Array`s or `0x`-prefixed 32-byte hex strings.

## Live trial status

As of 25 September 2026, the Move build and all 10 Move tests pass, and the SDK builder/receipt checks pass. A testnet publish has not completed: the official faucet returned HTTP 429 before funding the newly generated owner wallet. The publisher and complete release/refund trial are ready to rerun after that owner wallet has testnet SUI. No package ID or live escrow digest exists yet.

On 26 September 2026 the owner balance was checked again and was still zero. The development owner's public address is `0xeb049c954eef45d25bf3eae2f50951a314603b609af61b4dd0a8534aaa40853b`. Request testnet funds through the [official Sui faucet](https://faucet.sui.io/), selecting testnet. The existing private keys remain outside the repository; keep them for the subsequent publication and trial.
