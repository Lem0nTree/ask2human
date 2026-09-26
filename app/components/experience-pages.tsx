"use client";

import { DAppKitProvider, useCurrentAccount, useDAppKit } from "@mysten/dapp-kit-react";
import { ConnectButton } from "@mysten/dapp-kit-react/ui";
import { Transaction } from "@mysten/sui/transactions";
import { IDKitRequestWidget, proofOfHuman } from "@worldcoin/idkit";
import type { IDKitResult } from "@worldcoin/idkit";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { AppNavigation } from "./app-navigation";
import { McpQuickStart } from "./mcp-quick-start";
import { Callout, EmptyState, LoadingState, SectionHeading, StatusBadge } from "./ui";
import { dAppKit } from "../lib/client/dapp-kit";
import {
  formatAtomic,
  canRefreshFundingApproval,
  canCancelUnfundedTask,
  deliveryPrerequisitesReady,
  isNoTransactionScoreReady,
  assertFrozenDigestMatch,
  isApprovalCurrent,
  MAINNET_USDC,
  ownerFundingAction,
  parseAtomic,
  paymentStageFromBuildState,
  pendingPrerequisiteRecovery,
  postBrowserAction,
  postExperience,
  readExperience,
  readExperienceState,
  readPrivateEvidenceLink,
  taskTermsFromForm,
  uploadExperienceEvidence,
  walletBuildInput,
  worldCheckBadge,
  worldCheckStatus,
  worldEnvironmentDisclosure,
  type ApplicantList,
  type ExperienceBrowserState,
  type ExperienceTask,
  type FrozenTransaction,
  type OwnerDashboard,
  type PublicTaskSummary,
  type PublicWorker,
  type PendingTransactionStage,
  type WorkDashboard,
  workerSharePercent,
} from "../lib/client/experience-api";

type PendingPhase = "prepared" | "submitted";
type PendingTransaction = {
  taskId: string;
  buildAction: string;
  buildFields?: Record<string, unknown>;
  confirmAction: string;
  digest: string;
  phase: PendingPhase;
  stage?: PendingTransactionStage;
};
type IDKitStart = {
  challengeId: string;
  request: {
    app_id: `app_${string}`;
    action: string;
    environment: "production" | "staging" | "sandbox";
    signal: string;
    rp_context: { rp_id: string; nonce: string; created_at: number; expires_at: number; signature: string };
    allow_legacy_proofs: false;
  };
};

const MAX_EVIDENCE_BYTES = 4 * 1024 * 1024;
const PENDING_PREFIX = "ask2human:pending-transaction:";
const CATEGORIES = ["inspection", "delivery", "photography", "research", "audit", "other"];
const TASK_DRAFT_STORAGE_KEY = "ask2human:hiring-task-draft";

type HiringTaskDraft = {
  title: string;
  brief: string;
  category: string;
  area: string;
  checklist: string;
  amount: string;
  deadline: string;
  reviewWindowMinutes: string;
  rejectSplitPercent: string;
};

const EMPTY_HIRING_TASK_DRAFT: HiringTaskDraft = {
  title: "",
  brief: "",
  category: "",
  area: "",
  checklist: "",
  amount: "",
  deadline: "",
  reviewWindowMinutes: "5",
  rejectSplitPercent: "50",
};

function readHiringTaskDraft(ownerId: string): HiringTaskDraft {
  if (typeof window === "undefined") return EMPTY_HIRING_TASK_DRAFT;
  try {
    const stored = JSON.parse(window.sessionStorage.getItem(`${TASK_DRAFT_STORAGE_KEY}:${ownerId}`) ?? "null") as Partial<HiringTaskDraft> | null;
    if (!stored || typeof stored !== "object") return EMPTY_HIRING_TASK_DRAFT;
    return {
      ...EMPTY_HIRING_TASK_DRAFT,
      ...Object.fromEntries(Object.keys(EMPTY_HIRING_TASK_DRAFT).map((key) => [key, typeof stored[key as keyof HiringTaskDraft] === "string" ? stored[key as keyof HiringTaskDraft] : EMPTY_HIRING_TASK_DRAFT[key as keyof HiringTaskDraft]])) as HiringTaskDraft,
    };
  } catch {
    return EMPTY_HIRING_TASK_DRAFT;
  }
}

function ownerTaskStageLabel(state: string): string {
  if (state === "OPEN") return "Applicants"
  if (state === "ASSIGNED" || state === "FUNDING") return "Approve and fund"
  if (state === "FUNDED") return "Worker delivers"
  if (state === "SUBMITTED" || state === "REVIEW") return "Review and pay"
  if (state === "PAID" || state === "REJECTED") return "Complete"
  return "Closed"
}

function ownerTaskLifecycleStep(state: string): number | null {
  if (state === "OPEN") return 1;
  if (state === "ASSIGNED" || state === "FUNDING") return 3;
  if (state === "FUNDED") return 4;
  if (state === "SUBMITTED" || state === "REVIEW") return 5;
  if (state === "PAID" || state === "REJECTED") return 6;
  return null;
}

function updateMarketplaceFilter(name: "q" | "category", value: string) {
  const url = new URL(window.location.href);
  if (value) url.searchParams.set(name, value);
  else url.searchParams.delete(name);
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
}

function taskTone(state: string): "success" | "warning" | "danger" | "neutral" | "info" {
  if (["PAID", "FUNDED"].includes(state)) return "success";
  if (["OPEN", "SUBMITTED", "REVIEW"].includes(state)) return "info";
  if (["CANCELLED", "REFUNDED"].includes(state)) return "neutral";
  if (["FUNDING", "ASSIGNED"].includes(state)) return "warning";
  if (state === "REJECTED") return "danger";
  return "neutral";
}

function dateLabel(value: string | null) {
  if (!value) return "Not recorded";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function shortAddress(value: string | null | undefined) {
  return value ? `${value.slice(0, 7)}…${value.slice(-5)}` : "Not linked";
}

function pendingKey(taskId: string, confirmAction: string, stage?: PendingTransactionStage) {
  return `${PENDING_PREFIX}${taskId}:${confirmAction}${stage ? `:${stage}` : ""}`;
}

function pendingStage(record: PendingTransaction): PendingTransactionStage {
  if (record.stage) return record.stage;
  if (record.confirmAction === "confirm_score_setup") return "score_setup";
  if (record.confirmAction === "confirm_refund" && record.buildAction === "build_refund") return "legacy";
  return "payment";
}

function readPending(taskId: string, confirmAction?: string, stage?: PendingTransactionStage) {
  if (typeof window === "undefined") return null;
  try {
    const records: PendingTransaction[] = [];
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (!key?.startsWith(PENDING_PREFIX)) continue;
      const value = JSON.parse(window.localStorage.getItem(key) ?? "null") as PendingTransaction | null;
      if (value?.taskId === taskId && (!confirmAction || value.confirmAction === confirmAction) && (!stage || pendingStage(value) === stage)) records.push(value);
    }
    return records.at(-1) ?? null;
  } catch {
    return null;
  }
}

function savePending(record: PendingTransaction) {
  const stagedRecord = { ...record, stage: pendingStage(record) };
  window.localStorage.setItem(pendingKey(stagedRecord.taskId, stagedRecord.confirmAction, stagedRecord.stage), JSON.stringify(stagedRecord));
}

function removePending(record: PendingTransaction) {
  window.localStorage.removeItem(pendingKey(record.taskId, record.confirmAction, record.stage));
}

function isWalletCancellation(error: unknown) {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return message.includes("reject") || message.includes("cancel") || message.includes("user denied");
}

function PageFrame({ children }: { children: ReactNode }) {
  return <DAppKitProvider dAppKit={dAppKit}>
    <AppNavigation />
    {children}
    <footer className="site-footer page-shell"><span>ask2human</span><span>Mainnet USDC · confirmed receipts determine earnings</span><span>Identity checks and evidence review establish different facts</span></footer>
  </DAppKitProvider>;
}

function useExperienceController() {
  const [browser, setBrowser] = useState<ExperienceBrowserState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loadError, setLoadError] = useState("");

  const refresh = useCallback(async () => {
    const next = await readExperienceState();
    setBrowser(next);
    setLoadError("");
    return next;
  }, []);

  useEffect(() => {
    void refresh().catch((cause) => setLoadError(cause instanceof Error ? cause.message : "Marketplace state is unavailable."));
  }, [refresh]);

  const call = useCallback(async <T,>(action: string, fields: Record<string, unknown> = {}) => {
    if (!browser) throw new Error("The browser session is still loading.");
    return postBrowserAction<T>(browser.csrfToken, action, fields);
  }, [browser]);

  const experienceCall = useCallback(async <T,>(action: string, fields: Record<string, unknown> = {}) => {
    if (!browser) throw new Error("The browser session is still loading.");
    return postExperience<T>(browser.csrfToken, action, fields);
  }, [browser]);

  const run = useCallback(async <T,>(work: () => Promise<T>, refreshAfter = true): Promise<T | null> => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await work();
      if (refreshAfter) await refresh();
      return result;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The action could not be completed.");
      return null;
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  return useMemo(() => ({ browser, busy, error, notice, loadError, setError, setNotice, refresh, call, experienceCall, run }), [browser, busy, error, notice, loadError, refresh, call, experienceCall, run]);
}

function Feedback({ error, notice }: { error: string; notice: string }) {
  return <>
    {error && <Callout title="Action not completed" tone="danger">{error}</Callout>}
    {notice && <Callout title="Update" tone="success">{notice}</Callout>}
  </>;
}

function useWalletActions(controller: ReturnType<typeof useExperienceController>) {
  const account = useCurrentAccount();
  const kit = useDAppKit();

  const verifyWallet = useCallback(async (purpose: "worker" | "owner" | "recover_worker" | "recover_owner") => {
    if (!account) {
      controller.setError("Connect a Slush or compatible Sui wallet first.");
      return;
    }
    const outcome = await controller.run(async () => {
      const challenge = await controller.call<{ challengeId: string; message: string }>("start_wallet_challenge", { purpose, address: account.address });
      const signed = await kit.signPersonalMessage({ message: new TextEncoder().encode(challenge.message), network: "mainnet" });
      await controller.call("complete_wallet_challenge", { challengeId: challenge.challengeId, signature: signed.signature });
      return challenge;
    });
    if (outcome) controller.setNotice(purpose.startsWith("recover_") ? "Existing account recovered with its linked wallet." : "Wallet challenge verified and linked.");
  }, [account, controller, kit]);

  const beginOwnerLogin = useCallback(async () => {
    const result = await controller.run(() => controller.call<{ authorizationUrl: string }>("begin_owner_login"), false);
    if (result?.authorizationUrl) window.location.assign(result.authorizationUrl);
  }, [controller]);

  const beginApproval = useCallback(async (approvalId: string) => {
    const result = await controller.run(() => controller.call<{ authorizationUrl: string }>("begin_owner_authorization", { approvalId }), false);
    if (result?.authorizationUrl) window.location.assign(result.authorizationUrl);
  }, [controller]);

  const signTransaction = useCallback(async (input: {
    taskId: string;
    buildAction: string;
    buildFields?: Record<string, unknown>;
    confirmAction: string;
    prompt: string;
    signer: "owner" | "worker";
    expectedStage?: PendingTransactionStage;
  }) => {
    const walletAddress = input.signer === "worker" ? controller.browser?.session.worker?.walletAddress : controller.browser?.session.owner?.walletAddress;
    if (!account || !walletAddress || account.address.toLowerCase() !== walletAddress.toLowerCase()) {
      controller.setError("Connect the wallet linked to the signing account, then retry the frozen transaction.");
      return;
    }
    const result = await controller.run(async () => {
      const built = await controller.call<Partial<FrozenTransaction> & { network?: string; state?: string; alreadyExists?: boolean }>(input.buildAction, walletBuildInput(input.taskId, input.buildFields));
      if (built.network !== "mainnet") throw new Error("This task is not configured for mainnet signing.");
      if (isNoTransactionScoreReady(built)) {
        const scorePending = readPending(input.taskId, input.confirmAction, "score_setup");
        if (scorePending) removePending(scorePending);
        controller.setNotice("The worker payment account is already ready. No new transaction was signed and no escrow money moved.");
        return { confirmed: true, prerequisiteReady: true, alreadyExists: true };
      }
      if (!built.transactionBytesBase64 || !built.expectedDigest) throw new Error("The server did not return a frozen mainnet transaction.");
      const builtStage = paymentStageFromBuildState(built.state);

      // A refund builder can change from the score-account prerequisite to
      // actual refund bytes after that account appears on chain. Resolve any
      // setup-only local attempt first, then require a fresh refund click.
      // This also treats pre-stage localStorage records conservatively.
      if (input.confirmAction === "confirm_refund" && builtStage === "payment") {
        const prerequisitePending = readPending(input.taskId, input.confirmAction, "score_setup") ??
          readPending(input.taskId, input.confirmAction, "legacy");
        const recovery = prerequisitePending
          ? pendingPrerequisiteRecovery(pendingStage(prerequisitePending), prerequisitePending.phase, builtStage)
          : null;
        if (prerequisitePending && recovery) {
          if (recovery === "confirm") {
            const confirmation = await controller.call<{ state?: string }>(prerequisitePending.confirmAction, {
              taskId: input.taskId,
              digest: prerequisitePending.digest,
            });
            if (confirmation.state === "SCORE_READY") {
              removePending(prerequisitePending);
              controller.setNotice("The worker payment account is ready. No refund was sent. Start the refund again to review and sign its separate transaction.");
              return { confirmed: true, prerequisiteReady: true };
            }
            if (confirmation.state === "REFUNDED") {
              removePending(prerequisitePending);
              controller.setNotice("The server confirmed the refund receipt. No additional wallet transaction was signed.");
              return { confirmed: true, terminal: true };
            }
            throw new Error("The saved setup receipt was not reconciled as a ready payment account. Its record remains available for retry.");
          }
          removePending(prerequisitePending);
          controller.setNotice("The payment account is ready, but no refund was sent. Start the refund again to review and sign its separate transaction.");
          return { cancelled: true, prerequisiteReady: true };
        }
        if (input.expectedStage && input.expectedStage !== "payment") {
          controller.setNotice("The payment account is ready. The saved setup attempt was cleared without signing refund bytes; start the refund again as a separate transaction.");
          return { cancelled: true, prerequisiteReady: true };
        }
      }

      // Old records shared one key for both score setup and refund. They do
      // not carry enough information to authorize signing newly returned
      // setup bytes, so clear or reconcile them and make the owner start over.
      if (input.confirmAction === "confirm_refund" && input.expectedStage === "legacy") {
        const legacyPending = readPending(input.taskId, input.confirmAction, "legacy");
        if (legacyPending?.phase === "submitted") {
          const confirmation = await controller.call<{ state?: string }>(legacyPending.confirmAction, {
            taskId: input.taskId,
            digest: legacyPending.digest,
          });
          if (confirmation.state === "SCORE_READY") {
            removePending(legacyPending);
            controller.setNotice("The worker payment account is ready. No refund was sent. Start the refund again to review and sign its separate transaction.");
            return { confirmed: true, prerequisiteReady: true };
          }
          if (confirmation.state === "REFUNDED") {
            removePending(legacyPending);
            controller.setNotice("The server confirmed the refund receipt. No additional wallet transaction was signed.");
            return { confirmed: true, terminal: true };
          }
          throw new Error("The older receipt could not be reconciled. Its record remains available for retry.");
        }
        if (legacyPending) removePending(legacyPending);
        controller.setNotice("This older saved attempt was cleared without signing. Start account preparation or the refund again as a separate step.");
        return { cancelled: true, prerequisiteReady: builtStage === "payment" };
      }

      if (input.expectedStage && input.expectedStage !== builtStage) {
        throw new Error("The server returned a different transaction stage than the saved attempt. Nothing was signed; refresh and start that step again.");
      }

      const priorPending = readPending(input.taskId, input.confirmAction, builtStage);
      if (priorPending) {
        if (priorPending.phase === "submitted") throw new Error("This transaction already has a wallet receipt. Retry server confirmation instead of signing again.");
        assertFrozenDigestMatch(priorPending.digest, built.expectedDigest);
      }
      const record: PendingTransaction = {
        taskId: input.taskId,
        buildAction: input.buildAction,
        buildFields: input.buildFields,
        confirmAction: input.confirmAction,
        digest: built.expectedDigest,
        phase: "prepared",
        stage: builtStage,
      };
      savePending(record);
      const prompt = built.state === "SCORE_FUNDING"
        ? input.buildAction === "build_refund"
          ? "Prepare the worker's t2000 payment account? This step uses Sui network gas only and does not refund escrow. After it confirms, start and sign the separate refund transaction."
          : "Create the worker's t2000 payment account? This step uses Sui network gas only; it does not transfer escrow or pay task funds."
        : input.prompt;
      if (!window.confirm(prompt)) {
        controller.setNotice("No transaction was signed. Its frozen bytes remain available; reconnect the linked Slush wallet to retry.");
        return { cancelled: true };
      }
      let execution;
      try {
        execution = await kit.signAndExecuteTransaction({ transaction: Transaction.from(built.transactionBytesBase64), network: "mainnet" });
      } catch (cause) {
        if (isWalletCancellation(cause)) {
          controller.setNotice("Wallet request cancelled. The task and frozen transaction remain saved; reconnect and retry when ready.");
          return { cancelled: true };
        }
        throw cause;
      }
      if (execution.FailedTransaction) {
        const failure = execution.FailedTransaction.status.error;
        throw new Error(failure && "message" in failure && typeof failure.message === "string" ? failure.message : "Sui reported a failed transaction.");
      }
      if (!execution.Transaction.status.success) {
        const failure = execution.Transaction.status.error;
        throw new Error(failure && "message" in failure && typeof failure.message === "string" ? failure.message : "Sui did not confirm a successful transaction.");
      }
      const digest = execution.Transaction.digest;
      if (digest !== built.expectedDigest) throw new Error("The wallet receipt does not match the server-frozen transaction. The receipt was not recorded; contact support with its digest.");
      record.phase = "submitted";
      record.digest = digest;
      savePending(record);
      const confirmation = await controller.call<{ state?: string }>(input.confirmAction, { taskId: input.taskId, digest });
      removePending(record);
      const refundPreparedWorkerAccount = input.buildAction === "build_refund" && built.state === "SCORE_FUNDING" && confirmation.state === "SCORE_READY";
      if (refundPreparedWorkerAccount) {
        controller.setNotice("The worker payment account is ready. This step used Sui network gas only; no escrow refund was sent. Start the refund again to review and sign its separate transaction.");
      } else if (input.confirmAction === "confirm_score_setup") {
        controller.setNotice("The worker payment account is ready. This transaction used Sui network gas only; it did not pay task funds.");
      } else {
        controller.setNotice("Sui confirmed the transaction and ask2human recorded its receipt.");
      }
      return { confirmed: true, prerequisiteReady: input.confirmAction === "confirm_score_setup" || refundPreparedWorkerAccount };
    });
    return result;
  }, [account, controller, kit]);

  const retryConfirmation = useCallback(async (record: PendingTransaction) => {
    const result = await controller.run(async () => {
      const confirmation = await controller.call<{ state?: string }>(record.confirmAction, { taskId: record.taskId, digest: record.digest });
      removePending(record);
      if (record.confirmAction === "confirm_refund" && confirmation.state === "SCORE_READY") {
        controller.setNotice("The worker payment account is ready. This step used Sui network gas only; no escrow refund was sent. Start the refund again to review and sign its separate transaction.");
      } else if (record.confirmAction === "confirm_refund" && confirmation.state === "REFUNDED") {
        controller.setNotice("The server confirmed the refund receipt. No additional wallet transaction was signed.");
      } else if (record.confirmAction === "confirm_score_setup") {
        controller.setNotice("The worker payment account is ready. This transaction used Sui network gas only; it did not pay task funds.");
      } else {
        controller.setNotice("Receipt confirmation completed. No new wallet transaction was submitted.");
      }
    });
    return result !== null;
  }, [controller]);

  return { account, verifyWallet, beginOwnerLogin, beginApproval, signTransaction, retryConfirmation };
}

export function MarketplacePage() {
  return <PageFrame><MarketplaceContent /></PageFrame>;
}

function MarketplaceContent() {
  const controller = useExperienceController();
  const [rows, setRows] = useState<PublicTaskSummary[]>([]);
  const [search, setSearch] = useState(() => typeof window === "undefined" ? "" : new URLSearchParams(window.location.search).get("q") ?? "");
  const [category, setCategory] = useState(() => typeof window === "undefined" ? "" : new URLSearchParams(window.location.search).get("category") ?? "");
  const [loadError, setLoadError] = useState("");
  const [loadingTasks, setLoadingTasks] = useState(true);
  const requestSequence = useRef(0);

  const loadTasks = useCallback(async () => {
    const requestId = ++requestSequence.current;
    setLoadingTasks(true);
    try {
      const result = await readExperience<{ tasks: PublicTaskSummary[] }>("tasks", { q: search, category });
      if (requestId !== requestSequence.current) return;
      setRows(result.tasks);
      setLoadError("");
    } catch (cause) {
      if (requestId !== requestSequence.current) return;
      setLoadError(cause instanceof Error ? cause.message : "Open tasks are unavailable.");
    } finally {
      if (requestId === requestSequence.current) setLoadingTasks(false);
    }
  }, [search, category]);

  useEffect(() => { void loadTasks(); }, [loadTasks]);
  const categories = useMemo(() => [...new Set([...CATEGORIES, ...rows.map((row) => row.category)])].sort(), [rows]);

  return <main className="page-shell">
    <Feedback error={controller.error} notice={controller.notice} />
    <section className="directory-hero">
      <p className="eyebrow"><i />Human work, secured by escrow</p>
      <h1>Local tasks. <span>Human expertise.</span></h1>
      <p>Find work posted by task owners. Apply as an eligible worker, agree on exact terms, and track confirmed USDC payments.</p>
      <div className="directory-collection-stats"><span>{loadingTasks ? <LoadingState label="Loading open task count…" variant="inline" /> : <strong>{rows.length}</strong>} open tasks</span><span className="testnet-dot" /> Mainnet USDC</div>
      <small>World verification checks worker account uniqueness; it does not certify completed work.</small>
    </section>
    <section className="marketplace-section" aria-labelledby="marketplace-title">
      <SectionHeading eyebrow="Marketplace" title="Find a task" description="Open task listings show the category, service area, reward, and deadline. Verify as a worker to read the full task brief and apply." />
      <div className="filter-panel" role="search">
        <label className="search-field"><span aria-hidden="true">⌕</span><input aria-label="Search open tasks" type="search" placeholder="Search tasks, area, or category" value={search} onChange={(event) => { setSearch(event.target.value); updateMarketplaceFilter("q", event.target.value); }} /></label>
        <label className="select-field"><span>Category</span><select value={category} onChange={(event) => { setCategory(event.target.value); updateMarketplaceFilter("category", event.target.value); }}><option value="">All categories</option>{categories.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
        <a className="button button--primary" href="/agents">Hire a human</a>
      </div>
      <div className="marketplace-results-heading"><span>{loadingTasks ? <LoadingState label="Loading task count…" variant="inline" /> : `${rows.length} ${rows.length === 1 ? "task" : "tasks"}`}</span><span>Recently posted</span></div>
      {loadingTasks ? <LoadingState label="Loading open tasks…" variant="list" /> : loadError ? <Callout title="Task listings unavailable" tone="danger">{loadError}</Callout> : rows.length === 0
        ? <EmptyState title="No open tasks right now">New requests appear here after a task owner posts them. Check back later or set up a hiring profile from your owner workspace.</EmptyState>
        : <div className="agent-grid">{rows.map((task) => <article key={task.id} className="agent-row task-row">
          <div className="agent-row__art"><span className="task-emblem" aria-hidden="true">{task.category.slice(0, 1).toUpperCase()}</span></div>
          <div className="agent-row__content"><h3>{task.title}</h3><p className="agent-row__description">Open the task page for the full brief and application requirements.</p><div className="agent-row__meta"><span>{task.category}</span><span>{task.area}</span><span>Due {dateLabel(task.deadline)}</span></div></div>
          <div className="agent-row__offer"><strong>{formatAtomic(task.amountAtomic, task.asset)}</strong><StatusBadge value="OPEN" tone="info" /><small>Task reward</small></div>
          <div className="agent-row__actions"><a className="button button--primary" href={`/tasks/${task.id}`}>View task <span aria-hidden="true">↗</span></a></div>
        </article>)}</div>}
    </section>
    <section className="section-block experience-shortcuts">
      <a className="detail-section" href="/work"><p className="eyebrow">For workers</p><h3>Applications, delivery, and earnings</h3><p>Manage your verified profile and see confirmed payment history.</p></a>
      <a className="detail-section" href="/agents"><p className="eyebrow">For task owners</p><h3>Hire a human for a task</h3><p>Sign in, link a payment wallet, set spending limits, and oversee each escrow step.</p></a>
    </section>
  </main>;
}

export function TaskPage({ taskId }: { taskId: string }) {
  return <PageFrame><TaskContent taskId={taskId} /></PageFrame>;
}

function TaskContent({ taskId }: { taskId: string }) {
  const controller = useExperienceController();
  const wallet = useWalletActions(controller);
  const [task, setTask] = useState<ExperienceTask | null>(null);
  const [taskLoading, setTaskLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [evidenceUrl, setEvidenceUrl] = useState("");
  const [report, setReport] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState("");
  const [applicationNote, setApplicationNote] = useState("");
  const [pending, setPending] = useState<PendingTransaction | null>(null);
  const [consentChecked, setConsentChecked] = useState(false);
  const [stars, setStars] = useState(5);
  const [scorePrepared, setScorePrepared] = useState(false);
  const taskRequestSequence = useRef(0);

  const loadTask = useCallback(async () => {
    const requestId = ++taskRequestSequence.current;
    setTaskLoading(true);
    try {
      const result = await readExperience<{ task: ExperienceTask }>("task", { taskId });
      if (requestId !== taskRequestSequence.current) return;
      setTask(result.task);
      if (result.task.rating && !result.task.rating.confirmedAt) setStars(result.task.rating.stars);
      setLoadError("");
      setPending(readPending(taskId));
    } catch (cause) {
      if (requestId === taskRequestSequence.current) setLoadError(cause instanceof Error ? cause.message : "Task details are unavailable.");
    } finally {
      if (requestId === taskRequestSequence.current) setTaskLoading(false);
    }
  }, [taskId]);

  useEffect(() => {
    setTask(null);
    setLoadError("");
    void loadTask();
  }, [loadTask]);
  useEffect(() => { setScorePrepared(false); }, [taskId]);
  useEffect(() => {
    if (!file) { setPreviewUrl(""); return; }
    const objectUrl = URL.createObjectURL(file);
    setPreviewUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [file]);

  const refreshAll = useCallback(async () => {
    await controller.refresh().catch(() => undefined);
    await loadTask();
  }, [controller, loadTask]);

  async function apply() {
    const result = await controller.run(() => controller.experienceCall("apply", { taskId, note: applicationNote }));
    if (result) {
      controller.setNotice("Application sent. The task owner can review your profile and choose one applicant.");
      setApplicationNote("");
      await loadTask();
    }
  }

  async function uploadEvidence(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!controller.browser || !file || !task) return;
    if (file.size > MAX_EVIDENCE_BYTES) {
      controller.setError("Choose one JPEG, PNG, or WebP image that is 4 MiB or smaller.");
      return;
    }
    const result = await controller.run(() => uploadExperienceEvidence(controller.browser!.csrfToken, task.id, report, file));
    if (result) {
      setFile(null);
      setReport("");
      await refreshAll();
      controller.setNotice("Evidence is stored privately. Review the preview and submit its commitment to the escrow.");
    }
  }

  async function loadEvidenceLink() {
    if (!task?.evidence) return;
    const result = await controller.run(() => readPrivateEvidenceLink(task.evidence!.id), false);
    if (result?.signedReadUrl) setEvidenceUrl(result.signedReadUrl);
  }

  async function execute(input: { build: string; buildFields?: Record<string, unknown>; confirm: string; signer: "owner" | "worker"; prompt: string }) {
    if (!task) return;
    const pendingRecord = readPending(task.id);
    const result = await wallet.signTransaction({ taskId: task.id, buildAction: input.build, buildFields: input.buildFields, confirmAction: input.confirm, signer: input.signer, prompt: input.prompt });
    if (result && typeof result === "object" && "cancelled" in result) {
      if ("prerequisiteReady" in result && result.prerequisiteReady) {
        setScorePrepared(true);
        await refreshAll();
      }
      setPending(readPending(task.id));
    }
    else if (result) {
      if ("prerequisiteReady" in result && result.prerequisiteReady) setScorePrepared(true);
      setPending(null);
      await refreshAll();
    } else {
      setPending(readPending(task.id) ?? pendingRecord);
    }
  }

  async function resumePrepared() {
    if (!pending || pending.phase !== "prepared" || !task) return;
    const actions: Record<string, { build: string; signer: "owner" | "worker"; prompt: string }> = {
      confirm_funding: { build: "fund_task", signer: "owner", prompt: `Resume the frozen funding transaction for “${task.title}” on mainnet?` },
      confirm_submission: { build: "build_submission", signer: "worker", prompt: `Resume the frozen delivery commitment for “${task.title}” on mainnet?` },
      confirm_release: { build: "build_release", signer: "owner", prompt: `Resume the frozen payment release for “${task.title}” on mainnet?` },
      confirm_refund: { build: "build_refund", signer: "owner", prompt: `Resume the frozen deadline refund for “${task.title}” on mainnet?` },
      confirm_timeout_claim: { build: "build_timeout_claim", signer: "worker", prompt: `Resume the frozen review-window claim for “${task.title}” on mainnet?` },
      confirm_reject: { build: "build_reject", signer: "owner", prompt: `Resume the frozen rejection transaction for “${task.title}” on mainnet?` },
      confirm_rating: { build: "build_rating", signer: "owner", prompt: `Resume the frozen ${String(pending.buildFields?.stars ?? task.rating?.stars ?? stars)}-star rating for “${task.title}” on mainnet?` },
      confirm_score_setup: { build: "build_score_setup", signer: "worker", prompt: `Resume the frozen reputation-score setup for “${task.title}” on mainnet?` },
    };
    const action = actions[pending.confirmAction];
    if (!action) {
      controller.setError("This saved transaction cannot be resumed from this page. Refresh the task and contact support if the receipt is missing.");
      return;
    }
    if (["confirm_funding", "confirm_release", "confirm_reject"].includes(pending.confirmAction) && !consentChecked) {
      controller.setError("Review the active owner approval and confirm its exact terms before retrying.");
      return;
    }
    const result = await wallet.signTransaction({
      taskId: task.id,
      buildAction: action.build,
      buildFields: action.build === "build_rating" ? { stars: pending.buildFields?.stars ?? task.rating?.stars ?? stars } : undefined,
      confirmAction: pending.confirmAction,
      signer: action.signer,
      prompt: action.prompt,
      expectedStage: pendingStage(pending),
    });
    if (result && typeof result === "object" && "cancelled" in result) {
      if ("prerequisiteReady" in result && result.prerequisiteReady) {
        setScorePrepared(true);
        await refreshAll();
      }
      setPending(readPending(task.id));
    }
    else if (result) {
      setPending(null);
      await refreshAll();
    } else setPending(readPending(task.id));
  }

  async function confirmPending() {
    if (!pending) return;
    const confirmed = await wallet.retryConfirmation(pending);
    if (confirmed) {
      setPending(null);
      await refreshAll();
    }
  }

  const state = controller.browser;
  const owner = task && state?.session.owner?.id === task.ownerId;
  const worker = task && state?.session.worker?.id === task.worker?.id;
  const hireApproval = state?.approvals.find((approval) => approval.taskId === taskId && approval.kind === "HIRE" && isApprovalCurrent(approval));
  const fundingAction = owner ? ownerFundingAction(task?.state ?? "", hireApproval?.status) : null;
  const releaseApproval = state?.approvals.find((approval) => approval.taskId === taskId && approval.kind === "RELEASE" && isApprovalCurrent(approval));
  const rejectApproval = state?.approvals.find((approval) => approval.taskId === taskId && approval.kind === "REJECT" && isApprovalCurrent(approval));
  const pendingNeedsOwnerConsent = !!pending && ["confirm_funding", "confirm_release", "confirm_reject"].includes(pending.confirmAction);
  useEffect(() => { setConsentChecked(false); }, [taskId, hireApproval?.id, hireApproval?.status, releaseApproval?.id, releaseApproval?.status, rejectApproval?.id, rejectApproval?.status]);
  const deadlinePassed = !!task && Date.now() >= new Date(task.deadline).getTime();
  const reviewWindowEnded = !!task?.reviewEndsAt && Date.now() >= new Date(task.reviewEndsAt).getTime();
  const feeSnapshotReady = task?.settlement?.fundingFeeBps != null && task.settlement.fundingFeeAtomic != null && task.settlement.fundingNetAtomic != null;
  const feeAcknowledgementNeeded = !!task?.settlement?.feeChanged && !task.settlement.feeAcknowledgedAt;
  const paymentAccountReady = !!task?.settlement?.scoreReady || scorePrepared;
  const deliveryReady = deliveryPrerequisitesReady(task?.settlement, paymentAccountReady);
  const ownerLifecycleStep = ownerTaskLifecycleStep(task?.state ?? "");

  async function acknowledgeFundedFee() {
    const result = await controller.run(() => controller.call("acknowledge_funding_fee", { taskId }));
    if (result) {
      controller.setNotice("The finalized funding fee is accepted. You can continue with the task delivery.");
      await refreshAll();
    }
  }

  async function refreshFundingApproval() {
    setConsentChecked(false);
    const result = await controller.run(() => controller.call("owner_request_hire", { agentId: task!.agentId, taskId }));
    if (result !== null) {
      await refreshAll();
      setConsentChecked(false);
      controller.setNotice("Funding quote and approval refreshed. Review the current terms and confirm consent again before signing.");
    }
  }

  return <main className="page-shell">
    <a className="task-back-link" href="/">← Back to open tasks</a>
    <Feedback error={controller.error || loadError || controller.loadError} notice={controller.notice} />
    {!task && taskLoading ? <section className="detail-section task-detail task-detail--loading"><p className="eyebrow">Task details</p><h1>Task details</h1><p>Task requirements, reward, and current status are loading.</p><LoadingState label="Loading task details…" variant="detail" /></section> : !task ? <EmptyState title="Task unavailable">This task may have been removed, or its details are not available.</EmptyState> : <>
      <section className="detail-section task-detail">
        <div className="detail-head"><div><p className="eyebrow">Task details</p><h1>{task.title}</h1></div><StatusBadge value={task.state} tone={taskTone(task.state)} /></div>
        <div className="task-facts"><div><span>Category</span><strong>{task.category}</strong></div><div><span>Area</span><strong>{task.area}</strong></div><div><span>Task amount</span><strong>{formatAtomic(task.amountAtomic, task.asset)}</strong></div><div><span>Deadline</span><strong>{dateLabel(task.deadline)}</strong></div><div><span>Worker</span><strong>{task.worker ? <a href={task.worker.profilePath}>{task.worker.displayName}</a> : "Not selected"}</strong></div><div><span>Escrow state</span><strong>{task.settlement?.status ?? "Not funded"}</strong></div></div>
        {task.legacyReadOnly && <Callout title="Legacy SUI testnet record" tone="warning">This historical task is read-only. New applications and payments use mainnet USDC.</Callout>}
        {task.brief ? <p className="task-detail__brief">{task.brief}</p> : <Callout title="Full task brief is private" tone="info">A verified, wallet-linked worker can read the full brief for an open task before applying. Owners and the selected worker can read it throughout the task.</Callout>}
        {task.checklist.length > 0 && <div className="rubric-panel"><strong>Delivery checklist</strong><ul>{task.checklist.map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}</ul></div>}
        {task.quote && <div className="quote-panel"><strong>Current owner quote</strong><span>Gross {formatAtomic(task.quote.grossAtomic, task.asset)}</span><span>Estimated fee {task.quote.feeAtomic == null ? "Not available" : formatAtomic(task.quote.feeAtomic, task.asset)}</span><span>Estimated worker net {task.quote.netAtomic == null ? "Not available" : formatAtomic(task.quote.netAtomic, task.asset)}</span><small>Fee is an estimate until the funded job’s fee snapshot is verified.</small></div>}
        {task.settlement?.fundingFeeBps != null && <div className="quote-panel"><strong>Finalized funding fee</strong><span>Owner quote fee {task.settlement.feeQuoteAtomic == null ? "Not available" : formatAtomic(task.settlement.feeQuoteAtomic, task.asset)}{task.settlement.feeQuoteBps == null ? "" : ` · ${task.settlement.feeQuoteBps / 100}%`}</span><span>Actual funded fee {task.settlement.fundingFeeAtomic == null ? "Not available" : formatAtomic(task.settlement.fundingFeeAtomic, task.asset)} · {task.settlement.fundingFeeBps / 100}%</span><span>Net if fully released {task.settlement.fundingNetAtomic == null ? "Not available" : formatAtomic(task.settlement.fundingNetAtomic, task.asset)}</span><small>This estimate uses the full task amount; a later on-chain rejection uses the agreed split and its final fee. Final settlement amounts appear after receipt confirmation.</small></div>}
        {worker && task.state === "FUNDED" && feeAcknowledgementNeeded && <Callout title="Review and accept the finalized fee before work" tone="warning">The actual funded fee differs from the owner's estimate. If you decline, do not start work, upload evidence, or submit delivery. The owner may request and sign an on-chain refund after the task deadline while no delivery has been submitted. There is no instant refund or automatic payout. <button className="button button--small" disabled={controller.busy} onClick={() => void acknowledgeFundedFee()}>Accept actual fee and continue</button></Callout>}
        {worker && task.state === "FUNDED" && feeSnapshotReady && task.settlement?.feeChanged && task.settlement.feeAcknowledgedAt && <p className="muted-copy">You accepted the finalized fee on {dateLabel(task.settlement.feeAcknowledgedAt)}.</p>}
        <div className="next-action"><p className="eyebrow">Next action</p><strong>{task.nextAction}</strong>{task.deliveredAt && <span>Delivery confirmed by escrow: {dateLabel(task.deliveredAt)}.</span>}{task.reviewEndsAt && <span>Worker claim becomes available after {dateLabel(task.reviewEndsAt)}. Time passing does not submit the claim transaction.</span>}</div>
        {owner && <section className="owner-task-lifecycle" aria-label="Owner task lifecycle"><p className="eyebrow">Owner task path</p><h3>{task.state === "CANCELLED" ? "Task closed before funding" : task.state === "REFUNDED" ? "Task closed after refund" : "Follow the task through payment"}</h3><ol className="owner-task-lifecycle__steps">{["Posted · applicants", "Choose one", "Approve and fund", "Await delivery", "Review and pay"].map((label, index) => { const step = index + 1; const done = ownerLifecycleStep != null && step < ownerLifecycleStep; const current = ownerLifecycleStep === step; return <li key={label} data-state={done ? "done" : undefined} aria-current={current ? "step" : undefined}>{label}</li>; })}</ol><p className="owner-task-lifecycle__note">{task.state === "CANCELLED" || task.state === "REFUNDED" ? "No payment is pending for this closed task. Open tasks that continue show the current owner action above." : task.state === "REJECTED" ? "The rejection settlement is complete; the task has reached its final payment stage." : task.state === "PAID" ? "Payment is confirmed. You can now leave a rating for the worker." : "The review window is measured from confirmed worker delivery. Posting and worker selection do not start that window."}</p></section>}
        {controller.browser?.session.worker && task.state === "OPEN" && task.canApply && !task.applicationStatus && <div className="application-form"><label>Application note (optional)<textarea value={applicationNote} maxLength={500} onChange={(event) => setApplicationNote(event.currentTarget.value)} placeholder="A short note about your relevant experience" /></label><button className="button button--primary" disabled={controller.busy} onClick={() => void apply()}>Apply for this task</button></div>}
        {task.state === "OPEN" && task.applicationStatus && <p className="muted-copy">Application status: <strong>{task.applicationStatus}</strong></p>}
        {task.state === "OPEN" && !controller.browser?.session.worker && <p className="muted-copy">To apply, create or recover a worker profile from <a href="/work">My work</a>.</p>}
        {task.isOwner && task.state === "OPEN" && <a className="button" href={`/agents?task=${task.id}`}>Review applicants</a>}
      </section>

      {task.evidence && <section className="evidence-panel evidence-panel--detail"><div><p className="eyebrow">Private delivery evidence</p><strong>{task.evidence.mediaType} · {(task.evidence.byteLength / 1024).toFixed(0)} KiB</strong><small>Uploaded {dateLabel(task.evidence.uploadedAt)} · SHA-256 <code>{task.evidence.sha256}</code></small><p>{task.evidence.report}</p></div>{evidenceUrl ? <a className="button" href={evidenceUrl} target="_blank" rel="noreferrer">Open private image ↗</a> : (owner || worker) && <button className="button" disabled={controller.busy} onClick={() => void loadEvidenceLink()}>Load short-lived private image link</button>}</section>}

      {worker && task.state === "FUNDED" && !paymentAccountReady && <div className="detail-section"><p className="eyebrow">Seller payment account</p><h3>Prepare the t2000 payment account</h3><p>This one-time Sui transaction prepares your seller account so the escrow can later record delivery. It uses network gas only and does not transfer the task reward.{feeAcknowledgementNeeded ? " Accept the finalized fee above before preparing the account." : ""}</p><button className="button button--primary" disabled={controller.busy || !wallet.account || !feeSnapshotReady || feeAcknowledgementNeeded} onClick={() => void execute({ build: "build_score_setup", confirm: "confirm_score_setup", signer: "worker", prompt: "Create your t2000 seller payment account? This transaction uses Sui network gas only and does not transfer task funds." })}>{wallet.account ? "Prepare payment account" : "Connect linked wallet to prepare"}</button></div>}
      {worker && task.state === "FUNDED" && paymentAccountReady && <p className="muted-copy">Your t2000 seller payment account is ready for delivery.</p>}
      {worker && task.state === "FUNDED" && !feeSnapshotReady && <Callout title="Waiting for the verified funding fee" tone="info">Delivery remains unavailable until the confirmed escrow fee snapshot is loaded.</Callout>}
      {worker && task.state === "FUNDED" && !task.evidence && <form className="evidence-form" onSubmit={uploadEvidence}>
        <p className="eyebrow">Deliver the work</p><label>Work report<textarea required maxLength={5000} disabled={!deliveryReady || controller.busy} value={report} onChange={(event) => setReport(event.currentTarget.value)} placeholder="Describe what you completed against the checklist." /></label>
        <label>Evidence image<input required type="file" disabled={!deliveryReady || controller.busy} accept="image/jpeg,image/png,image/webp" onChange={(event) => setFile(event.currentTarget.files?.[0] ?? null)} /></label>
        <small>One JPEG, PNG, or WebP image · 4 MiB maximum. The file remains private to task participants.</small>
        {previewUrl && <figure className="evidence-preview"><img src={previewUrl} alt="Selected evidence preview" /><figcaption>{file?.name} · {(file?.size ?? 0) / 1024 < 1024 ? `${Math.ceil((file?.size ?? 0) / 1024)} KiB` : "image"}</figcaption></figure>}
        <button className="button button--primary" disabled={!deliveryReady || controller.busy || !file || !report.trim()}>Upload private evidence</button>
      </form>}
      {worker && task.state === "FUNDED" && task.evidence && <button className="button button--primary" disabled={!deliveryReady || controller.busy || task.legacyReadOnly} onClick={() => void execute({ build: "build_submission", confirm: "confirm_submission", signer: "worker", prompt: `Submit the evidence commitment for “${task.title}” to the mainnet escrow? The report and image stay private.` })}>Sign delivery commitment</button>}

      {owner && fundingAction === "request" && <button className="button button--primary" disabled={controller.busy || !state?.session.owner?.walletVerified || task.legacyReadOnly} onClick={() => void controller.run(() => controller.call("owner_request_hire", { agentId: task.agentId, taskId: task.id })).then(() => void refreshAll())}>Request funding approval</button>}
      {owner && (task.state === "ASSIGNED" || task.state === "FUNDING") && hireApproval && <OwnerApproval approval={hireApproval} taskTitle={task.title} busy={controller.busy} consent={consentChecked} onConsent={setConsentChecked} onAuthorize={() => void wallet.beginApproval(hireApproval.id)} />}
      {owner && canRefreshFundingApproval(task.state, hireApproval?.status) && <button className="button button--small" disabled={controller.busy || !state?.session.owner?.walletVerified || task.legacyReadOnly} onClick={() => void refreshFundingApproval()}>Refresh funding quote and approval</button>}
      {owner && fundingAction === "sign" && pending?.confirmAction !== "confirm_funding" && <button className="button button--primary" disabled={controller.busy || !state?.session.owner?.walletVerified || !consentChecked || task.legacyReadOnly} onClick={() => void execute({ build: "fund_task", confirm: "confirm_funding", signer: "owner", prompt: `Fund ${formatAtomic(task.amountAtomic, task.asset)} for ${task.worker?.displayName ?? "the selected worker"} on mainnet Sui? The amount, worker, and payout wallet are fixed in this transaction.` })}>Fund escrow</button>}
      {owner && canCancelUnfundedTask(task.state) && <button className="button" disabled={controller.busy || task.legacyReadOnly} onClick={() => {
        if (!window.confirm(`Cancel “${task.title}”? This is available only before funding and the server will verify that no escrow transaction is active.`)) return;
        void controller.run(() => controller.call("cancel_task", { taskId: task.id })).then(() => void refreshAll());
      }}>Cancel unfunded task</button>}

      {(task.state === "SUBMITTED" || task.state === "REVIEW") && owner && <div className="detail-actions"><button className="button button--primary" disabled={controller.busy || !task.evidence} onClick={() => void controller.run(() => controller.call("owner_review_submission", { agentId: task.agentId, taskId, decision: "accept" })).then(() => void refreshAll())}>Accept delivery</button><button className="button" disabled={controller.busy} onClick={() => void controller.run(() => controller.call("owner_review_submission", { agentId: task.agentId, taskId, decision: "request_review", note: "Please review the delivery against the posted checklist." })).then(() => void refreshAll())}>Request off-chain review</button></div>}
      {(task.state === "SUBMITTED" || task.state === "REVIEW") && owner && <p className="muted-copy">If you disagree with the delivery, request an off-chain review. That process does not trigger an on-chain rejection or platform arbitration.</p>}
      {owner && task.reviewDecision === "ACCEPT" && (task.state === "SUBMITTED" || task.state === "REVIEW") && <button className="button button--primary" disabled={controller.busy || !state?.session.owner?.walletVerified} onClick={() => void controller.run(() => controller.call("owner_request_release", { agentId: task.agentId, taskId })).then(() => void refreshAll())}>Request payment approval</button>}
      {owner && releaseApproval && <OwnerApproval approval={releaseApproval} taskTitle={task.title} busy={controller.busy} consent={consentChecked} onConsent={setConsentChecked} onAuthorize={() => void wallet.beginApproval(releaseApproval.id)} />}
      {owner && releaseApproval && ["APPROVED", "ISSUED"].includes(releaseApproval.status) && pending?.confirmAction !== "confirm_release" && <button className="button button--primary" disabled={controller.busy || !state?.session.owner?.walletVerified || !consentChecked} onClick={() => void execute({ build: "build_release", confirm: "confirm_release", signer: "owner", prompt: `Release the agreed payment for “${task.title}” to ${task.worker?.displayName ?? "the selected worker"}?` })}>Approve payment</button>}
      {owner && task.reviewDecision === "REQUEST_REVIEW" && (task.state === "SUBMITTED" || task.state === "REVIEW") && !rejectApproval && <button className="button" disabled={controller.busy || !state?.session.owner?.walletVerified} onClick={() => void controller.run(() => controller.call("owner_request_reject", { agentId: task.agentId, taskId })).then(() => void refreshAll())}>Request rejection approval</button>}
      {owner && rejectApproval && <OwnerApproval approval={rejectApproval} taskTitle={task.title} busy={controller.busy} consent={consentChecked} onConsent={setConsentChecked} onAuthorize={() => void wallet.beginApproval(rejectApproval.id)} />}
      {owner && rejectApproval && ["APPROVED", "ISSUED"].includes(rejectApproval.status) && pending?.confirmAction !== "confirm_reject" && <button className="button button--primary" disabled={controller.busy || !state?.session.owner?.walletVerified || !consentChecked} onClick={() => void execute({ build: "build_reject", confirm: "confirm_reject", signer: "owner", prompt: `Apply the agreed ${workerSharePercent(task.terms.rejectSplitBps)}% worker share on “${task.title}” through the mainnet escrow rejection transaction? The actual payout is subject to protocol fees.` })}>Approve rejection settlement</button>}
      {task.state === "FUNDED" && owner && deadlinePassed && <><Callout title="Undelivered escrow refund" tone="warning">After the delivery deadline, the owner can start a refund while the task remains unsubmitted. The refund requires its own owner-signed transaction; account preparation, if needed, uses network gas and does not move escrow.</Callout><button className="button" disabled={controller.busy || !state?.session.owner?.walletVerified || task.legacyReadOnly} onClick={() => void execute({ build: "build_refund", confirm: "confirm_refund", signer: "owner", prompt: `Sign the separate mainnet escrow refund for ${formatAtomic(task.amountAtomic, task.asset)} to the owner? This is available only after the deadline while the task remains unsubmitted.` })}>Start deadline refund</button></>}
      {worker && (task.state === "SUBMITTED" || task.state === "REVIEW") && reviewWindowEnded && <button className="button button--primary" disabled={controller.busy || task.legacyReadOnly} onClick={() => void execute({ build: "build_timeout_claim", confirm: "confirm_timeout_claim", signer: "worker", prompt: `Submit the worker claim for “${task.title}” after the review window? Time has passed, but payment happens only after this transaction confirms.` })}>Submit worker review-window claim</button>}
      {owner && (task.state === "PAID" || task.state === "REJECTED") && !task.rating && <RatingPanel busy={controller.busy} stars={stars} setStars={setStars} onSubmit={async () => {
        if (!window.confirm(`Rate this verified completed task ${stars} out of 5 stars on mainnet? The public rating is separate from delivery approval.`)) return;
        await execute({ build: "build_rating", buildFields: { stars }, confirm: "confirm_rating", signer: "owner", prompt: `Submit a ${stars}-star public rating for “${task.title}” on mainnet?` });
      }} />}
      {owner && task.rating && !task.rating.confirmedAt && <Callout title="Rating awaits receipt confirmation" tone="warning">This rating is not public yet. The worker profile shows ratings only after the mainnet receipt confirms.{pending?.confirmAction === "confirm_rating" && pending.phase === "submitted" ? <button className="button button--small" disabled={controller.busy} onClick={() => void confirmPending()}>Retry rating receipt confirmation</button> : <button className="button button--small" disabled={controller.busy || !state?.session.owner?.walletVerified} onClick={() => void execute({ build: "build_rating", buildFields: { stars: task.rating!.stars }, confirm: "confirm_rating", signer: "owner", prompt: `Resume the frozen ${task.rating!.stars}-star rating for “${task.title}” on mainnet?` })}>Resume frozen rating transaction</button>}</Callout>}
      {task.rating?.confirmedAt && <div className="rating-panel"><p className="eyebrow">Public t2000 rating</p><strong>{"★".repeat(task.rating.stars)}{"☆".repeat(5 - task.rating.stars)}</strong><small>Receipt confirmed {dateLabel(task.rating.confirmedAt)}</small></div>}

      {pending && <Callout title={pending.phase === "submitted" ? "Wallet receipt needs server confirmation" : "Frozen wallet transaction ready"} tone="warning">
        {pendingStage(pending) === "legacy" && pending.confirmAction === "confirm_refund"
          ? <>This older saved attempt may be account setup or an escrow refund. {pending.phase === "submitted" ? <>Retry server confirmation for receipt <code>{pending.digest}</code>; do not sign another transaction yet.</> : "It will be cleared or reconciled before a fresh, separate refund can be signed."}</>
          : pendingStage(pending) === "score_setup"
            ? <>This transaction only prepares the t2000 payment account and uses network gas; it does not send or refund task funds. {pending.phase === "submitted" ? <>Retry server confirmation for receipt <code>{pending.digest}</code>.</> : "Reconnect the same linked wallet to retry the account setup."}</>
            : pending.phase === "submitted"
              ? <>No new transaction is needed. Retry server confirmation for receipt <code>{pending.digest}</code>.</>
              : <>The transaction bytes are saved for this task. Reconnect the same linked wallet and retry; cancelling the wallet prompt does not change task state.{pendingNeedsOwnerConsent && " Review the active approval and check its exact-terms consent above before retrying."}</>}
        {pending.phase === "submitted" && <button className="button button--small" disabled={controller.busy} onClick={() => void confirmPending()}>Retry receipt confirmation</button>}
        {pending.phase === "prepared" && <button className="button button--small" disabled={controller.busy || (pendingNeedsOwnerConsent && !consentChecked)} onClick={() => void resumePrepared()}>{pendingStage(pending) === "score_setup" ? "Reconnect wallet and retry account setup" : "Reconnect wallet and retry frozen transaction"}</button>}
      </Callout>}

      {task.state !== "OPEN" && task.state !== "PAID" && task.state !== "REFUNDED" && task.state !== "CANCELLED" && <p className="refund-copy">Terms: {task.terms.reviewWindowMs / 60_000} minute review window · {workerSharePercent(task.terms.rejectSplitBps)}% of gross goes to the worker on an on-chain rejection, before actual fees. Submitted disagreements use off-chain review; there is no platform arbitration.</p>}
      <section className="activity-panel"><p className="eyebrow">Task timeline</p>{task.timeline.map((event, index) => <div className="activity-row" key={`${event.state}-${index}`}><span><i />{event.label}</span><time>{dateLabel(event.at)}</time></div>)}</section>
    </>}
  </main>;
}

function OwnerApproval({ approval, taskTitle, busy, consent, onConsent, onAuthorize }: {
  approval: ExperienceBrowserState["approvals"][number]; taskTitle: string; busy: boolean; consent: boolean;
  onConsent: (checked: boolean) => void; onAuthorize: () => void;
}) {
  const asset = { symbol: approval.asset, coinType: "", decimals: approval.decimals, network: approval.network };
  const authorized = ["APPROVED", "ISSUED"].includes(approval.status);
  return <section className="approval-card"><p className="eyebrow">Exact owner approval · {approval.kind.toLowerCase()}</p><h3>{taskTitle}</h3><p>Worker: {approval.workerName ?? "Selected worker"} · gross {formatAtomic(approval.amountAtomic, asset)}</p><div className="approval-terms"><span>Recipient wallet <code>{shortAddress(approval.workerWallet)}</code></span><span>Owner wallet <code>{shortAddress(approval.ownerWallet)}</code></span><span>Review window {approval.reviewWindowMs / 60_000} minutes · worker share on rejection {workerSharePercent(approval.rejectSplitBps)}%</span><span>Estimated fee {approval.feeQuoteAtomic == null ? "Not available" : formatAtomic(approval.feeQuoteAtomic, asset)}{approval.feeQuoteBps == null ? "" : ` · ${approval.feeQuoteBps / 100}%`}</span><span>Estimated worker net {approval.netQuoteAtomic == null ? "Not available" : formatAtomic(approval.netQuoteAtomic, asset)}</span></div><label className="approval-confirm"><input type="checkbox" checked={consent} onChange={(event) => onConsent(event.currentTarget.checked)} /><span>I reviewed the task, recipient wallet, amount and terms. These exact details are fixed in the approval and transaction.</span></label>{authorized ? <p className="muted-copy">Owner approval is {approval.status.toLowerCase()}. Connect the wallet linked to this owner account to sign the frozen transaction.</p> : <button className="button button--primary" disabled={busy || !consent} onClick={onAuthorize}>Start fresh World authorization</button>}<small>Approval reference <code>{approval.id}</code></small></section>;
}

function RatingPanel({ busy, stars, setStars, onSubmit }: { busy: boolean; stars: number; setStars: (value: number) => void; onSubmit: () => void }) {
  return <section className="rating-panel"><p className="eyebrow">Rate completed work</p><p>Owner rating is separate from delivery acceptance.</p><div className="rating-stars" role="group" aria-label="Rating from one to five stars">{[1, 2, 3, 4, 5].map((value) => <button key={value} type="button" aria-label={`${value} stars`} aria-pressed={stars === value} onClick={() => setStars(value)}>{value <= stars ? "★" : "☆"}</button>)}</div><button className="button" disabled={busy} onClick={onSubmit}>Submit public rating</button></section>;
}

export function WorkPage() {
  return <PageFrame><WorkContent /></PageFrame>;
}

function WorkContent() {
  const controller = useExperienceController();
  const wallet = useWalletActions(controller);
  const [dashboard, setDashboard] = useState<WorkDashboard | null>(null);
  const [dashboardLoading, setDashboardLoading] = useState(false);
  const [dashboardError, setDashboardError] = useState("");
  const [idKitStart, setIdKitStart] = useState<IDKitStart | null>(null);

  const workerId = controller.browser?.session.worker?.id;
  const loadDashboard = useCallback(async () => {
    if (!workerId) { setDashboard(null); setDashboardLoading(false); setDashboardError(""); return; }
    setDashboard(null);
    setDashboardError("");
    setDashboardLoading(true);
    try {
      const result = await readExperience<{ dashboard: WorkDashboard }>("work");
      setDashboard(result.dashboard);
    } catch (cause) {
      setDashboardError(cause instanceof Error ? cause.message : "Work history is unavailable.");
    } finally {
      setDashboardLoading(false);
    }
  }, [workerId]);

  useEffect(() => { void loadDashboard(); }, [loadDashboard]);

  async function createWorker(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const result = await controller.run(() => controller.call("start_worker", {
      displayName: String(form.get("displayName") ?? "").trim(),
      category: String(form.get("category") ?? "").trim().toLowerCase().replaceAll(" ", "-"),
      area: String(form.get("area") ?? "").trim(),
      skills: String(form.get("skills") ?? "").split(",").map((value) => value.trim()).filter(Boolean),
    }));
    if (result) {
      await loadDashboard();
      controller.setNotice(`Worker profile created. Link your payout wallet and complete the ${worldEnvironmentDisclosure(controller.browser?.config.worldIdentityEnvironment ?? null)} before applying.`);
    }
  }

  async function startIDKit() {
    const result = await controller.run(() => controller.call<IDKitStart>("start_worker_verification"), false);
    if (result) setIdKitStart(result);
  }

  async function completeIDKit(result: IDKitResult) {
    if (!idKitStart) return;
    const completed = await controller.run(() => controller.call("complete_worker_verification", { challengeId: idKitStart.challengeId, idkitResult: result }));
    if (completed) {
      setIdKitStart(null);
      controller.setNotice(`World accepted the ${worldEnvironmentDisclosure(idKitStart.request.environment)}. This check confirms account uniqueness only.`);
      await loadDashboard();
    }
  }

  const worker = controller.browser?.session.worker;
  const totals = dashboard?.totals;
  const dashboardPending = !!worker && (dashboardLoading || (!dashboard && !dashboardError));
  const sessionPending = !controller.browser && !controller.loadError;

  return <main className="page-shell">
    <section className="directory-hero directory-hero--compact"><p className="eyebrow">Worker workspace</p><h1>Applications. <span>Delivery. Earnings.</span></h1><p>See your selected work and count earnings from confirmed settlement receipts, not your wallet balance or a capped task feed.</p></section>
    <Feedback error={controller.error || controller.loadError || dashboardError} notice={controller.notice} />
    {sessionPending ? <section className="detail-section workspace-session"><p className="eyebrow">Worker profile</p><h2>Checking your account</h2><p>Your profile and account-specific actions will appear here when the session check completes.</p><LoadingState label="Checking worker session…" variant="inline" /></section>
      : !controller.browser ? null
      : !worker ? <section className="section-block workspace-grid"><form className="creator-wizard" onSubmit={(event) => void createWorker(event)}><p className="eyebrow">Worker profile</p><h2>Create or recover your profile</h2><label>Display name<input name="displayName" required maxLength={80} placeholder="Name shown to task owners" /></label><label>Primary category<input name="category" required maxLength={60} pattern="[a-zA-Z0-9][a-zA-Z0-9 _-]*" placeholder="inspection" /></label><label>Service area<input name="area" required maxLength={100} placeholder="District or region" /></label><label>Skills, separated by commas<input name="skills" maxLength={400} placeholder="photo documentation, field checks" /></label><button className="button button--primary" disabled={controller.busy}>Create worker profile</button></form><div className="detail-section"><p className="eyebrow">Returning worker</p><h2>Recover an existing profile</h2><p>Connect the wallet previously linked to your worker account that passed the configured identity check, then sign a new account recovery challenge.</p><button className="button" disabled={controller.busy || !wallet.account} onClick={() => void wallet.verifyWallet("recover_worker")}>{wallet.account ? "Recover with connected wallet" : "Connect wallet to recover"}</button></div></section>
      : <>
        <section className="detail-section worker-profile-summary"><div><p className="eyebrow">Your profile</p><h2>{worker.displayName}</h2><p>{worker.category} · {worker.area}</p></div><StatusBadge value={worker.status === "VERIFIED" ? "Eligible" : worker.status} tone={worker.status === "VERIFIED" ? "success" : "warning"} /><a className="button" href={`/workers/${worker.id}`}>Public profile</a></section>
        <section className="section-block workspace-grid">
          <div className="detail-section"><p className="eyebrow">Wallet and identity</p><h3>Worker eligibility</h3><p>Link the payout wallet you control with Slush or another Sui wallet. {worldEnvironmentDisclosure(controller.browser?.config.worldIdentityEnvironment ?? null)} checks this worker account for uniqueness; it does not verify delivery quality.</p><dl className="profile-facts"><div><dt>Payout wallet</dt><dd>{shortAddress(worker.walletAddress)}</dd></div><div><dt>World check</dt><dd>{worldCheckStatus(controller.browser?.config.worldIdentityEnvironment ?? null, worker.worldVerified)}</dd></div></dl><div className="detail-actions"><button className="button" disabled={controller.busy || !wallet.account} onClick={() => void wallet.verifyWallet("worker")}>{worker.walletVerified ? "Verify linked wallet" : wallet.account ? "Link connected wallet" : "Connect wallet to link"}</button><button className="button button--primary" disabled={controller.busy || !worker.walletVerified || !controller.browser?.config.workerVerificationConfigured || worker.worldVerified} onClick={() => void startIDKit()}>{worker.worldVerified ? "Identity check complete" : controller.browser?.config.worldIdentityEnvironment && controller.browser.config.worldIdentityEnvironment !== "production" ? `Start ${controller.browser.config.worldIdentityEnvironment} identity check` : "Start World identity check"}</button></div><small>This check establishes uniqueness only. It does not rate completed work or verify delivery evidence.</small></div>
          <div className="detail-section"><p className="eyebrow">Current account</p><h3>Connected wallet</h3><p>{wallet.account ? shortAddress(wallet.account.address) : "No wallet connected"}</p><p>Use the same linked address to submit delivery and receive settlement. If you cancel a wallet request, the frozen transaction remains ready for retry.</p></div>
        </section>
          <section className="section-block">
            <SectionHeading eyebrow="Earnings" title="Confirmed payment history" description="Mainnet USDC net earnings include only confirmed seller receipts. Pending escrow is shown separately." />
            {dashboardPending ? (
              <div className="stat-grid" role="status" aria-label="Loading earnings">
                <article><span>Lifetime gross</span><LoadingState label="Loading lifetime gross" variant="inline" /></article>
                <article><span>Fees</span><LoadingState label="Loading fees" variant="inline" /></article>
                <article><span>Lifetime net</span><LoadingState label="Loading lifetime net" variant="inline" /></article>
                <article><span>This month net</span><LoadingState label="Loading this month net" variant="inline" /></article>
                <article><span>Pending escrow</span><LoadingState label="Loading pending escrow" variant="inline" /></article>
              </div>
            ) : dashboardError ? (
              <p className="muted-copy">Earnings are unavailable until work history can be loaded.</p>
            ) : dashboard ? (
              <>
                <div className="stat-grid">
                  <article><span>Lifetime gross</span><strong>{formatAtomic(totals!.lifetimeGrossAtomic, totals!.asset)}</strong></article>
                  <article><span>Fees</span><strong>{formatAtomic(totals!.lifetimeFeeAtomic, totals!.asset)}</strong></article>
                  <article><span>Lifetime net</span><strong>{formatAtomic(totals!.lifetimeNetAtomic, totals!.asset)}</strong></article>
                  <article><span>This month net</span><strong>{formatAtomic(totals!.monthNetAtomic, totals!.asset)}</strong></article>
                  <article><span>Pending escrow</span><strong>{formatAtomic(totals!.pendingAtomic, totals!.asset)}</strong></article>
                </div>
                {dashboard.legacyReadOnly.length > 0 && <p className="muted-copy">Historical SUI testnet records ({dashboard.legacyReadOnly.map((item) => `${item.recordCount} ${item.asset.symbol} record${item.recordCount === 1 ? "" : "s"}`).join(", ")}) are read-only and excluded from USDC earnings.</p>}
              </>
            ) : null}
          </section>
          <section className="section-block">
            <SectionHeading eyebrow="Applications and work" title="Tasks you applied for or completed" description="Open each detail page for the exact delivery checklist, current escrow state and next action." />
            {dashboardPending ? <LoadingState label="Loading applications and work…" variant="list" />
              : dashboardError ? <p className="muted-copy">Applications are unavailable until work history can be loaded.</p>
              : dashboard ? dashboard.tasks.length === 0
                ? <EmptyState title="No applications or assigned work yet">Browse open requests and apply after completing the worker identity and wallet checks.</EmptyState>
                : <div className="experience-list">{dashboard.tasks.map((task) => <article className="experience-row" key={task.id}><div><strong>{task.title}</strong><small>{task.category} · {task.area} · Due {dateLabel(task.deadline)}</small></div><StatusBadge value={task.state === "OPEN" ? task.applicationStatus ?? "OPEN" : task.state} tone={taskTone(task.state)} /><strong>{formatAtomic(task.amountAtomic, task.asset)}</strong><a className="button button--small" href={`/tasks/${task.id}`}>Open task</a></article>)}</div>
                : null}
          </section>
          <section className="section-block">
            <SectionHeading eyebrow="Receipts" title="Settlement ledger" description="Actual fee and net amounts appear after receipt confirmation. Pending rows are not counted as earned." />
            {dashboardPending ? <LoadingState label="Loading settlement receipts…" variant="list" />
              : dashboardError ? <p className="muted-copy">Receipts are unavailable until work history can be loaded.</p>
              : dashboard ? dashboard.payments.length === 0
                ? <EmptyState title="No escrow receipts yet">A confirmed settlement will appear here when t2000 reports its receipt.</EmptyState>
                : <div className="experience-list">{dashboard.payments.map((payment, index) => <article className="experience-row experience-row--receipt" key={`${payment.taskId}-${index}`}><div><strong>{payment.title}</strong><small>{payment.asset.network} · {payment.settledAt ? dateLabel(payment.settledAt) : `Settlement ${payment.settlementStatus.toLowerCase()}`}</small></div><StatusBadge value={payment.state} tone={taskTone(payment.state)} /><span>Gross {formatAtomic(payment.grossAtomic, payment.asset)}</span><span>Fee {payment.feeAtomic == null ? "Pending" : formatAtomic(payment.feeAtomic, payment.asset)}</span><strong>Net {payment.netAtomic == null ? "Pending" : formatAtomic(payment.netAtomic, payment.asset)}</strong>{payment.digest && <a href={`/tasks/${payment.taskId}`} className="button button--small">View receipt</a>}</article>)}</div>
                : null}
          </section>
      </>}
    {idKitStart && <><Callout title={`${worldEnvironmentDisclosure(idKitStart.request.environment)}`} tone="info">This environment checks that the worker account is unique. It does not certify work quality or prove that evidence is authentic.</Callout><IDKitRequestWidget open onOpenChange={(open) => { if (!open) setIdKitStart(null); }} app_id={idKitStart.request.app_id} action={idKitStart.request.action} rp_context={idKitStart.request.rp_context} environment={idKitStart.request.environment} allow_legacy_proofs={false} preset={proofOfHuman({ signal: idKitStart.request.signal })} handleVerify={completeIDKit} onSuccess={() => setIdKitStart(null)} onError={() => controller.setError("World could not complete this identity check. Start a fresh request and try again.")} /></>}
  </main>;
}

export function WorkerPage({ workerId }: { workerId: string }) {
  return <PageFrame><PublicWorkerContent workerId={workerId} /></PageFrame>;
}

function PublicWorkerContent({ workerId }: { workerId: string }) {
  const [worker, setWorker] = useState<PublicWorker | null>(null);
  const [workerLoading, setWorkerLoading] = useState(true);
  const [error, setError] = useState("");
  const [worldEnvironment, setWorldEnvironment] = useState<"production" | "staging" | "sandbox" | null>(null);
  useEffect(() => {
    let active = true;
    setWorker(null);
    setError("");
    setWorkerLoading(true);
    void readExperience<{ worker: PublicWorker }>("worker", { workerId }).then((result) => { if (active) setWorker(result.worker); }).catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : "Worker profile is unavailable."); }).finally(() => { if (active) setWorkerLoading(false); });
    void readExperienceState().then((state) => { if (active) setWorldEnvironment(state.config.worldIdentityEnvironment); }).catch(() => {});
    return () => { active = false; };
  }, [workerId]);
  return <main className="page-shell">
    {error && <Callout title="Worker profile unavailable" tone="danger">{error}</Callout>}
    <section className="directory-hero directory-hero--compact">
      <p className="eyebrow">Worker profile · account uniqueness check</p>
      <h1>{worker?.displayName ?? "Worker profile"}</h1>
      <p>{worker ? `${worker.category} · ${worker.area}` : "Public eligibility, ratings, and completed-work summaries."}</p>
      <div className="directory-collection-stats">{worker ? <><StatusBadge value={worldCheckBadge(worldEnvironment, worker.worldVerified)} tone={worker.worldVerified ? "success" : "warning"} /><span>{worker.skills.length ? worker.skills.join(" · ") : "No skills listed"}</span></> : workerLoading ? <LoadingState label="Loading worker summary…" variant="inline" /> : null}</div>
      <small>Identity checks are separate from public ratings and completed-work records.</small>
    </section>
    <section className="section-block"><div className="profile-rating-summary"><div><p className="eyebrow">Public rating</p>{worker ? worker.averageRating == null ? <strong>No reviews yet</strong> : <strong>{worker.averageRating.toFixed(2)} / 5 · {worker.reviewCount} review{worker.reviewCount === 1 ? "" : "s"}</strong> : workerLoading ? <LoadingState label="Loading public rating…" variant="inline" /> : <strong>Unavailable</strong>}</div><small>{worker ? worker.ratingSource === "t2000" ? "Rating source: t2000 on-chain reputation" : "Ratings appear after an eligible buyer submits one" : "Ratings are public only after an eligible buyer submits a confirmed rating."}</small></div></section>
    <section className="section-block"><SectionHeading eyebrow="Completed work" title="Recent public task summaries" description="These summaries contain no delivery report, evidence image or precise location." />{workerLoading ? <LoadingState label="Loading completed work…" variant="list" /> : worker?.recentTasks.length === 0 ? <EmptyState title="No completed tasks yet">Completed public task summaries appear after a settlement receipt is confirmed.</EmptyState> : worker && <div className="experience-list">{worker.recentTasks.map((task) => <article key={task.id} className="experience-row"><div><strong>{task.title}</strong><small>{task.category} · Completed {dateLabel(task.completedAt)}</small></div><span>{formatAtomic(task.amountAtomic, task.asset)}</span><a className="button button--small" href={`/tasks/${task.id}`}>Task record</a></article>)}</div>}</section>
    <a className="button button--primary" href="/">Browse open tasks</a>
  </main>;
}

export function AgentsPage() {
  return <PageFrame><AgentsContent /></PageFrame>;
}

function AgentsContent() {
  const controller = useExperienceController();
  const wallet = useWalletActions(controller);
  const [dashboard, setDashboard] = useState<OwnerDashboard | null>(null);
  const [dashboardLoading, setDashboardLoading] = useState(false);
  const [dashboardError, setDashboardError] = useState("");
  const [selectedTask, setSelectedTask] = useState("");
  const [applicantLists, setApplicantLists] = useState<Record<string, ApplicantList>>({});
  const [applicantLoading, setApplicantLoading] = useState<Record<string, boolean>>({});
  const [applicantErrors, setApplicantErrors] = useState<Record<string, string>>({});
  const [createdKey, setCreatedKey] = useState("");
  const [copyKeyNotice, setCopyKeyNotice] = useState("");
  const [agentId, setAgentId] = useState("");
  const [showProfileForm, setShowProfileForm] = useState(false);
  const [taskDraft, setTaskDraft] = useState<HiringTaskDraft>(EMPTY_HIRING_TASK_DRAFT);
  const [draftOwnerId, setDraftOwnerId] = useState<string | null>(null);
  const [createdTaskId, setCreatedTaskId] = useState("");
  const [createdTaskTitle, setCreatedTaskTitle] = useState("");

  const ownerId = controller.browser?.session.owner?.id;
  const loadDashboard = useCallback(async () => {
    if (!ownerId) { setDashboard(null); setDashboardLoading(false); setDashboardError(""); return; }
    setDashboard(null);
    setDashboardError("");
    setDashboardLoading(true);
    try {
      const result = await readExperience<{ dashboard: OwnerDashboard }>("agents");
      setDashboard(result.dashboard);
      setAgentId((current) => result.dashboard.agents.some((agent) => agent.id === current) ? current : result.dashboard.agents[0]?.id || "");
      setShowProfileForm(result.dashboard.agents.length === 0);
    } catch (cause) {
      setDashboardError(cause instanceof Error ? cause.message : "Owner workspace is unavailable.");
    } finally {
      setDashboardLoading(false);
    }
  }, [ownerId]);

  useEffect(() => { void loadDashboard(); }, [loadDashboard]);

  useEffect(() => {
    setTaskDraft(ownerId ? readHiringTaskDraft(ownerId) : { ...EMPTY_HIRING_TASK_DRAFT });
    setDraftOwnerId(ownerId ?? null);
  }, [ownerId]);

  useEffect(() => {
    if (!ownerId || draftOwnerId !== ownerId || typeof window === "undefined") return;
    try {
      const hasDraft = Object.entries(taskDraft).some(([key, value]) => value !== EMPTY_HIRING_TASK_DRAFT[key as keyof HiringTaskDraft]);
      if (hasDraft) window.sessionStorage.setItem(`${TASK_DRAFT_STORAGE_KEY}:${ownerId}`, JSON.stringify(taskDraft));
      else window.sessionStorage.removeItem(`${TASK_DRAFT_STORAGE_KEY}:${ownerId}`);
    } catch {
      // The controlled form remains usable when browser storage is blocked.
    }
  }, [taskDraft, draftOwnerId, ownerId]);

  async function createAgent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      const result = await controller.run(() => controller.call<{ apiKey: string; agentId: string }>("create_agent", {
        name: String(form.get("name") ?? "").trim(),
        categories: String(form.get("categories") ?? "").split(",").map((item) => item.trim().toLowerCase().replaceAll(" ", "-")).filter(Boolean),
        maxTaskAtomic: parseAtomic(String(form.get("maxTask") ?? ""), MAINNET_USDC),
        totalBudgetAtomic: parseAtomic(String(form.get("totalBudget") ?? ""), MAINNET_USDC),
      }), false);
      if (result) {
        setCreatedKey(result.apiKey);
        setCopyKeyNotice("");
        setAgentId(result.agentId);
        setShowProfileForm(false);
        await loadDashboard();
      }
    } catch (cause) {
      controller.setError(cause instanceof Error ? cause.message : "Agent could not be created.");
    }
  }

  async function createTask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const selectedAgentId = agentId || dashboard?.agents[0]?.id || "";
    if (!selectedAgentId) { controller.setError("Create or choose a hiring profile first."); return; }
    try {
      const deadline = new Date(taskDraft.deadline);
      if (Number.isNaN(deadline.getTime())) throw new Error("Set a valid deadline.");
      const terms = taskTermsFromForm(taskDraft.reviewWindowMinutes, taskDraft.rejectSplitPercent);
      const result = await controller.run<{ id?: string; taskId?: string }>(() => controller.call("owner_create_task", {
        agentId: selectedAgentId,
        title: taskDraft.title.trim(),
        brief: taskDraft.brief.trim(),
        category: taskDraft.category,
        area: taskDraft.area.trim(),
        rubric: taskDraft.checklist.split("\n").map((item) => item.trim()).filter(Boolean),
        amountAtomic: parseAtomic(taskDraft.amount, MAINNET_USDC),
        deadline: deadline.toISOString(),
        ...terms,
      }), false);
      if (result) {
        setCreatedTaskId(result.id ?? result.taskId ?? "");
        setCreatedTaskTitle(taskDraft.title.trim());
        setTaskDraft({ ...EMPTY_HIRING_TASK_DRAFT });
        await loadDashboard();
      }
    } catch (cause) {
      controller.setError(cause instanceof Error ? cause.message : "Task could not be created.");
    }
  }

  function updateTaskDraft(field: keyof HiringTaskDraft, value: string) {
    setTaskDraft((current) => ({ ...current, [field]: value }));
  }

  async function copyCreatedKey() {
    if (!createdKey) return;
    try {
      if (!navigator.clipboard) throw new Error("Clipboard access is unavailable.");
      await navigator.clipboard.writeText(createdKey);
      setCopyKeyNotice("Copied. Keep this key in your secret manager; it will not be shown again.");
    } catch {
      setCopyKeyNotice("Copy was unavailable. Select the key above and save it in your secret manager before dismissing this message.");
    }
  }

  async function showApplicants(taskId: string) {
    if (selectedTask === taskId) { setSelectedTask(""); return; }
    setSelectedTask(taskId);
    setApplicantLoading((current) => ({ ...current, [taskId]: true }));
    setApplicantErrors((current) => ({ ...current, [taskId]: "" }));
    try {
      const result = await readExperience<{ applicants: ApplicantList }>("applicants", { taskId });
      setApplicantLists((current) => ({ ...current, [taskId]: result.applicants }));
    } catch (cause) {
      setApplicantErrors((current) => ({ ...current, [taskId]: cause instanceof Error ? cause.message : "Applicants are unavailable." }));
    } finally {
      setApplicantLoading((current) => ({ ...current, [taskId]: false }));
    }
  }

  async function selectWorker(taskId: string, workerId: string) {
    const result = await controller.run(() => controller.experienceCall("select", { taskId, workerId }));
    if (result) {
      controller.setNotice("Worker selected. Their application is locked as the task assignee; the owner can now review exact funding terms.");
      await loadDashboard();
      const list = await readExperience<{ applicants: ApplicantList }>("applicants", { taskId });
      setApplicantLists((current) => ({ ...current, [taskId]: list.applicants }));
    }
  }

  const owner = controller.browser?.session.owner;
  const agents = dashboard?.agents ?? [];
  const activeAgent = agents.find((agent) => agent.id === agentId) ?? agents[0] ?? null;
  const dashboardPending = !!owner && (dashboardLoading || (!dashboard && !dashboardError));
  const sessionPending = !controller.browser && !controller.loadError;
  const walletReady = !!owner?.walletVerified;
  const profileReady = walletReady && !!dashboard && !dashboardError && agents.length > 0;
  const currentStep = !owner ? 1 : !walletReady ? 2 : !profileReady ? 3 : 4;
  const queryTaskId = typeof window === "undefined" ? "" : new URLSearchParams(window.location.search).get("task") ?? "";
  useEffect(() => { if (queryTaskId && dashboard?.tasks.some((task) => task.id === queryTaskId)) void showApplicants(queryTaskId); }, [queryTaskId, dashboard?.tasks]);

  return <main className="page-shell">
    <section className="directory-hero directory-hero--compact"><p className="eyebrow">Owner workspace · hire a human</p><h1>Set up once. <span>Hire with clarity.</span></h1><p>Follow four steps to identify the task owner, connect the payment wallet, set a hiring profile, and post work for a human to complete.</p><small>Posting a task never moves USDC. Payment happens only after worker delivery and the owner’s approval or the supported review-window claim.</small></section>
    <Feedback error={controller.error || controller.loadError || dashboardError} notice={controller.notice} />
    <section className="hiring-setup" aria-label="Hiring setup">
      <McpQuickStart />
      <ol className="hiring-progress" aria-label="Hiring setup progress">
        {["Sign in", "Link payment wallet", "Set spending limits", "Post a task"].map((label, index) => {
          const step = index + 1;
          const completed = step < currentStep;
          return <li key={label} className={completed ? "hiring-progress__item hiring-progress__item--complete" : step === currentStep ? "hiring-progress__item hiring-progress__item--current" : "hiring-progress__item"} aria-current={step === currentStep ? "step" : undefined}><span>{completed ? "✓" : step}</span><small>{label}</small></li>;
        })}
      </ol>
      <ol className="hiring-steps">
        <li className={`hiring-step ${currentStep === 1 ? "hiring-step--current" : owner ? "hiring-step--complete" : "hiring-step--locked"}`} aria-current={currentStep === 1 ? "step" : undefined}>
          <div className="hiring-step__number">1</div>
          <div className="hiring-step__body">
            <p className="eyebrow">Step 1</p><h2>Sign in as the owner</h2>
            <p>The owner identity is the person responsible for task instructions, worker selection, and payment approvals. World sign-in identifies that owner; it does not verify the worker and does not move funds.</p>
            {sessionPending && <div className="hiring-step__status"><LoadingState label="Checking owner session…" variant="inline" /> Checking your session before showing completed steps.</div>}
            {!sessionPending && !controller.browser && <div className="hiring-step__actions"><p>Setup status could not be loaded, so no step is marked complete.</p><button className="button" disabled={controller.busy} onClick={() => void controller.run(() => controller.refresh(), false)}>Retry setup status</button></div>}
            {controller.browser && !owner && <div className="hiring-step__actions"><button className="button button--primary" disabled={controller.busy || !controller.browser.config.ownerAuthenticationConfigured} onClick={() => void wallet.beginOwnerLogin()}>{controller.browser.config.ownerAuthenticationConfigured ? "Continue with World" : "Owner sign-in unavailable"}</button><button className="button" disabled={controller.busy || !wallet.account} onClick={() => void wallet.verifyWallet("recover_owner")}>{wallet.account ? "Recover owner by wallet" : "Connect wallet to recover"}</button></div>}
            {owner && <div className="hiring-step__status"><StatusBadge value="Owner identity signed in" tone="success" /><span>Owner wallet: {shortAddress(owner.walletAddress)}</span></div>}
          </div>
        </li>

        <li className={`hiring-step ${!owner ? "hiring-step--locked" : currentStep === 2 ? "hiring-step--current" : walletReady ? "hiring-step--complete" : "hiring-step--locked"}`} aria-current={currentStep === 2 ? "step" : undefined}>
          <div className="hiring-step__number">2</div>
          <div className="hiring-step__body">
            <p className="eyebrow">Step 2</p><h2>Link the payment wallet</h2>
            {!owner ? <p>Finish owner sign-in first. The wallet is linked to that owner after a personal signature.</p> : <>
              <p>Connect the Sui wallet that will approve funding, then sign a personal message to prove control. This signature only links the wallet; it does not make a deposit, start escrow, or charge USDC.</p>
              {!walletReady && <div className="hiring-step__actions"><ConnectButton instance={dAppKit} /><button className="button button--primary" disabled={controller.busy || !wallet.account} onClick={() => void wallet.verifyWallet("owner")}>{wallet.account ? "Sign to link this wallet" : "Connect a wallet first"}</button></div>}
              {walletReady && <div className="hiring-step__status"><StatusBadge value="Payment wallet linked" tone="success" /><span>{shortAddress(owner.walletAddress)} · personal signature verified</span><button className="button button--small" disabled={controller.busy || !wallet.account} onClick={() => void wallet.verifyWallet("owner")}>{wallet.account ? "Verify linked wallet" : "Connect linked wallet"}</button></div>}
            </>}
          </div>
        </li>

        <li className={`hiring-step ${!walletReady ? "hiring-step--locked" : currentStep === 3 ? "hiring-step--current" : profileReady ? "hiring-step--complete" : "hiring-step--locked"}`} aria-current={currentStep === 3 ? "step" : undefined}>
          <div className="hiring-step__number">3</div>
          <div className="hiring-step__body">
            <p className="eyebrow">Step 3</p><h2>Set spending limits in a hiring profile</h2>
            {!walletReady ? <p>Link the payment wallet first. This keeps the owner, budget policy, and later payment approvals tied to the same account.</p> : dashboardPending ? <div className="hiring-step__status"><LoadingState label="Loading hiring profiles…" variant="inline" /> Checking the owner dashboard; no profile is assumed complete.</div> : dashboardError ? <div className="hiring-step__actions"><p>Hiring profiles are unavailable, so this step is still pending.</p><button className="button" disabled={controller.busy} onClick={() => void loadDashboard()}>Retry profiles</button></div> : <>
              <p>A hiring profile stores allowed categories and USDC limits for posted work. It also issues one API key for your own AI or automation to call ask2human. Creating a profile does not launch an AI agent and does not post a task.</p>
              <p className="hiring-step__optional">Optional integration: <a href="/connect">Connect your own AI (MCP)</a> after saving the one-time key.</p>
              {agents.length > 0 && <div className="hiring-profile-picker"><label>Profile for the next task<select value={activeAgent?.id ?? ""} onChange={(event) => setAgentId(event.currentTarget.value)}>{agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name} · {formatAtomic(agent.availableAtomic, agent.asset)} available</option>)}</select></label><div className="hiring-step__status"><StatusBadge value="Spending profile ready" tone="success" /><span>{agents.length} profile{agents.length === 1 ? "" : "s"} available</span></div></div>}
              {agents.length > 0 && !showProfileForm && <button className="button" onClick={() => setShowProfileForm(true)}>Create another hiring profile</button>}
              {(showProfileForm || agents.length === 0) && <form className="creator-wizard hiring-profile-form" onSubmit={(event) => void createAgent(event)}><p className="eyebrow">{agents.length === 0 ? "First profile" : "Another profile"}</p><h3>{agents.length === 0 ? "Create your hiring profile" : "Create another hiring profile"}</h3><label>Profile name<input name="name" required maxLength={80} placeholder="Field operations" /></label><label>Allowed task categories, comma separated<input name="categories" required maxLength={500} placeholder="inspection, photography" /></label><div className="form-two"><label>Maximum task amount (USDC)<input name="maxTask" required inputMode="decimal" placeholder="2.00" /></label><label>Total spending limit (USDC)<input name="totalBudget" required inputMode="decimal" placeholder="25.00" /></label></div><small>These are policy limits. They reserve room for future tasks but do not deposit or move USDC.</small><button className="button button--primary" disabled={controller.busy}>{agents.length === 0 ? "Create hiring profile" : "Save another profile"}</button></form>}
              {agents.length === 0 && <p className="hiring-step__hint">Create at least one profile before posting a task. You can add another profile later for a different budget or category set.</p>}
            </>}
          </div>
        </li>

        <li className={`hiring-step ${!profileReady ? "hiring-step--locked" : currentStep === 4 ? "hiring-step--current" : "hiring-step--complete"}`} aria-current={currentStep === 4 ? "step" : undefined}>
          <div className="hiring-step__number">4</div>
          <div className="hiring-step__body">
            <p className="eyebrow">Step 4</p><h2>Post the task</h2>
            {!profileReady ? <p>Complete the earlier steps and load a hiring profile before entering task details.</p> : <>
              <p>Posting publishes the brief and reserves the amount against the selected profile’s limits. It does not charge your wallet or fund escrow. The path after posting is applicants → choose one → approve and fund → worker delivers → review and pay.</p>
              <form className="creator-wizard task-create-form hiring-task-form" onSubmit={(event) => void createTask(event)}>
                <label>Hiring profile<select value={activeAgent?.id ?? ""} onChange={(event) => setAgentId(event.currentTarget.value)}>{agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name} · {formatAtomic(agent.availableAtomic, agent.asset)} available</option>)}</select></label>
                <label>Title<input required maxLength={120} value={taskDraft.title} onChange={(event) => updateTaskDraft("title", event.currentTarget.value)} placeholder="Photograph three public entrances" /></label>
                <label>Task brief<textarea required maxLength={4000} value={taskDraft.brief} onChange={(event) => updateTaskDraft("brief", event.currentTarget.value)} placeholder="Include task requirements. Keep precise private access details out of the public area field." /></label>
                <div className="form-two"><label>Category<select required disabled={!activeAgent} value={taskDraft.category} onChange={(event) => updateTaskDraft("category", event.currentTarget.value)}><option value="" disabled>Choose a permitted category</option>{(activeAgent?.categories ?? []).map((item) => <option key={item} value={item}>{item}</option>)}</select></label><label>Public service area<input required maxLength={120} value={taskDraft.area} onChange={(event) => updateTaskDraft("area", event.currentTarget.value)} placeholder="District or town" /></label></div>
                <label>Completion checklist<textarea required maxLength={2400} value={taskDraft.checklist} onChange={(event) => updateTaskDraft("checklist", event.currentTarget.value)} placeholder="One observable requirement per line" /></label>
                <div className="form-two"><label>Gross amount (USDC)<input required inputMode="decimal" value={taskDraft.amount} onChange={(event) => updateTaskDraft("amount", event.currentTarget.value)} placeholder="1.25" /></label><label>Deadline<input required type="datetime-local" value={taskDraft.deadline} onChange={(event) => updateTaskDraft("deadline", event.currentTarget.value)} /></label></div>
                <div className="form-two"><label>Review window after delivery (minutes)<input required type="number" min={1} max={720} value={taskDraft.reviewWindowMinutes} onChange={(event) => updateTaskDraft("reviewWindowMinutes", event.currentTarget.value)} /></label><label>Worker share if rejected (%)<input required type="number" min={0} max={100} value={taskDraft.rejectSplitPercent} onChange={(event) => updateTaskDraft("rejectSplitPercent", event.currentTarget.value)} /></label></div>
                <small>The default review window is 5 minutes. It starts only after the worker delivers; posting never starts it. On rejection, this worker share is before t2000 fees, and the terms are frozen in the owner’s approval and funding transaction.</small>
                <button className="button button--primary" disabled={controller.busy || dashboardPending || !!dashboardError || !activeAgent}>Post task</button>
              </form>
            </>}
          </div>
        </li>
      </ol>

      {createdKey && <Callout title="Save this API key now" tone="warning"><p>This bearer key is shown once and stays only in this page’s memory. It gives your own AI or automation API access to the hiring profile; it does not launch an AI agent. Save it in your secret manager before dismissing it.</p><pre aria-label="One-time hiring profile API key">{createdKey}</pre><div className="detail-actions"><button type="button" className="button button--small" onClick={() => void copyCreatedKey()}>Copy key</button><button type="button" className="button button--small" onClick={() => setCreatedKey("")}>Dismiss</button></div>{copyKeyNotice && <small className="hiring-key-notice" role="status">{copyKeyNotice}</small>}<p className="hiring-step__optional"><a href="/connect">Connect your own AI (MCP)</a> using this key.</p></Callout>}
      {createdTaskTitle && <Callout title="Task posted" tone="success"><p><strong>{createdTaskTitle}</strong> is now available for applicants. Next: choose one applicant, approve and fund the exact terms, wait for delivery, then review and pay.</p>{createdTaskId ? <a className="button button--small" href={`/tasks/${createdTaskId}`}>Open task stages</a> : <a className="button button--small" href="#active-tasks">Open active tasks</a>}</Callout>}

      {owner && <section className="section-block"><SectionHeading eyebrow="Saved profiles" title="Hiring profile limits" description="Available equals total limit less reservations and confirmed spend. Select a profile above to post new work; existing profiles remain available for API access and task history." />{dashboardPending ? <LoadingState label="Loading hiring profile limits…" variant="list" /> : dashboardError ? <p className="muted-copy">Hiring profile limits are unavailable until the owner dashboard can be loaded.</p> : agents.length === 0 ? <EmptyState title="No hiring profiles yet">Complete step 3 to define the categories and limits a task can use.</EmptyState> : <div className="agent-summary-grid">{agents.map((agent) => <article key={agent.id}><strong>{agent.name}</strong><span>{agent.categories.join(", ")}</span><small>Available {formatAtomic(agent.availableAtomic, agent.asset)} · reserved {formatAtomic(agent.reservedAtomic, agent.asset)} · spent {formatAtomic(agent.spentAtomic, agent.asset)}</small><small>Total {formatAtomic(agent.totalBudgetAtomic, agent.asset)} · per-task cap {formatAtomic(agent.maxTaskAtomic, agent.asset)}</small></article>)}</div>}</section>}
      {owner && <section className="section-block" id="active-tasks"><SectionHeading eyebrow="Active tasks" title="Follow each task to payment" description="Applicants → choose one → approve and fund → worker delivers → review and pay. Open any task for its exact current action and immutable payment terms." />{dashboardPending ? <LoadingState label="Loading active tasks…" variant="list" /> : dashboardError ? <p className="muted-copy">Active tasks are unavailable until the owner dashboard can be loaded.</p> : dashboard?.tasks.length ? <div className="experience-list">{dashboard.tasks.map((task) => <article className="experience-row experience-row--task" key={task.id}><div><strong>{task.title}</strong><small>{task.category} · {task.area} · {task.worker?.displayName ?? "Waiting for applicants"} · Next: {ownerTaskStageLabel(task.state)}</small></div><StatusBadge value={task.state} tone={taskTone(task.state)} /><strong>{formatAtomic(task.amountAtomic, task.asset)}</strong><a className="button button--small" href={`/tasks/${task.id}`}>Open task stages</a>{task.state === "OPEN" && <button className="button button--small" onClick={() => void showApplicants(task.id)}>{selectedTask === task.id ? "Hide applicants" : "Review applicants"}</button>}{selectedTask === task.id && <ApplicantPanel taskId={task.id} list={applicantLists[task.id]} loading={applicantLoading[task.id]} error={applicantErrors[task.id]} busy={controller.busy} worldEnvironment={controller.browser?.config.worldIdentityEnvironment ?? null} onSelect={(workerId) => void selectWorker(task.id, workerId)} />}</article>)}</div> : dashboard && <EmptyState title="No active tasks yet">Post a task above; applicants, worker delivery, review, and confirmed payment will appear here.</EmptyState>}</section>}
    </section>
  </main>;
}

function ApplicantPanel({ taskId, list, loading, error, busy, worldEnvironment, onSelect }: { taskId: string; list?: ApplicantList; loading: boolean; error: string; busy: boolean; worldEnvironment: "production" | "staging" | "sandbox" | null; onSelect: (workerId: string) => void }) {
  if (!list && loading) return <div className="applicant-panel"><p className="eyebrow">Applicants · {taskId.slice(0, 8)}</p><LoadingState label="Loading applicants…" variant="list" /></div>;
  if (!list && error) return <div className="applicant-panel"><Callout title="Applicants unavailable" tone="danger">{error}</Callout></div>;
  if (!list) return <div className="applicant-panel"><p className="eyebrow">Applicants · {taskId.slice(0, 8)}</p></div>;

  return <div className="applicant-panel">
    <p className="eyebrow">Applicants · {taskId.slice(0, 8)} · {worldEnvironmentDisclosure(worldEnvironment)}</p>
    {error && <Callout title="Applicant refresh failed" tone="danger">Showing previously loaded applicants. {error}</Callout>}
    {list.applicants.length === 0 && <EmptyState title="No applications yet">Eligible workers can apply from the public task detail page.</EmptyState>}
    {list.applicants.map((application) => (
      <article className="applicant-row" key={application.applicationId}>
        <div>
          <a href={application.worker.profilePath}><strong>{application.worker.displayName}</strong></a>
          <small>{application.worker.category} · {application.worker.area} · {application.worker.skills.join(", ") || "No skills listed"}</small>
          {application.note && <p>{application.note}</p>}
        </div>
        <StatusBadge value={worldCheckBadge(worldEnvironment, application.worker.worldVerified)} tone={application.worker.worldVerified ? "success" : "warning"} />
        <StatusBadge value={application.status} tone={application.status === "SELECTED" ? "success" : application.status === "DECLINED" ? "neutral" : "info"} />
        {application.status === "APPLIED" && <button className="button button--primary button--small" disabled={busy || !application.worker.eligible} title={!application.worker.eligible ? "Worker eligibility has changed; ask them to complete verification." : undefined} onClick={() => onSelect(application.workerId)}>Choose worker</button>}
      </article>
    ))}
  </div>;
}
