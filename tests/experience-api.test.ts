import assert from "node:assert/strict";
import test from "node:test";
import { assertFrozenDigestMatch, canCancelUnfundedTask, canRefreshFundingApproval, deliveryPrerequisitesReady, formatAtomic, isApprovalCurrent, isNoTransactionScoreReady, MAINNET_USDC, ownerFundingAction, parseAtomic, paymentStageFromBuildState, pendingPrerequisiteRecovery, taskTermsFromForm, walletBuildInput, workerSharePercent, worldCheckBadge, worldCheckStatus, worldEnvironmentDisclosure, type ExperienceAsset } from "../app/lib/client/experience-api";
import { actionSchema } from "../app/lib/server/schemas";

test("new task amounts use the canonical six-decimal mainnet USDC coin", () => {
  assert.equal(MAINNET_USDC.network, "mainnet");
  assert.equal(MAINNET_USDC.decimals, 6);
  assert.equal(MAINNET_USDC.coinType, "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC");
  assert.equal(parseAtomic("1.234567", MAINNET_USDC), "1234567");
  assert.equal(parseAtomic("12", MAINNET_USDC), "12000000");
  assert.equal(formatAtomic("1234500", MAINNET_USDC), "1.2345 USDC");
  assert.throws(() => parseAtomic("0.000000", MAINNET_USDC));
  assert.throws(() => parseAtomic("1.0000001", MAINNET_USDC));
  assert.throws(() => parseAtomic("1e2", MAINNET_USDC));
  assert.throws(() => parseAtomic("01.5", MAINNET_USDC));
});

test("legacy nine-decimal assets keep their own read-only display scale", () => {
  const legacySui: ExperienceAsset = { symbol: "SUI", coinType: "0x2::sui::SUI", decimals: 9, network: "testnet" };
  assert.equal(parseAtomic("0.000000001", legacySui), "1");
  assert.equal(formatAtomic("1500000000", legacySui), "1.5 SUI");
});

test("task review and rejection terms convert user units to API units", () => {
  assert.deepEqual(taskTermsFromForm("5", "50"), { reviewWindowMs: 300_000, rejectSplitBps: 5_000 });
  assert.deepEqual(taskTermsFromForm("720", "100"), { reviewWindowMs: 43_200_000, rejectSplitBps: 0 });
  assert.deepEqual(taskTermsFromForm("5", "25"), { reviewWindowMs: 300_000, rejectSplitBps: 7_500 });
  assert.equal(workerSharePercent(7_500), 25);
  assert.equal(workerSharePercent(0), 100);
  assert.equal(workerSharePercent(10_000), 0);
  for (const value of ["", "0", "721", "1.5", "-1"]) assert.throws(() => taskTermsFromForm(value, "50"));
  for (const value of ["", "-1", "101", "2.5"]) assert.throws(() => taskTermsFromForm("5", value));
});

test("World labels distinguish staging and sandbox identity checks from production", () => {
  assert.equal(worldEnvironmentDisclosure("staging"), "World staging Selfie Check demo");
  assert.equal(worldEnvironmentDisclosure("sandbox"), "World sandbox Selfie Check demo");
  assert.equal(worldEnvironmentDisclosure("production"), "World production Selfie Check");
  assert.equal(worldEnvironmentDisclosure(null), "World identity environment not configured");
  assert.equal(worldCheckStatus("staging", true), "Staging selfie check passed");
  assert.equal(worldCheckBadge("sandbox", true), "World sandbox check");
  assert.equal(worldCheckBadge(null, true), "World check · environment unknown");
});

test("expired approvals recover safely while issued frozen bytes stay resumable", () => {
  const now = Date.parse("2026-09-26T12:00:00Z");
  assert.equal(isApprovalCurrent({ status: "PENDING", expiresAt: "2026-09-26T11:59:59Z" }, now), false);
  assert.equal(isApprovalCurrent({ status: "APPROVED", expiresAt: "2026-09-26T11:59:59Z" }, now), false);
  assert.equal(isApprovalCurrent({ status: "PENDING", expiresAt: "2026-09-26T12:00:01Z" }, now), true);
  assert.equal(isApprovalCurrent({ status: "ISSUED", expiresAt: "2026-09-25T12:00:00Z" }, now), true);
  assert.equal(isApprovalCurrent({ status: "EXPIRED", expiresAt: "2026-09-27T12:00:00Z" }, now), false);
});

test("owner funding controls expose approval, signing, and renewal at the matching task state", () => {
  assert.equal(ownerFundingAction("ASSIGNED"), "request");
  assert.equal(ownerFundingAction("ASSIGNED", "EXPIRED"), "request");
  assert.equal(ownerFundingAction("ASSIGNED", "PENDING"), null);
  assert.equal(ownerFundingAction("ASSIGNED", "APPROVED"), "sign");
  assert.equal(ownerFundingAction("FUNDING", "ISSUED"), "sign");
  assert.equal(ownerFundingAction("OPEN", "APPROVED"), null);
  assert.equal(ownerFundingAction("FUNDED", "ISSUED"), null);
});

test("owners can refresh an active funding quote only before funding bytes are issued", () => {
  assert.equal(canRefreshFundingApproval("ASSIGNED", "PENDING"), true);
  assert.equal(canRefreshFundingApproval("ASSIGNED", "APPROVED"), true);
  assert.equal(canRefreshFundingApproval("ASSIGNED", "ISSUED"), false);
  assert.equal(canRefreshFundingApproval("FUNDING", "APPROVED"), false);
  assert.equal(canRefreshFundingApproval("OPEN", "PENDING"), false);
});

test("owner cancellation is available only before funding", () => {
  assert.equal(canCancelUnfundedTask("OPEN"), true);
  assert.equal(canCancelUnfundedTask("ASSIGNED"), true);
  for (const state of ["FUNDING", "FUNDED", "SUBMITTED", "PAID", "REFUNDED", "CANCELLED"]) {
    assert.equal(canCancelUnfundedTask(state), false, `${state} must not show unfunded cancellation`);
  }
});

test("selected rating stars are preserved in the strict browser action payload", () => {
  const taskId = "e596fa1b-1a32-4a69-ae21-2c5b302d6e5c";
  const input = walletBuildInput(taskId, { stars: 3 });
  assert.deepEqual(input, { stars: 3, taskId });
  assert.deepEqual(actionSchema.parse({ action: "build_rating", ...input }), { action: "build_rating", taskId, stars: 3 });
  assert.throws(() => actionSchema.parse({ action: "build_rating", ...walletBuildInput(taskId) }));
});

test("prepared wallet retries refuse replacement frozen transaction digests", () => {
  const frozenDigest = `0x${"a".repeat(64)}`;
  assert.doesNotThrow(() => assertFrozenDigestMatch(frozenDigest, frozenDigest));
  assert.throws(() => assertFrozenDigestMatch(frozenDigest, `0x${"b".repeat(64)}`), /different transaction bytes/);
});

test("delivery stays blocked until fee snapshot, fee consent, and seller score are ready", () => {
  const settlement = {
    fundingFeeBps: 375,
    fundingFeeAtomic: "37",
    fundingNetAtomic: "966",
    feeChanged: true,
    feeAcknowledgedAt: null as string | null,
  };
  assert.equal(deliveryPrerequisitesReady(settlement, true), false, "a changed fee requires worker acknowledgement");
  settlement.feeAcknowledgedAt = "2026-09-26T12:00:00.000Z";
  assert.equal(deliveryPrerequisitesReady(settlement, false), false, "the t2000 seller account must be ready before delivery");
  assert.equal(deliveryPrerequisitesReady(settlement, true), true);
  assert.equal(deliveryPrerequisitesReady({ ...settlement, feeChanged: false, feeAcknowledgedAt: null }, true), true, "an unchanged fee needs no extra consent click");
  assert.equal(deliveryPrerequisitesReady(null, true), false, "delivery waits until the finalized fee snapshot is present");
});

test("an already-existing t2000 score is a prerequisite success, not a wallet transaction", () => {
  assert.equal(isNoTransactionScoreReady({ state: "SCORE_READY", alreadyExists: true }), true);
  assert.equal(isNoTransactionScoreReady({ state: "SCORE_FUNDING", transactionBytesBase64: "bytes", expectedDigest: "digest" }), false);
  assert.equal(isNoTransactionScoreReady({ state: "FUNDED" }), false);
});

test("refund signing retries reconcile or discard only a stale score-setup attempt", () => {
  assert.equal(paymentStageFromBuildState("SCORE_FUNDING"), "score_setup");
  assert.equal(paymentStageFromBuildState("FUNDED"), "payment");
  assert.equal(pendingPrerequisiteRecovery("score_setup", "submitted", "payment"), "confirm", "confirm a possibly-landed setup before asking for separate refund consent");
  assert.equal(pendingPrerequisiteRecovery("score_setup", "prepared", "payment"), "clear_and_stop", "never sign refund bytes while resuming a setup-only prompt");
  assert.equal(pendingPrerequisiteRecovery("payment", "prepared", "payment"), null, "actual funding/refund digest matching remains strict");
  assert.equal(pendingPrerequisiteRecovery("legacy", "submitted", "payment"), "confirm", "legacy shared-key records are reconciled conservatively");
});
