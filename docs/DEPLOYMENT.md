# Vercel deployment

The application deploys to Vercel with Neon PostgreSQL in Singapore (`sin1`). Neon Auth is disabled: World and the application sessions provide identity. Private evidence remains in the existing S3 bucket.

## Current setup

The local checkout is linked to the user's `ask2human` Vercel project, which is connected to GitHub and Neon. `vercel.json` selects Next.js, `npm ci`, `npm run build`, and Singapore. The apex `ask2human.me` is attached to the project and Cloudflare has a DNS-only record using a Vercel-supplied target. Vercel has verified the DNS configuration; HTTPS/application acceptance is tracked in [the live checklist](DEVELOPMENT_CHECKLIST.md).

## Database

Runtime uses `ASK2HUMAN_DATABASE_URL` when configured, otherwise `DATABASE_URL`. The explicit production override is populated privately from the user's tested Neon pooled URL; it avoids depending on managed integration values that the CLI could not resolve for verification. Keep the override current when rotating Neon credentials. Keep a small process pool; the PostgreSQL client disables prepared statements for pooling compatibility. Local `.env` retains the local development `DATABASE_URL` and a separate `NEON_DATABASE_URL` for hosted checks. Do not set the production override in local test environments.

Apply migrations once as a controlled deployment operation, using the direct hosted URL:

```sh
MIGRATE_HOSTED=1 npm run db:migrate
```

This loads local `.env` and selects `DATABASE_URL_UNPOOLED` explicitly. Without `MIGRATE_HOSTED=1`, the migration runner uses `DATABASE_URL`. Migration `006` adds profile authorization records and challenges. Apply it before deploying the signed-profile posting flow; existing profiles require a one-time wallet signature from `/agents` before they can publish new tasks. Do not run migrations on every function invocation. Never run destructive tests against the public schema; use isolated local test schemas.

On this development server, Node's automatic address-family selection timed out against the Singapore endpoint while an IPv4-first connection succeeded. The local migration can be run with the following process-scoped options; TLS and authentication remain enabled:

```sh
NODE_OPTIONS='--no-network-family-autoselection --dns-result-order=ipv4first' MIGRATE_HOSTED=1 npm run db:migrate
```

This is a local connection workaround, not a required Vercel environment setting.

## Private environment

Configure production server variables from `.env.example`, using an explicit allowlist. The required groups are:

- `APP_URL=https://ask2human.me` and `SESSION_SECRET`.
- World worker app/RP/action/environment and private signing key.
- World Agents issuer/client/secret and `WORLD_AGENTS_REDIRECT_URI=https://ask2human.me/auth/world/callback`.
- `SUI_NETWORK=mainnet`, the mainnet gRPC URL, and the verified `T2000_AGENT_REGISTRY_ID` required for rejection. t2000's pinned SDK supplies its mainnet contract/token references; custom testnet publication is paused.
- Actual S3 region/bucket and the least-privilege AWS credential provider. A local `AWS_PROFILE` does not travel to Vercel.

Never deploy owner/worker wallet private keys. They are local inputs to bounded trial scripts only. Browser users connect Slush or another Wallet Standard wallet and sign their own messages/transactions. Never prefix server secrets with `NEXT_PUBLIC_`. `.vercelignore` excludes all `.env` files from source uploads.

Use provider private settings or CLI stdin for credentials; do not place secret values in command arguments, reports or Git. Verify downloaded production values in memory and remove temporary private files afterward.

## Release and acceptance

Build/type checks and relevant tests precede deployment. CLI deployment is available without creating a Git commit:

```sh
npx vercel@latest --prod
```

Run `node scripts/deployment-smoke.mjs https://ask2human.me` to verify public routes, database-backed session persistence, secure cookies and authorization/CSRF denials. It creates only an anonymous session.

Use the stable custom domain for World authentication. Check anonymous access on that domain, secure session cookies, same-origin CSRF-protected form actions, both World callback flows, wallet signing, and private evidence uploads. Vercel login protection must not block the intended public demo domain; previews can remain protected.

The evidence upload accepts one image up to 4 MiB and limits multipart overhead below the hosting request limit. Verify the deployed upload, not just local S3 access. Do not make the bucket public to repair an upload failure.

Do not claim the deployment or mainnet flow passed until the corresponding checklist evidence exists. Event sandbox identity and real mainnet settlement must be labelled separately.

Sources: [Vercel regions](https://vercel.com/docs/functions/configuring-functions/region), [Vercel project configuration](https://vercel.com/docs/project-configuration/vercel-json), [World Agents sandbox](https://sandbox.auth.world.org/docs), [Slush wallet integration](https://sdk.mystenlabs.com/slush-wallet/dapp).

### World staging window

For the hackathon staging identity demonstration, configure `WORLD_ID_STAGING_VERIFICATION_TOKEN` privately in Vercel after opening the 24-hour window using the [World setup helper](WORLD.md). Keep `WORLD_DEVELOPER_API_KEY` local. Never forward the token to browser code, and do not change a proof's environment to evade the verifier's environment checks. Renewing the window rotates the token and requires a new deployment with the updated value.

### Slush wallet verification

Server wallet binding uses the SDK personal-message verifier with an explicit mainnet gRPC client and expected wallet address. The installed Sui SDK 2.33 requires the client to verify zkLogin signatures used by social-login wallets; do not rely on older documentation describing an implicit mainnet endpoint. The SDK also checks standard and legacy address variants. See [Sui SDK migration guidance](https://sdk.mystenlabs.com/sui/migrations/sui-2.0/sui) and the installed SDK `src/zklogin/publickey.ts`.
