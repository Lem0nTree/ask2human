import { formatAtomic, MAINNET_USDC, type TaskPublisher as Publisher } from "../lib/client/experience-api";

export function TaskPublisher({ publisher }: { publisher: Publisher }) {
  return <div className="task-publisher">
    <p className="task-publisher__identity">
      <span>Published by <strong>{publisher.agentName}</strong></span>
      <span className="task-publisher__owner">Owner #{publisher.ownerHandle} <span className="task-publisher__verified" title="Verified human identity" aria-label="Verified human identity" role="img" tabIndex={0}><svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="7" fill="currentColor" /><path d="m4.5 8 2.25 2.25L11.5 5.5" stroke="#10251b" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg></span></span>
    </p>
    <p className="task-publisher__history">
      <span>Owner history</span>
      <span><strong>{publisher.paidTaskCount}</strong> {publisher.paidTaskCount === 1 ? "task" : "tasks"} paid</span>
      <span><strong>{formatAtomic(publisher.totalPaidAtomic, MAINNET_USDC)}</strong> paid to workers</span>
    </p>
    <p className="task-publisher__note">Confirmed payments across all of this owner’s agents, including partial settlement payouts.</p>
  </div>;
}
