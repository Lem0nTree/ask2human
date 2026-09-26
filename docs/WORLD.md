# World identity adapters

`app/lib/world` contains server-only helpers for worker Proof of Human enrollment
and World ID for Agents authentication. The adapters use `@worldcoin/idkit-core`
for IDKit request signatures and signal hashing, and `openid-client` 6.8.8 for
OIDC discovery, authorization-code exchange, PKCE, and ID-token/JWKS validation.
They do not accept identity claims from the browser and do not return proof or
token payloads.

## Worker Proof of Human

Configure `WORLD_ID_APP_ID`, `WORLD_ID_RP_ID`, `WORLD_ID_RP_SIGNING_KEY`,
`WORLD_ID_WORKER_ACTION`, and `WORLD_ID_ENVIRONMENT` on the server. The signing
key stays server-side. Staging/sandbox verification also requires `WORLD_ID_STAGING_VERIFICATION_TOKEN`, kept only on the server. Use `createWorkerIdKitRequest` after authenticating the
worker and creating a one-use challenge. Its returned request contains an
SDK-signed `rp_context` and `allow_legacy_proofs: false`; return that request to
the client without exposing the signing key.

The `signal` must be derived server-side from the worker account being enrolled
(for example, an opaque worker ID). Persist the exact signal, action,
environment, RP nonce, worker binding, and expiry with the challenge. On
completion, pass the full unmodified IDKit result and those expected values to
`verifyWorkerIdKitResult`. The helper rejects a non-v4 response, mismatched
action/environment/nonce/signal, a non-Proof-of-Human or multi-response result,
malformed nullifier/proof, an unsuccessful verifier response, or a mismatch in
the verifier's action, environment, response identifier, or nullifier. It sends
the complete result to World's
[`POST /api/v4/verify/{rp_id}`](https://docs.world.org/api-reference/developer-portal/verify)
endpoint and returns only the verified RP-scoped nullifier and binding metadata.

Store the returned nullifier privately as a numeric 256-bit value and enforce
uniqueness for the intended action in the database. Consume the challenge once
whether verification succeeds or fails. Never log or return the proof, full
IDKit result, nullifier, RP signing key, or verifier response body. A cancelled
or failed client request does not produce a verified identity and leaves worker
activation disabled.

## World ID for Agents OIDC

Configure `WORLD_AGENTS_ISSUER`, `WORLD_AGENTS_CLIENT_ID`,
`WORLD_AGENTS_CLIENT_SECRET`, and `WORLD_AGENTS_REDIRECT_URI` on the server. The
registered token endpoint authentication method is `client_secret_basic`; the adapter explicitly uses `ClientSecretBasic` to match this registration. The
issuer and redirect URI are trusted configuration; the callback must be HTTPS
and exactly match the registered URI. The client secret and transaction values
must remain on the server.

Call `beginWorldAgentsAuthorization` with `purpose: "owner_login"` for initial
owner authentication or `purpose: "protected_approval"` for a fresh approval
step. It discovers the issuer, then returns an authorization URL using the
Authorization Code flow, `openid`, state, nonce, S256 PKCE, `prompt=login`, and
`max_age` (300 seconds by default). Store the returned transaction in a private,
one-use server session or database row with its expiry; send only the URL to the
browser. The transaction has a ten-minute lifetime. Do not put it in a
browser-readable cookie, URL, or client state.

At the callback, load and atomically consume that transaction, then pass it with
the callback URL to `completeWorldAgentsAuthorization`. `openid-client`
validates the authorization response, code exchange, ID-token signature via
discovered JWKS, issuer, audience, expiration, nonce, PKCE, and `auth_time`
freshness. For `protected_approval`, `auth_time` must also be no earlier than
the start of that authorization transaction, allowing at most five seconds of
clock skew; this prevents a recent pre-existing login session from satisfying
a new protected action. Initial `owner_login` uses the normal maximum-age
check. The adapter adds exact issuer/audience/authorized-party checks and
returns only `{ issuer, subject, authTime }`. A provider cancellation is reported
as the safe `cancelled` error code. Invalid callbacks, expired transactions,
failed authentication, and unavailable discovery/exchange fail closed.

The OIDC pair `(issuer, subject)` must be matched to the owner's existing
account by the application. A fresh authentication does not approve a task on
its own: the application must keep the exact task, worker, amount, and expiry in
its server-side approval record and consume that approval once. It also does not
sign or authorize a Sui transaction.

## Sources and live limits

- [IDKit integration guide](https://docs.world.org/world-id/idkit/integrate) —
  server-side RP signing, v4 result format, full-result forwarding, expected
  environment, and nullifier storage.
- [Developer Portal v4 verify API](https://docs.world.org/api-reference/developer-portal/verify)
  — endpoint request and successful response shape.
- [World ID for Agents sandbox documentation](https://sandbox.auth.world.org/docs)
  and the [official agent plugin](https://github.com/worldcoin/world-id-agent-plugin)
  — sandbox issuer and OIDC integration context.
- [`openid-client` documentation](https://github.com/panva/openid-client) —
  maintained OIDC discovery and authorization-code client APIs.

The RP signing check was exercised locally against the installed SDK. A
synthetic invalid proof was rejected by the live v4 verifier with HTTP 400. The World Agents sandbox browser authorization handoff has now been observed. Its token exchange exposed a client authentication mismatch, corrected by selecting `ClientSecretBasic` explicitly. Independent Chromium checks now pass for both owner login and fresh protected approval, including verified identity continuity and authentication freshness. The callback was intercepted before the public app; deployed session/database callback acceptance remains pending. Domain DNS and deployment credentials are configured. Sandbox identities are mock identities, not production proof of
humanity.

## Current v4 staging prerequisite

The browser simulator generates genuine protocol 4.0 `proof_of_human` responses with five decimal proof words. The adapter accepts unsigned decimal or prefixed hexadecimal uint256 words, forwards the original object unchanged, and still requires successful verification from World. Local shape checks do not verify a proof. [Official verifier decoding](https://github.com/worldcoin/developer-portal/blob/main/web/api/v4/verify/uniqueness-proof/verify-v4.ts).

World now gates staging verification with a 24-hour window and a server-only token. Using a dedicated team API key with [Developer Portal MCP](https://docs.world.org/model-context-protocol/developer-portal), call `set_world_id_staging_verification` with the existing app ID and `enabled: true`. Save its returned token privately as `WORLD_ID_STAGING_VERIFICATION_TOKEN`, configure the same secret in Vercel, and redeploy. Reopening rotates the token. Do not send the team API key or token to the browser or include them in logs. The adapter sends the token only for the server-configured test environment; production proofs never receive that header. A closed/expired window fails verification. [Staging enforcement source](https://github.com/worldcoin/developer-portal/blob/main/web/api/v4/verify/staging-access.ts).

Independent probing observed a genuine simulator response but the official verifier returned 403 `environment_not_allowed`. Successful worker verification remains blocked until this window is configured. Do not create a separate staging app: v4 RPs belong to production apps and the explicit window enables controlled simulator testing.

Local setup helper (explicitly opens or renews the window):

```sh
node --env-file=.env scripts/world-staging.mjs --enable
```

It requires `WORLD_DEVELOPER_API_KEY`, the existing app/RP IDs and a configured test environment. It saves the returned token and expiry to the private `.env` without printing the token. The team API key remains local; Vercel receives only the staging verification token.
