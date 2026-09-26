export type ExperienceAsset = {
  symbol: string;
  coinType: string;
  decimals: number;
  network: string;
};

export type WorldIdentityEnvironment = "production" | "staging" | "sandbox" | null;

export function worldEnvironmentDisclosure(environment: WorldIdentityEnvironment): string {
  if (environment === "production") return "World production identity check";
  if (environment === "staging") return "World staging identity demo";
  if (environment === "sandbox") return "World sandbox identity demo";
  return "World identity environment not configured";
}

export function worldCheckStatus(environment: WorldIdentityEnvironment, verified: boolean): string {
  if (!verified) return "Not complete";
  if (environment === "staging") return "Staging uniqueness check passed";
  if (environment === "sandbox") return "Sandbox uniqueness check passed";
  if (environment === "production") return "Uniqueness check passed";
  return "Check recorded · environment unknown";
}

export function worldCheckBadge(environment: WorldIdentityEnvironment, verified: boolean): string {
  if (!verified) return "Not verified";
  if (environment === "staging") return "World staging check";
  if (environment === "sandbox") return "World sandbox check";
  if (environment === "production") return "World check";
  return "World check · environment unknown";
}

export const MAINNET_USDC = {
  symbol: "USDC",
  coinType: "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC",
  decimals: 6,
  network: "mainnet",
} as const satisfies ExperienceAsset;

/** Keep an issued approval visible even after its authorization TTL expires:
 * issued funding/release bytes are immutable and must be resumed, never rebuilt. */
export function isApprovalCurrent(approval: { status: string; expiresAt: string }, now = Date.now()): boolean {
  if (approval.status === "ISSUED") return true;
  if (approval.status !== "PENDING" && approval.status !== "APPROVED") return false;
  const expiresAt = new Date(approval.expiresAt).getTime();
  return Number.isFinite(expiresAt) && expiresAt > now;
}

/** Resolve the owner-facing funding control from task state and the current approval. */
export function ownerFundingAction(taskState: string, approvalStatus?: string): "request" | "sign" | null {
  if (taskState !== "ASSIGNED" && taskState !== "FUNDING") return null;
  if (approvalStatus === "APPROVED" || approvalStatus === "ISSUED") return "sign";
  if (taskState === "ASSIGNED" && !["PENDING", "APPROVED", "ISSUED"].includes(approvalStatus ?? "")) return "request";
  return null;
}

export function canRefreshFundingApproval(taskState: string, approvalStatus?: string): boolean {
  return taskState === "ASSIGNED" && (approvalStatus === "PENDING" || approvalStatus === "APPROVED");
}

export function canCancelUnfundedTask(taskState: string): boolean {
  return taskState === "OPEN" || taskState === "ASSIGNED";
}

export function deliveryPrerequisitesReady(
  settlement: {
    fundingFeeBps: number | null;
    fundingFeeAtomic: string | null;
    fundingNetAtomic: string | null;
    feeChanged: boolean;
    feeAcknowledgedAt: string | null;
  } | null | undefined,
  scoreReady: boolean,
): boolean {
  return !!settlement && settlement.fundingFeeBps != null && settlement.fundingFeeAtomic != null &&
    settlement.fundingNetAtomic != null && (!settlement.feeChanged || !!settlement.feeAcknowledgedAt) && scoreReady;
}

export function isNoTransactionScoreReady(result: {
  state?: string;
  alreadyExists?: boolean;
  transactionBytesBase64?: string;
  expectedDigest?: string;
}): boolean {
  return result.state === "SCORE_READY" && (!result.transactionBytesBase64 || !result.expectedDigest);
}

export type PendingTransactionStage = "score_setup" | "payment" | "legacy";

export function paymentStageFromBuildState(state?: string): "score_setup" | "payment" {
  return state === "SCORE_FUNDING" ? "score_setup" : "payment";
}

export function pendingPrerequisiteRecovery(
  stage: PendingTransactionStage,
  phase: "prepared" | "submitted",
  nextStage: "score_setup" | "payment",
): "confirm" | "clear_and_stop" | null {
  if (nextStage !== "payment" || (stage !== "score_setup" && stage !== "legacy")) return null;
  return phase === "submitted" ? "confirm" : "clear_and_stop";
}

/** t2000 rejectSplitBps is the buyer's share; show the complementary worker share. */
export function workerSharePercent(rejectSplitBps: number): number {
  return (10_000 - rejectSplitBps) / 100;
}

export function walletBuildInput(taskId: string, fields: Record<string, unknown> = {}) {
  return { ...fields, taskId };
}

export function assertFrozenDigestMatch(savedDigest: string, returnedDigest: string): void {
  if (savedDigest !== returnedDigest) {
    throw new Error("The server returned different transaction bytes than the saved frozen transaction. Nothing was signed.");
  }
}

export type ExperienceBrowserState = {
  csrfToken: string;
  config: {
    appUrl: string | null;
    suiNetwork: string;
    suiEscrowConfigured: boolean;
    workerVerificationConfigured: boolean;
    ownerAuthenticationConfigured: boolean;
    worldIdentityEnvironment: WorldIdentityEnvironment;
  };
  session: {
    worker: null | {
      id: string;
      displayName: string;
      category: string;
      area: string;
      skills: string[];
      status: string;
      walletAddress: string | null;
      walletVerified: boolean;
      worldVerified: boolean;
    };
    owner: null | { id: string; walletAddress: string | null; walletVerified: boolean };
  };
  agents: Array<{
    id: string;
    name: string;
    categories: string[];
    maxTaskAtomic: string;
    totalBudgetAtomic: string;
    reservedAtomic: string;
    spentAtomic: string;
    availableAtomic: string;
    asset: string;
    network: string;
    decimals: number;
    active: boolean;
    authorizationRequired: boolean;
  }>;
  tasks: Array<{
    id: string;
    ownerId: string;
    agentId: string;
    title: string;
    brief: string;
    category: string;
    area: string;
    rubric: string[];
    amountAtomic: string;
    asset: string;
    network: string;
    decimals: number;
    reviewWindowMs: number;
    rejectSplitBps: number;
    deadline: string;
    state: string;
    worker: { id: string; displayName: string | null; walletAddress: string | null } | null;
    jobId: string | null;
    fundingDigest: string | null;
    submissionDigest: string | null;
    releaseDigest: string | null;
    refundDigest: string | null;
    rejectionDigest?: string | null;
    reviewDecision: string | null;
    reviewNote: string | null;
    createdAt: string;
    evidence?: null | { id: string; mediaType: string; byteLength: number; sha256: string; report: string; uploadedAt: string };
  }>;
  approvals: Array<{
    id: string;
    taskId: string;
    kind: string;
    status: string;
    amountAtomic: string;
    asset: string;
    network: string;
    decimals: number;
    reviewWindowMs: number;
    rejectSplitBps: number;
    feeQuoteBps: number | null;
    feeQuoteAtomic: string | null;
    netQuoteAtomic: string | null;
    workerName: string | null;
    workerWallet: string;
    ownerWallet: string;
    expiresAt: string;
    task: { title: string; brief: string; area: string };
  }>;
};

export type FrozenTransaction = {
  taskId: string;
  transactionBytesBase64: string;
  expectedDigest: string;
  network: string;
};

export type PublicWorker = {
  id: string;
  displayName: string;
  category: string;
  area: string;
  skills: string[];
  worldVerified: boolean;
  averageRating: number | null;
  reviewCount: number;
  ratingSource: "t2000" | "ask2human" | null;
  recentTasks: Array<{
    id: string;
    title: string;
    category: string;
    amountAtomic: string;
    completedAt: string;
    asset: ExperienceAsset;
  }>;
};

export type TaskPublisher = {
  agentName: string;
  ownerHandle: string;
  paidTaskCount: number;
  totalPaidAtomic: string;
};

export type PublicTaskSummary = {
  id: string;
  agentName: string;
  title: string;
  category: string;
  area: string;
  amountAtomic: string;
  asset: ExperienceAsset;
  deadline: string;
  state: string;
  createdAt: string;
};

export type ExperienceTask = {
  id: string;
  publisher: TaskPublisher;
  ownerId: string;
  agentId: string;
  title: string;
  brief: string | null;
  category: string;
  area: string;
  checklist: string[];
  amountAtomic: string;
  asset: ExperienceAsset;
  deadline: string;
  state: string;
  terms: { reviewWindowMs: number; rejectSplitBps: number };
  quote: { grossAtomic: string; feeAtomic: string | null; netAtomic: string | null; feeBps: number | null } | null;
  worker: { id: string; displayName: string; walletAddress: string | null; worldVerified: boolean; profilePath: string } | null;
  settlement: {
    grossAtomic: string;
    feeAtomic: string | null;
    netAtomic: string | null;
    feeQuoteBps: number | null;
    feeQuoteAtomic: string | null;
    netQuoteAtomic: string | null;
    fundingFeeBps: number | null;
    fundingFeeAtomic: string | null;
    fundingNetAtomic: string | null;
    feeChanged: boolean;
    feeAcknowledgedAt: string | null;
    scoreReady: boolean;
    jobId: string | null;
    settledAt: string | null;
    digest: string | null;
    status: string;
  } | null;
  deliveredAt: string | null;
  rating: { stars: number; digest: string; createdAt: string; confirmedAt: string | null } | null;
  reviewEndsAt: string | null;
  reviewDecision: string | null;
  applicationStatus: string | null;
  canApply: boolean;
  isOwner: boolean;
  isSelectedWorker: boolean;
  evidence: null | {
    id: string;
    mediaType: string;
    byteLength: number;
    sha256: string;
    report: string;
    uploadedAt: string;
  };
  timeline: Array<{ label: string; at: string | null; state: string }>;
  nextAction: string;
  legacyReadOnly: boolean;
};

export type WorkDashboard = {
  workerId: string;
  worker: { displayName: string; status: string; category: string };
  totals: {
    lifetimeGrossAtomic: string;
    lifetimeFeeAtomic: string;
    lifetimeNetAtomic: string;
    monthNetAtomic: string;
    pendingAtomic: string;
    asset: ExperienceAsset;
  };
  legacyReadOnly: Array<{ asset: ExperienceAsset; recordCount: number }>;
  payments: Array<{
    taskId: string;
    title: string;
    state: string;
    grossAtomic: string;
    feeAtomic: string | null;
    netAtomic: string | null;
    jobId: string | null;
    digest: string | null;
    settledAt: string | null;
    settlementStatus: string;
    asset: ExperienceAsset;
  }>;
  tasks: Array<{
    id: string;
    title: string;
    category: string;
    area: string;
    amountAtomic: string;
    asset: ExperienceAsset;
    deadline: string;
    state: string;
    applicationStatus: string | null;
    assigned: boolean;
  }>;
};

export type OwnerDashboard = {
  owner: { id: string; walletAddress: string | null; walletVerified: boolean };
  agents: Array<{
    id: string;
    name: string;
    categories: string[];
    maxTaskAtomic: string;
    totalBudgetAtomic: string;
    reservedAtomic: string;
    spentAtomic: string;
    availableAtomic: string;
    asset: ExperienceAsset;
    active: boolean;
    authorizationRequired: boolean;
  }>;
  tasks: Array<{
    id: string;
    agentId: string;
    title: string;
    category: string;
    area: string;
    amountAtomic: string;
    asset: ExperienceAsset;
    deadline: string;
    state: string;
    worker: { id: string; displayName: string | null } | null;
  }>;
};

export type ApplicantList = {
  taskId: string;
  taskState: string;
  selectedWorkerId: string | null;
  applicants: Array<{
    applicationId: string;
    workerId: string;
    note: string | null;
    status: "APPLIED" | "SELECTED" | "DECLINED";
    appliedAt: string;
    worker: Pick<PublicWorker, "id" | "displayName" | "category" | "area" | "skills" | "worldVerified"> & {
      eligible: boolean;
      profilePath: string;
    };
  }>;
};

async function parseResponse<T>(response: Response): Promise<T> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error("The server returned an unreadable response.");
  }
  if (!response.ok) {
    const message = typeof body === "object" && body !== null && "error" in body &&
      typeof body.error === "object" && body.error !== null && "message" in body.error &&
      typeof body.error.message === "string" ? body.error.message : "The request could not be completed.";
    throw new Error(message);
  }
  return body as T;
}

export async function readExperience<T>(view: string, fields: Record<string, string> = {}): Promise<T> {
  const query = new URLSearchParams({ view, ...fields });
  return parseResponse<T>(await fetch(`/api/experience?${query}`, {
    cache: "no-store",
    credentials: "same-origin",
  }));
}

export async function readExperienceState(): Promise<ExperienceBrowserState> {
  return parseResponse<ExperienceBrowserState>(await fetch('/api/state', {
    cache: 'no-store',
    credentials: 'same-origin',
  }));
}

export async function postExperience<T>(csrfToken: string, action: string, fields: Record<string, unknown> = {}): Promise<T> {
  return parseResponse<T>(await fetch("/api/experience", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
    body: JSON.stringify({ action, ...fields }),
  }));
}

export async function postBrowserAction<T>(csrfToken: string, action: string, fields: Record<string, unknown> = {}): Promise<T> {
  return parseResponse<T>(await fetch('/api/actions', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify({ action, ...fields }),
  }));
}

export async function readPrivateEvidenceLink(evidenceId: string) {
  return parseResponse<{ signedReadUrl: string; expiresInSeconds: number }>(await fetch(`/api/evidence/${encodeURIComponent(evidenceId)}`, {
    cache: 'no-store',
    credentials: 'same-origin',
  }));
}

export async function uploadExperienceEvidence(csrfToken: string, taskId: string, report: string, file: File) {
  const form = new FormData();
  form.set('taskId', taskId);
  form.set('report', report);
  form.set('file', file);
  return parseResponse(await fetch('/api/evidence', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'x-csrf-token': csrfToken },
    body: form,
  }));
}

export function formatAtomic(value: string | bigint, asset: ExperienceAsset, maximumFractionDigits = asset.decimals) {
  const atomic = BigInt(value);
  const base = 10n ** BigInt(asset.decimals);
  const whole = atomic / base;
  const fractionDigits = Math.max(0, Math.min(asset.decimals, maximumFractionDigits));
  const fraction = (atomic % base).toString().padStart(asset.decimals, "0").slice(0, fractionDigits).replace(/0+$/, "");
  return `${whole.toString()}${fraction ? `.${fraction}` : ""} ${asset.symbol}`;
}

export function parseAtomic(value: string, asset: ExperienceAsset) {
  const escaped = asset.decimals === 0 ? "" : `(?:\\.([0-9]{1,${asset.decimals}}))?`;
  const match = new RegExp(`^(0|[1-9][0-9]*)${escaped}$`).exec(value.trim());
  if (!match) throw new Error(`Enter a positive ${asset.symbol} amount with up to ${asset.decimals} decimal places.`);
  const whole = BigInt(match[1]);
  const fractionPart = asset.decimals === 0 ? "" : (match[2] ?? "").padEnd(asset.decimals, "0");
  const fraction = fractionPart ? BigInt(fractionPart) : 0n;
  const atomic = whole * 10n ** BigInt(asset.decimals) + fraction;
  if (atomic <= 0n) throw new Error("Amount must be greater than zero.");
  return atomic.toString();
}

export function taskTermsFromForm(reviewWindowMinutes: string, rejectSplitPercent: string) {
  if (!/^(0|[1-9][0-9]*)$/.test(reviewWindowMinutes.trim())) throw new Error("The review window must be a whole number of minutes.");
  if (!/^(0|[1-9][0-9]*)$/.test(rejectSplitPercent.trim())) throw new Error("The worker rejection share must be a whole percentage.");
  const minutes = Number(reviewWindowMinutes);
  const percentage = Number(rejectSplitPercent);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 720) throw new Error("The review window must be between 1 and 720 minutes.");
  if (!Number.isInteger(percentage) || percentage < 0 || percentage > 100) throw new Error("The worker rejection share must be between 0 and 100 percent.");
  return { reviewWindowMs: minutes * 60_000, rejectSplitBps: (100 - percentage) * 100 };
}
