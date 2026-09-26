import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { hashSignal } from "@worldcoin/idkit-core/hashing";

// Next.js aliases this marker during server builds. Tests run in Node, so resolve
// the marker to an empty module while importing the server-only adapters.
const serverOnlyTestLoader = `
  export async function resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { url: "data:text/javascript,export%20%7B%7D", shortCircuit: true };
    }
    return nextResolve(specifier, context);
  }
`;
register(`data:text/javascript,${encodeURIComponent(serverOnlyTestLoader)}`, import.meta.url);

const {
  WorldIntegrationError,
  completeWorldAgentsAuthorization,
  verifyWorkerIdKitResult,
} = await import("../app/lib/world/index");
const { isWorldAgentsAuthTimeFresh } = await import("../app/lib/world/agents-oidc");

const expectedSignal = "worker_123";
const expectedSignalHash = hashSignal(expectedSignal);
const nullifier = `0x${"ab".repeat(32)}`;
const action = "worker-enrollment";

function makeIdKitResult(overrides: Record<string, unknown> = {}) {
  return {
    protocol_version: "4.0",
    nonce: "nonce-for-test",
    action,
    environment: "staging",
    responses: [
      {
        identifier: "selfie",
        signal_hash: expectedSignalHash,
        proof: ["0x01", "0x02", "0x03", "0x04", "0x05"],
        nullifier,
        issuer_schema_id: 11,
        sybil_score: 7,
        expires_at_min: 1_800_000_000,
      },
    ],
    integrity_bundle: {
      version: 2,
      signature_format: "apple_app_attest",
      timestamp: 1_700_000_000,
      signature: "a1b2c3",
      jwt: "header.payload.signature",
    },
    ...overrides,
  };
}

function makeVerifyInput(
  overrides: Partial<Parameters<typeof verifyWorkerIdKitResult>[0]> = {},
) {
  return {
    rpId: "rp_test",
    expectedAction: action,
    expectedEnvironment: "staging" as const,
    expectedNonce: "nonce-for-test",
    expectedSignal,
    stagingVerificationToken: "test-staging-token",
    idkitResult: makeIdKitResult(),
    ...overrides,
  };
}

function assertWorldError(code: string) {
  return (error: unknown) =>
    error instanceof WorldIntegrationError && error.code === code;
}

test("IDKit v4 verification forwards the full result and returns only verified identity fields", async () => {
  const idkitResult = makeIdKitResult({ action_description: "Enroll this worker" });
  let forwardedBody: string | undefined;
  const identity = await verifyWorkerIdKitResult(
    makeVerifyInput({
      idkitResult,
      fetcher: async (url, init) => {
        assert.equal(String(url), "https://developer.world.org/api/v4/verify/rp_test");
        assert.equal(init?.method, "POST");
        assert.equal(init?.cache, "no-store");
        assert.equal(new Headers(init?.headers).get("x-staging-verification-token"), "test-staging-token");
        forwardedBody = String(init?.body);
        return Response.json({
          success: true,
          action,
          environment: "staging",
          nullifier,
          results: [{
            identifier: "selfie",
            success: true,
            nullifier,
          }],
        });
      },
    }),
  );

  assert.equal(forwardedBody, JSON.stringify(idkitResult));
  assert.deepEqual(identity, {
    nullifier,
    action,
    environment: "staging",
    credential: "selfie",
    credentialSchema: 11,
    sybilScore: 7,
    signalHash: expectedSignalHash,
  });
  assert.equal("proof" in identity, false);
});

test("IDKit staging token is required for test proofs and never sent for production", async () => {
  await assert.rejects(verifyWorkerIdKitResult(makeVerifyInput({
    stagingVerificationToken: undefined,
  })), assertWorldError("configuration"));
  let calls = 0;
  await assert.rejects(verifyWorkerIdKitResult(makeVerifyInput({
    expectedEnvironment: "production",
    idkitResult: makeIdKitResult({ environment: "production" }),
    fetcher: async (_url, init) => {
      calls++;
      assert.equal(new Headers(init?.headers).has("x-staging-verification-token"), false);
      return Response.json({ success: false }, { status: 400 });
    },
  })), assertWorldError("invalid_proof"));
  assert.equal(calls, 1);
});

test("IDKit distinguishes a closed test window from invalid proofs and provider outages", async () => {
  for (const [response, expectedError] of [
    [Response.json({ code: "environment_not_allowed" }, { status: 403 }), "configuration"],
    [Response.json({ code: "verification_error" }, { status: 403 }), "invalid_proof"],
    [new Response("not JSON", { status: 403 }), "invalid_proof"],
    [Response.json({ code: "environment_not_allowed" }, { status: 503 }), "verification_unavailable"],
  ] as const) {
    await assert.rejects(verifyWorkerIdKitResult(makeVerifyInput({
      fetcher: async () => response,
    })), assertWorldError(expectedError));
  }
});

test("IDKit sandbox authorization uses only the server token and rejects environment substitution", async () => {
  const sandboxResult = makeIdKitResult({
    environment: "sandbox",
    stagingVerificationToken: "untrusted-body-value",
  });
  let calls = 0;
  const fetcher: typeof fetch = async (_url, init) => {
    calls++;
    assert.equal(new Headers(init?.headers).get("x-staging-verification-token"), "test-staging-token");
    assert.equal(init?.body, JSON.stringify(sandboxResult));
    return Response.json({ code: "environment_not_allowed" }, { status: 403 });
  };
  await assert.rejects(verifyWorkerIdKitResult(makeVerifyInput({
    expectedEnvironment: "sandbox", idkitResult: sandboxResult, fetcher,
  })), assertWorldError("configuration"));
  assert.equal(calls, 1);
  await assert.rejects(verifyWorkerIdKitResult(makeVerifyInput({
    expectedEnvironment: "sandbox", idkitResult: sandboxResult,
    stagingVerificationToken: undefined, fetcher,
  })), assertWorldError("configuration"));
  await assert.rejects(verifyWorkerIdKitResult(makeVerifyInput({
    expectedEnvironment: "production", idkitResult: sandboxResult, fetcher,
  })), assertWorldError("invalid_proof"));
  assert.equal(calls, 1);
});

test("IDKit rejects nonce, action, environment, and signal mismatches before calling World", async () => {
  let fetchCalls = 0;
  const fetcher: typeof fetch = async () => {
    fetchCalls += 1;
    return Response.json({ success: true });
  };

  const cases = [
    makeVerifyInput({ expectedNonce: "different-nonce", fetcher }),
    makeVerifyInput({ expectedAction: "different-action", fetcher }),
    makeVerifyInput({ expectedEnvironment: "production", fetcher }),
    makeVerifyInput({ expectedSignal: "different-worker", fetcher }),
    makeVerifyInput({ idkitResult: makeIdKitResult({ protocol_version: "3.0" }), fetcher }),
  ];

  for (const input of cases) {
    await assert.rejects(
      verifyWorkerIdKitResult(input),
      assertWorldError("invalid_proof"),
    );
  }
  assert.equal(fetchCalls, 0);
});

test("Selfie Check requires schema 11, an integrity bundle, and an integer sybil score", async () => {
  const cases = [
    (() => {
      const result = makeIdKitResult();
      result.responses[0].identifier = "proof_of_human";
      return result;
    })(),
    (() => {
      const result = makeIdKitResult();
      result.responses[0].issuer_schema_id = 1;
      return result;
    })(),
    (() => {
      const result = makeIdKitResult();
      delete (result as Record<string, unknown>).integrity_bundle;
      return result;
    })(),
    (() => {
      const result = makeIdKitResult();
      (result.integrity_bundle as Record<string, unknown>).version = 1;
      return result;
    })(),
    (() => {
      const result = makeIdKitResult();
      result.responses[0].sybil_score = 1.5;
      return result;
    })(),
  ];

  for (const idkitResult of cases) {
    await assert.rejects(
      verifyWorkerIdKitResult(makeVerifyInput({
        idkitResult,
        fetcher: async () => { throw new Error("Malformed Selfie Check result must not reach World"); },
      })),
      assertWorldError("invalid_proof"),
    );
  }
});

test("IDKit forwards decimal proof words unchanged but still requires verifier success", async () => {
  const result = makeIdKitResult();
  result.responses[0].proof = ["1", "2", "3", "4", ((1n << 256n) - 1n).toString()];
  let calls = 0;
  await assert.rejects(verifyWorkerIdKitResult(makeVerifyInput({
    idkitResult: result,
    fetcher: async (_url, init) => {
      calls++;
      assert.equal(init?.body, JSON.stringify(result));
      return Response.json({ success: false }, { status: 403 });
    },
  })), assertWorldError("invalid_proof"));
  assert.equal(calls, 1);

  for (const invalidWord of ["-1", "1.5", "1e5", "0x", (1n << 256n).toString()]) {
    result.responses[0].proof[0] = invalidWord;
    await assert.rejects(verifyWorkerIdKitResult(makeVerifyInput({
      idkitResult: result,
      fetcher: async () => { throw new Error("Malformed proof must not reach World"); },
    })), assertWorldError("invalid_proof"));
  }
});

test("IDKit rejects an unsuccessful or mismatched verifier response", async () => {
  for (const verifierResponse of [
    { success: false },
    {
      success: true,
      action,
      environment: "staging",
      nullifier: `0x${"cd".repeat(32)}`,
            results: [{ identifier: "selfie", success: true, nullifier }],
    },
    {
      success: true,
      action,
      environment: "staging",
      nullifier,
      results: [{ identifier: "passport", success: true, nullifier }],
    },
    {
      success: true,
      action: "different-action",
      environment: "staging",
      nullifier,
      results: [{ identifier: "selfie", success: true, nullifier }],
    },
    {
      success: true,
      action,
      environment: "production",
      nullifier,
      results: [{ identifier: "selfie", success: true, nullifier }],
    },
  ]) {
    await assert.rejects(
      verifyWorkerIdKitResult(
        makeVerifyInput({ fetcher: async () => Response.json(verifierResponse) }),
      ),
      assertWorldError("invalid_proof"),
    );
  }
});

const oidcConfig = {
  issuer: "https://sandbox.auth.world.org",
  clientId: "test-client-id",
  clientSecret: "test-client-secret",
  redirectUri: "https://example.com/auth/world/callback",
};

const oidcTransaction = {
  purpose: "protected_approval" as const,
  state: "expected-state",
  nonce: "expected-nonce",
  codeVerifier: "test-code-verifier",
  issuedAt: 1_000,
  expiresAt: 1_600,
  maxAgeSeconds: 300,
};

test("OIDC rejects expired authorization transactions before token exchange", async () => {
  await assert.rejects(
    completeWorldAgentsAuthorization({
      ...oidcConfig,
      transaction: oidcTransaction,
      callbackUrl: "https://example.com/auth/world/callback?state=expected-state&code=one-time-code",
      now: 1_700,
    }),
    assertWorldError("expired_transaction"),
  );
});

test("OIDC rejects mismatched and duplicate state before discovery or token exchange", async () => {
  for (const callbackUrl of [
    "https://example.com/auth/world/callback?state=attacker&code=one-time-code",
    "https://example.com/auth/world/callback?state=expected-state&state=attacker&code=one-time-code",
  ]) {
    await assert.rejects(
      completeWorldAgentsAuthorization({
        ...oidcConfig,
        transaction: oidcTransaction,
        callbackUrl,
        now: 1_200,
      }),
      assertWorldError("invalid_callback"),
    );
  }
});

test("OIDC treats access denial as cancellation and rejects a different callback URI", async () => {
  await assert.rejects(
    completeWorldAgentsAuthorization({
      ...oidcConfig,
      transaction: oidcTransaction,
      callbackUrl: "https://example.com/auth/world/callback?state=expected-state&error=access_denied",
      now: 1_200,
    }),
    assertWorldError("cancelled"),
  );

  await assert.rejects(
    completeWorldAgentsAuthorization({
      ...oidcConfig,
      transaction: oidcTransaction,
      callbackUrl: "https://attacker.example/auth/world/callback?state=expected-state&code=one-time-code",
      now: 1_200,
    }),
    assertWorldError("invalid_callback"),
  );
});

test("OIDC protected approvals reject authentication that predates the fresh flow", () => {
  const protectedTransaction = {
    ...oidcTransaction,
    purpose: "protected_approval" as const,
    issuedAt: 1_200,
    expiresAt: 1_800,
    maxAgeSeconds: 300,
  };
  assert.equal(isWorldAgentsAuthTimeFresh(1_195, protectedTransaction, 1_210), true);
  assert.equal(isWorldAgentsAuthTimeFresh(1_194, protectedTransaction, 1_210), false);

  const initialLoginTransaction = {
    ...protectedTransaction,
    purpose: "owner_login" as const,
  };
  assert.equal(isWorldAgentsAuthTimeFresh(1_194, initialLoginTransaction, 1_210), true);
  assert.equal(isWorldAgentsAuthTimeFresh(800, initialLoginTransaction, 1_210), false);
});
