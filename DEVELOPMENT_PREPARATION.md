# Development preparation

Status checked on 25 September 2026. The Orange Pi is for development only. The finished app will deploy to Vercel; the items below still need completion for an end-to-end demo.

## Prepared

- `.env` is local, private (`0600`), ignored by Git, and has every key in `.env.example`. World IDKit and World ID for Agents values are present, but their credentials have not yet been exercised by an app.
- Local PostgreSQL 17 runs through `docker compose`; its health check and authenticated query pass. `DATABASE_URL` points to this local database.
- AWS profile `ask2agent` authenticates as the dedicated IAM user. The private S3 bucket `ask2agent-bucket-622308589549-eu-north-1-an` is in `eu-north-1`; an object upload and subsequent object lookup succeeded. The policy does not grant bucket-level `HeadBucket` access, which is unnecessary for that object workflow.
- Sui is set to testnet with testnet SUI as the escrow coin. The configured `https://fullnode.testnet.sui.io:443` URL is also the **gRPC** full-node URL; it does not need replacing. Use `SuiGrpcClient` with `baseUrl: process.env.SUI_RPC_URL` and `network: 'testnet'`. The devnet URL is kept for reference. JSON-RPC methods on the public endpoint no longer work; do not use a JSON-RPC client for the payment integration.
- Official Sui Docs MCP is configured globally in Codex as `sui-docs`, with OAuth connected. This MCP provides documentation, not a blockchain wallet or runtime dependency.
- The intended World ID for Agents callback is `https://ask2human.me/auth/world/callback` and must match the sandbox registration exactly.
- Cloudflare is authoritative for `ask2human.me` (`stephane.ns.cloudflare.com` and `watson.ns.cloudflare.com`). No apex A record is published yet. Cloudflare API MCP is configured in Codex with OAuth connected; a fresh Codex session is needed to expose its tools.

## Still needed for the demo

1. After the Vercel project exists, add `ask2human.me` to it and inspect the exact DNS records Vercel requests. Add those records in Cloudflare DNS, then verify the domain and Vercel-managed HTTPS certificate. Do not point DNS at this development machine. Keep Cloudflare records DNS-only while Vercel verifies the domain and issues its certificate.
2. Implement and expose `https://ask2human.me/auth/world/callback` on Vercel before testing World OAuth. Preview deployment URLs need their own registered callback if tested separately.
3. Install the Sui CLI when implementing and publishing the Move escrow. Create separate testnet owner and worker wallet addresses, obtain faucet SUI, deploy the package, then fill `SUI_ESCROW_PACKAGE_ID` in `.env`.
4. Exercise the World sandbox credentials, S3 upload flow, wallet signatures, and escrow fund/release/refund paths from the application.

Sources: [Sui JSON-RPC migration](https://docs.sui.io/develop/accessing-data/json-rpc-migration), [Sui TypeScript SDK 2.0 migration](https://sdk.mystenlabs.com/sui/migrations/sui-2.0/sui), [Sui Docs MCP](https://docs.sui.io/getting-started/sui-mcp-server), [Vercel custom domains](https://vercel.com/docs/domains/set-up-custom-domain).
