import "server-only";

import {
  authorizationCodeGrant,
  buildAuthorizationUrl,
  calculatePKCECodeChallenge,
  ClientSecretBasic,
  discovery,
  randomNonce,
  randomPKCECodeVerifier,
  randomState,
} from "openid-client";
import { WorldIntegrationError } from "./errors";

export type WorldAgentsAuthorizationPurpose = "owner_login" | "protected_approval";

export interface WorldAgentsOidcConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface WorldAgentsAuthorizationTransaction {
  purpose: WorldAgentsAuthorizationPurpose;
  state: string;
  nonce: string;
  codeVerifier: string;
  issuedAt: number;
  expiresAt: number;
  maxAgeSeconds: number;
}

export interface BeginWorldAgentsAuthorizationInput extends WorldAgentsOidcConfig {
  purpose: WorldAgentsAuthorizationPurpose;
  /** Maximum accepted age of auth_time; defaults to five minutes. */
  maxAgeSeconds?: number;
  now?: number;
}

export interface BegunWorldAgentsAuthorization {
  url: string;
  transaction: WorldAgentsAuthorizationTransaction;
}

export interface CompleteWorldAgentsAuthorizationInput extends WorldAgentsOidcConfig {
  callbackUrl: string | URL;
  transaction: WorldAgentsAuthorizationTransaction;
  now?: number;
}

export interface WorldAgentsIdentity {
  issuer: string;
  subject: string;
  authTime: number;
}

const DEFAULT_MAX_AGE_SECONDS = 300;
const TRANSACTION_TTL_SECONDS = 600;
const CLOCK_SKEW_SECONDS = 30;
// A protected action must authenticate after its challenge starts. Keep this
// narrower than the general token clock tolerance so an older World session
// cannot satisfy a newly created approval request.
const FRESH_AUTH_CLOCK_SKEW_SECONDS = 5;

/**
 * Pure freshness policy for an already cryptographically verified auth_time.
 * A protected-approval callback must be newer than the flow start (with only a
 * small clock allowance); initial owner login may reuse a recent auth_time.
 */
export function isWorldAgentsAuthTimeFresh(
  authTime: number,
  transaction: Pick<WorldAgentsAuthorizationTransaction, "purpose" | "issuedAt" | "maxAgeSeconds">,
  now: number,
): boolean {
  if (
    !Number.isSafeInteger(authTime) ||
    !Number.isSafeInteger(now) ||
    !Number.isSafeInteger(transaction.issuedAt) ||
    !Number.isSafeInteger(transaction.maxAgeSeconds)
  ) {
    return false;
  }

  const generalFreshness =
    authTime <= now + CLOCK_SKEW_SECONDS &&
    authTime >= now - transaction.maxAgeSeconds - CLOCK_SKEW_SECONDS;
  if (!generalFreshness) return false;

  return transaction.purpose !== "protected_approval" ||
    authTime >= transaction.issuedAt - FRESH_AUTH_CLOCK_SKEW_SECONDS;
}

function requireNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function normalizeIssuer(value: string): string {
  let issuer: URL;
  try {
    issuer = new URL(value);
  } catch {
    throw new WorldIntegrationError("configuration");
  }

  if (
    issuer.protocol !== "https:" ||
    issuer.username ||
    issuer.password ||
    issuer.search ||
    issuer.hash ||
    (issuer.pathname !== "" && issuer.pathname !== "/")
  ) {
    throw new WorldIntegrationError("configuration");
  }

  return issuer.origin;
}

function validateConfig(config: WorldAgentsOidcConfig): {
  issuer: string;
  redirectUri: string;
} {
  if (!config.clientId || !config.clientSecret) {
    throw new WorldIntegrationError("configuration");
  }

  const issuer = normalizeIssuer(config.issuer);
  let redirect: URL;
  try {
    redirect = new URL(config.redirectUri);
  } catch {
    throw new WorldIntegrationError("configuration");
  }

  if (
    redirect.protocol !== "https:" ||
    redirect.username ||
    redirect.password ||
    redirect.search ||
    redirect.hash
  ) {
    throw new WorldIntegrationError("configuration");
  }

  return { issuer, redirectUri: redirect.toString() };
}

async function discoverClient(config: WorldAgentsOidcConfig) {
  const normalized = validateConfig(config);
  let client;
  try {
    client = await discovery(new URL(normalized.issuer), config.clientId, {
      client_secret: config.clientSecret,
      id_token_signed_response_alg: "RS256",
      require_auth_time: true,
    }, ClientSecretBasic(config.clientSecret));
  } catch {
    throw new WorldIntegrationError("verification_unavailable");
  }

  const metadata = client.serverMetadata();
  if (
    metadata.issuer !== normalized.issuer ||
    !metadata.id_token_signing_alg_values_supported?.includes("RS256") ||
    !metadata.code_challenge_methods_supported?.includes("S256") ||
    !metadata.authorization_endpoint ||
    !metadata.token_endpoint ||
    !metadata.jwks_uri ||
    [metadata.authorization_endpoint, metadata.token_endpoint, metadata.jwks_uri].some(
      (endpoint) => {
        try {
          return new URL(endpoint).protocol !== "https:";
        } catch {
          return true;
        }
      },
    )
  ) {
    throw new WorldIntegrationError("configuration");
  }

  return { client, ...normalized };
}

function validateMaxAge(maxAgeSeconds: number): void {
  if (!Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds < 1 || maxAgeSeconds > 86_400) {
    throw new WorldIntegrationError("configuration");
  }
}

/** Begin either the first owner login or a fresh protected-action authentication. */
export async function beginWorldAgentsAuthorization(
  input: BeginWorldAgentsAuthorizationInput,
): Promise<BegunWorldAgentsAuthorization> {
  if (input.purpose !== "owner_login" && input.purpose !== "protected_approval") {
    throw new WorldIntegrationError("invalid_request");
  }

  const { client, redirectUri } = await discoverClient(input);
  const maxAgeSeconds = input.maxAgeSeconds ?? DEFAULT_MAX_AGE_SECONDS;
  validateMaxAge(maxAgeSeconds);

  const state = randomState();
  const nonce = randomNonce();
  const codeVerifier = randomPKCECodeVerifier();
  const codeChallenge = await calculatePKCECodeChallenge(codeVerifier);
  const now = input.now ?? Math.floor(Date.now() / 1000);
  const transaction: WorldAgentsAuthorizationTransaction = {
    purpose: input.purpose,
    state,
    nonce,
    codeVerifier,
    issuedAt: now,
    expiresAt: now + TRANSACTION_TTL_SECONDS,
    maxAgeSeconds,
  };

  const url = buildAuthorizationUrl(client, {
    client_id: input.clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid",
    state,
    nonce,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    prompt: "login",
    max_age: String(maxAgeSeconds),
  });

  return { url: url.toString(), transaction };
}

function onlyOneQueryValue(url: URL, name: string): string | null {
  const values = url.searchParams.getAll(name);
  if (values.length > 1) {
    throw new WorldIntegrationError("invalid_callback");
  }
  return values[0] ?? null;
}

/** Exchange the authorization code and return only the verified pairwise owner identity. */
export async function completeWorldAgentsAuthorization(
  input: CompleteWorldAgentsAuthorizationInput,
): Promise<WorldAgentsIdentity> {
  const { issuer, redirectUri } = validateConfig(input);
  const transaction = input.transaction;
  const now = input.now ?? Math.floor(Date.now() / 1000);

  if (
    !transaction ||
    typeof transaction !== "object" ||
    !requireNonEmptyString(transaction.state) ||
    !requireNonEmptyString(transaction.nonce) ||
    !requireNonEmptyString(transaction.codeVerifier) ||
    !Number.isSafeInteger(transaction.issuedAt) ||
    !Number.isSafeInteger(transaction.expiresAt) ||
    !Number.isSafeInteger(transaction.maxAgeSeconds) ||
    (transaction.purpose !== "owner_login" && transaction.purpose !== "protected_approval")
  ) {
    throw new WorldIntegrationError("invalid_request");
  }
  if (!Number.isSafeInteger(now)) {
    throw new WorldIntegrationError("invalid_request");
  }
  validateMaxAge(transaction.maxAgeSeconds);
  if (
    now > transaction.expiresAt ||
    transaction.expiresAt - transaction.issuedAt !== TRANSACTION_TTL_SECONDS ||
    transaction.issuedAt > now + CLOCK_SKEW_SECONDS ||
    transaction.expiresAt < transaction.issuedAt
  ) {
    throw new WorldIntegrationError("expired_transaction");
  }

  let callbackUrl: URL;
  try {
    callbackUrl = new URL(input.callbackUrl);
  } catch {
    throw new WorldIntegrationError("invalid_callback");
  }
  if (
    callbackUrl.protocol !== "https:" ||
    callbackUrl.username ||
    callbackUrl.password ||
    callbackUrl.hash ||
    `${callbackUrl.origin}${callbackUrl.pathname}` !==
      `${new URL(redirectUri).origin}${new URL(redirectUri).pathname}`
  ) {
    throw new WorldIntegrationError("invalid_callback");
  }

  const state = onlyOneQueryValue(callbackUrl, "state");
  const code = onlyOneQueryValue(callbackUrl, "code");
  const providerError = onlyOneQueryValue(callbackUrl, "error");
  const responseIssuer = onlyOneQueryValue(callbackUrl, "iss");
  if (state !== transaction.state || (code && providerError)) {
    throw new WorldIntegrationError("invalid_callback");
  }
  if (responseIssuer !== null && responseIssuer !== issuer) {
    throw new WorldIntegrationError("invalid_callback");
  }
  if (providerError) {
    throw new WorldIntegrationError(
      providerError === "access_denied" ? "cancelled" : "authentication_failed",
    );
  }
  if (!code) {
    throw new WorldIntegrationError("invalid_callback");
  }

  const { client } = await discoverClient(input);
  let tokens;
  try {
    tokens = await authorizationCodeGrant(
      client,
      callbackUrl,
      {
        expectedState: transaction.state,
        expectedNonce: transaction.nonce,
        pkceCodeVerifier: transaction.codeVerifier,
        maxAge: transaction.maxAgeSeconds,
        idTokenExpected: true,
      },
    );
  } catch {
    throw new WorldIntegrationError("authentication_failed");
  }

  const claims = tokens.claims();
  if (!claims) {
    throw new WorldIntegrationError("authentication_failed");
  }
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  const authTime = claims.auth_time;
  const expiresAt = claims.exp;
  if (
    claims.iss !== issuer ||
    !requireNonEmptyString(claims.sub) ||
    !audience.includes(input.clientId) ||
    (claims.azp !== undefined && claims.azp !== input.clientId) ||
    (audience.length > 1 && claims.azp !== input.clientId) ||
    claims.nonce !== transaction.nonce ||
    typeof authTime !== "number" ||
    typeof expiresAt !== "number" ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= now ||
    !isWorldAgentsAuthTimeFresh(authTime, transaction, now)
  ) {
    throw new WorldIntegrationError("authentication_failed");
  }

  return { issuer, subject: claims.sub, authTime };
}
