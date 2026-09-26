export type Worker = {
  id: string;
  displayName: string;
  category: string;
  area: string;
  skills: string[];
  status: "PENDING" | "VERIFIED" | string;
  walletAddress: string | null;
  walletVerified: boolean;
  worldVerified: boolean;
};

export type Owner = {
  id: string;
  walletAddress: string | null;
  walletVerified: boolean;
};

export type Agent = {
  id: string;
  name: string;
  categories: string[];
  maxTaskMist: string;
  totalBudgetMist: string;
  reservedMist: string;
  spentMist: string;
  availableMist: string;
  active: boolean;
};

export type Task = {
  id: string;
  ownerId: string;
  agentId: string;
  title: string;
  brief: string;
  category: string;
  area: string;
  rubric: string[];
  amountMist: string;
  deadline: string;
  state: "OPEN" | "ASSIGNED" | "FUNDING" | "FUNDED" | "SUBMITTED" | "REVIEW" | "PAID" | "REFUNDED" | "CANCELLED" | string;
  worker: { id: string; displayName: string | null; walletAddress: string | null } | null;
  jobId: string | null;
  fundingDigest: string | null;
  submissionDigest: string | null;
  releaseDigest: string | null;
  refundDigest: string | null;
  reviewDecision: string | null;
  reviewNote: string | null;
  createdAt: string;
  evidence?: { id: string; mediaType: string; byteLength: number; sha256: string; report: string; uploadedAt: string } | null;
};

export type Approval = {
  id: string;
  taskId: string;
  kind: "HIRE" | "RELEASE" | string;
  status: string;
  amountMist: string;
  workerName: string | null;
  workerWallet: string;
  ownerWallet: string;
  expiresAt: string;
  task: { title: string; brief: string; area: string };
};

export type BrowserState = {
  csrfToken: string;
  config: {
    appUrl: string | null;
    suiNetwork: string;
    suiEscrowConfigured: boolean;
    workerVerificationConfigured: boolean;
    ownerAuthenticationConfigured: boolean;
  };
  session: { worker: Worker | null; owner: Owner | null };
  agents: Agent[];
  tasks: Task[];
  approvals: Approval[];
};

export type WalletChallenge = { challengeId: string; message: string; expiresAt: string };
export type IdKitRequest = {
  app_id: `app_${string}`;
  action: string;
  environment: "production" | "staging" | "sandbox";
  signal: string;
  rp_context: { rp_id: string; nonce: string; created_at: number; expires_at: number; signature: string };
  allow_legacy_proofs: false;
};
export type IdKitStart = { challengeId: string; request: IdKitRequest; expiresAt: string };
export type BuiltTransaction = { taskId: string; transactionBytesBase64: string; expectedDigest: string; network: string };

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
      typeof body.error.message === "string"
      ? body.error.message
      : "The request could not be completed.";
    throw new Error(message);
  }
  return body as T;
}

export async function readBrowserState(): Promise<BrowserState> {
  return parseResponse<BrowserState>(await fetch("/api/state", { cache: "no-store", credentials: "same-origin" }));
}

export async function postAction<T>(csrfToken: string, action: string, fields: Record<string, unknown> = {}): Promise<T> {
  return parseResponse<T>(await fetch("/api/actions", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
    body: JSON.stringify({ action, ...fields }),
  }));
}

export async function uploadTaskEvidence(csrfToken: string, taskId: string, report: string, file: File): Promise<unknown> {
  const form = new FormData();
  form.set("taskId", taskId);
  form.set("report", report);
  form.set("file", file);
  return parseResponse(await fetch("/api/evidence", {
    method: "POST",
    credentials: "same-origin",
    headers: { "x-csrf-token": csrfToken },
    body: form,
  }));
}

export type EvidenceLink = { signedReadUrl: string; expiresInSeconds: number };
export async function readEvidenceLink(evidenceId: string): Promise<EvidenceLink> {
  return parseResponse<EvidenceLink>(await fetch(`/api/evidence/${encodeURIComponent(evidenceId)}`, {
    cache: "no-store",
    credentials: "same-origin",
  }));
}
