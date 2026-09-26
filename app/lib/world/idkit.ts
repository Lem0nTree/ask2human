import "server-only";

import { hashSignal } from "@worldcoin/idkit-core/hashing";
import { signRequest } from "@worldcoin/idkit-core/signing";
import type { RpContext } from "@worldcoin/idkit-core";
import { WorldIntegrationError } from "./errors";

export type WorldIdKitEnvironment = "production" | "staging" | "sandbox";

export interface CreateWorkerIdKitRequestInput {
  appId: string;
  rpId: string;
  signingKeyHex: string;
  action: string;
  environment: WorldIdKitEnvironment;
  /** Server-derived, request-scoped binding value. It is sent to the client for IDKit to hash. */
  signal: string;
}

export interface WorkerIdKitRequest {
  app_id: `app_${string}`;
  action: string;
  environment: WorldIdKitEnvironment;
  signal: string;
  rp_context: RpContext;
  allow_legacy_proofs: false;
}

/** Create a short-lived RP request for the authenticated worker. Keep signingKeyHex server-side. */
export function createWorkerIdKitRequest(
  input: CreateWorkerIdKitRequestInput,
): WorkerIdKitRequest {
  if (
    !/^app_[A-Za-z0-9_-]+$/.test(input.appId) ||
    !/^rp_[A-Za-z0-9_-]+$/.test(input.rpId) ||
    !requireNonEmptyString(input.signingKeyHex) ||
    !requireNonEmptyString(input.action) ||
    !input.action.trim() ||
    !requireNonEmptyString(input.signal) ||
    !input.signal.trim() ||
    !["production", "staging", "sandbox"].includes(input.environment)
  ) {
    throw new WorldIntegrationError("configuration");
  }

  let signature: ReturnType<typeof signRequest>;
  try {
    signature = signRequest({
      signingKeyHex: input.signingKeyHex,
      action: input.action,
    });
  } catch {
    throw new WorldIntegrationError("configuration");
  }

  return {
    app_id: input.appId as `app_${string}`,
    action: input.action,
    environment: input.environment,
    signal: input.signal,
    rp_context: {
      rp_id: input.rpId,
      nonce: signature.nonce,
      created_at: signature.createdAt,
      expires_at: signature.expiresAt,
      signature: signature.sig,
    },
    allow_legacy_proofs: false,
  };
}

export interface VerifyWorkerIdKitResultInput {
  rpId: string;
  expectedAction: string;
  expectedEnvironment: WorldIdKitEnvironment;
  expectedNonce: string;
  expectedSignal: string;
  /** Server-only token issued for World's temporary staging verification window. */
  stagingVerificationToken?: string;
  /** Untrusted JSON received from the client. Forwarded unchanged after local binding checks. */
  idkitResult: unknown;
  fetcher?: typeof fetch;
}

export interface VerifiedWorkerIdentity {
  /** Lowercase RP-scoped 256-bit uniqueness nullifier. Store privately and deduplicate with action. */
  nullifier: string;
  action: string;
  environment: WorldIdKitEnvironment;
  signalHash: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isProofWord(value: unknown): value is string {
  // Genuine v4 simulator responses serialize these words as decimal strings.
  // Keep the original encoding for World; accept either integer wire format.
  if (typeof value !== "string" || !/^(?:0x[0-9a-f]{1,64}|[0-9]{1,78})$/i.test(value)) return false;
  return BigInt(value) < (1n << 256n);
}

function validateUniquenessResult(
  input: VerifyWorkerIdKitResultInput,
): { nullifier: string; signalHash: string } {
  if (
    !/^rp_[A-Za-z0-9_-]+$/.test(input.rpId) ||
    !requireNonEmptyString(input.expectedAction) ||
    !input.expectedAction.trim() ||
    !requireNonEmptyString(input.expectedNonce) ||
    !requireNonEmptyString(input.expectedSignal) ||
    !input.expectedSignal.trim() ||
    !["production", "staging", "sandbox"].includes(input.expectedEnvironment)
  ) {
    throw new WorldIntegrationError("configuration");
  }

  const result = input.idkitResult;
  if (
    !isRecord(result) ||
    result.protocol_version !== "4.0" ||
    result.action !== input.expectedAction ||
    result.environment !== input.expectedEnvironment ||
    result.nonce !== input.expectedNonce ||
    !Array.isArray(result.responses) ||
    result.responses.length !== 1
  ) {
    throw new WorldIntegrationError("invalid_proof");
  }

  const proof = result.responses[0];
  if (
    !isRecord(proof) ||
    proof.identifier !== "proof_of_human" ||
    proof.issuer_schema_id !== 1 ||
    !Array.isArray(proof.proof) ||
    proof.proof.length !== 5 ||
    !proof.proof.every(isProofWord) ||
    typeof proof.nullifier !== "string" ||
    !/^0x[0-9a-f]{64}$/i.test(proof.nullifier) ||
    typeof proof.signal_hash !== "string"
  ) {
    throw new WorldIntegrationError("invalid_proof");
  }

  let expectedSignalHash: string;
  try {
    expectedSignalHash = hashSignal(input.expectedSignal);
  } catch {
    throw new WorldIntegrationError("invalid_request");
  }

  if (proof.signal_hash.toLowerCase() !== expectedSignalHash.toLowerCase()) {
    throw new WorldIntegrationError("invalid_proof");
  }

  return {
    nullifier: proof.nullifier.toLowerCase(),
    signalHash: expectedSignalHash.toLowerCase(),
  };
}

/**
 * Verifies the full IDKit v4 response at World's Developer Portal. The verifier response,
 * action, environment, nonce, proof type, and signal binding must all pass before a nullifier
 * is returned. Never log idkitResult or the upstream response body.
 */
export async function verifyWorkerIdKitResult(
  input: VerifyWorkerIdKitResultInput,
): Promise<VerifiedWorkerIdentity> {
  const extracted = validateUniquenessResult(input);
  const fetcher = input.fetcher ?? globalThis.fetch;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (input.expectedEnvironment !== "production") {
    if (!input.stagingVerificationToken) throw new WorldIntegrationError("configuration");
    headers["x-staging-verification-token"] = input.stagingVerificationToken;
  }

  let response: Response;
  try {
    response = await fetcher(
      `https://developer.world.org/api/v4/verify/${encodeURIComponent(input.rpId)}`,
      {
        method: "POST",
        headers,
        body: JSON.stringify(input.idkitResult),
        cache: "no-store",
        signal: AbortSignal.timeout(15_000),
      },
    );
  } catch {
    throw new WorldIntegrationError("verification_unavailable");
  }

  if (!response.ok) {
    if (response.status === 403) {
      const errorBody: unknown = await response.json().catch(() => null);
      if (isRecord(errorBody) && errorBody.code === "environment_not_allowed") {
        throw new WorldIntegrationError("configuration");
      }
    }
    throw new WorldIntegrationError(
      response.status >= 500
        ? "verification_unavailable"
        : "invalid_proof",
    );
  }

  let verification: unknown;
  try {
    verification = await response.json();
  } catch {
    throw new WorldIntegrationError("invalid_response");
  }

  if (
    !isRecord(verification) ||
    verification.success !== true ||
    verification.environment !== input.expectedEnvironment ||
    verification.action !== input.expectedAction ||
    typeof verification.nullifier !== "string" ||
    verification.nullifier.toLowerCase() !== extracted.nullifier ||
    !Array.isArray(verification.results) ||
    verification.results.length !== 1 ||
    !isRecord(verification.results[0]) ||
    verification.results[0].success !== true ||
    verification.results[0].identifier !== "proof_of_human" ||
    typeof verification.results[0].nullifier !== "string" ||
    verification.results[0].nullifier.toLowerCase() !== extracted.nullifier
  ) {
    throw new WorldIntegrationError("invalid_proof");
  }

  return {
    nullifier: extracted.nullifier,
    action: input.expectedAction,
    environment: input.expectedEnvironment,
    signalHash: extracted.signalHash,
  };
}
