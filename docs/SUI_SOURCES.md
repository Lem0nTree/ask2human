> Historical implementation record: the revised MVP uses t2000 mainnet USDC and Slush. Do not publish or fund the custom testnet escrow as part of the current plan. Follow [the revised plan](HACKATHON_COMPLETION_PLAN.md) and [live checklist](DEVELOPMENT_CHECKLIST.md).

# Sui implementation sources

SDK/API behavior was checked against the official Mysten Labs TypeScript SDK documentation and the installed `@mysten/sui` 2.33.1 package on 25 September 2026.

- [Sui gRPC client](https://sdk.mystenlabs.com/sui/clients/grpc) documents `SuiGrpcClient`, the testnet network name, and full-node configuration. The integration uses this v2 client rather than deprecated JSON-RPC APIs.
- [Building transactions](https://sdk.mystenlabs.com/sui/transactions/building) and [signing and execution](https://sdk.mystenlabs.com/sui/transactions/signing-and-execution) document transaction composition, SDK resolution/building, signing, and execution. The adapter freezes the built transaction bytes and digest before signing.
- [Sui SDK overview and faucet guide](https://sdk.mystenlabs.com/sui) lists official network/faucet endpoints and notes that testnet faucets are rate limited.
- Mysten Labs' [shared-object escrow example](https://github.com/MystenLabs/sui/blob/main/examples/trading/contracts/escrow/sources/shared.move) is licensed Apache-2.0. Its `Escrow` is an atomic object swap, not paid-task escrow. This package reuses only the general shared-object and transaction-sender authorization pattern as a design reference; it does not copy the example's implementation. The Move source retains an attribution comment, and this notice records the source and its different purpose.
- The [Sui framework transfer documentation](https://github.com/MystenLabs/sui/blob/main/crates/sui-framework/docs/sui/transfer.md) documents shared-object transfer semantics. The package's pinned framework dependency is the `testnet-v1.80.1` tag used by Sui CLI 1.80.1 for the build/test run.

The custom escrow logic and tests are original MIT-licensed project code. The Sui SDK and CLI remain under their upstream licenses; this repository does not vendor either one.
