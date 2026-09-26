"use client";

import dynamic from "next/dynamic";
import { useState, type ChangeEvent, type ReactNode } from "react";
import { BrandMark, LoadingState } from "./ui";

function ExperienceFallbackFrame({ children }: { children: ReactNode }) {
  return <>
    <header className="topbar"><div className="topbar__inner">
      <a className="brand-link" href="/" aria-label="ask2human home"><BrandMark /></a>
      <nav className="main-nav" aria-label="Primary navigation">
        <a href="/">Tasks</a>
        <a href="/work">My work</a>
        <a href="/agents">Hire a human</a>
      </nav>
      <div className="nav-actions"><span className="network-pill"><i />Mainnet · USDC</span></div>
    </div></header>
    {children}
    <footer className="site-footer page-shell"><span>ask2human</span><span>Mainnet USDC · confirmed receipts determine earnings</span><span>Identity checks and evidence review establish different facts</span></footer>
  </>;
}

function MarketplaceFallback() {
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("");

  function updateFilter(name: "q" | "category", value: string) {
    const url = new URL(window.location.href);
    if (value) url.searchParams.set(name, value);
    else url.searchParams.delete(name);
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  }

  function changeSearch(event: ChangeEvent<HTMLInputElement>) {
    setSearch(event.currentTarget.value);
    updateFilter("q", event.currentTarget.value);
  }

  function changeCategory(event: ChangeEvent<HTMLSelectElement>) {
    setCategory(event.currentTarget.value);
    updateFilter("category", event.currentTarget.value);
  }

  return <ExperienceFallbackFrame><main className="page-shell">
    <section className="directory-hero">
      <p className="eyebrow"><i />Human work, secured by escrow</p>
      <h1>Offline tasks. <span>Human workers.</span></h1>
      <p>Find work posted by task owners. Apply as an eligible worker, agree on exact terms, and track confirmed USDC payments.</p>
      <div className="directory-collection-stats"><span><LoadingState label="Loading open task count…" variant="inline" /> open tasks</span><span className="testnet-dot" /><span><LoadingState label="Loading total USDC payout…" variant="inline" /> total available payout</span></div>
      <small>World verification checks worker account uniqueness; it does not certify completed work.</small>
    </section>
    <section className="marketplace-section">
      <div className="section-heading"><div><p className="eyebrow">Marketplace</p><h2>Find a task</h2><p className="section-heading__description">Open task listings show the category, service area, reward, and deadline. Verify as a worker to read the full task brief and apply.</p></div></div>
      <div className="filter-panel" role="search">
        <label className="search-field"><span aria-hidden="true">⌕</span><input aria-label="Search open tasks" type="search" placeholder="Search tasks, area, or category" value={search} onChange={changeSearch} /></label>
        <label className="select-field"><span>Category</span><select value={category} onChange={changeCategory}><option value="">All categories</option>{["inspection", "delivery", "photography", "research", "audit", "other"].map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
        <a className="button button--primary" href="/agents">Hire a human</a>
      </div>
      <div className="marketplace-results-heading"><span><LoadingState label="Loading task count…" variant="inline" /></span><span>Recently posted</span></div>
      <LoadingState label="Loading open tasks…" variant="list" />
    </section>
    <section className="section-block experience-shortcuts">
      <a className="detail-section" href="/work"><p className="eyebrow">For workers</p><h3>Applications, delivery, and earnings</h3><p>Manage your verified profile and see confirmed payment history.</p></a>
      <a className="detail-section" href="/agents"><p className="eyebrow">For task owners</p><h3>Hire a human for a task</h3><p>Sign in, link a payment wallet, set spending limits, and follow each escrow step.</p></a>
    </section>
  </main></ExperienceFallbackFrame>;
}

function TaskFallback() {
  return <ExperienceFallbackFrame><main className="page-shell">
    <a className="task-back-link" href="/">← Back to open tasks</a>
    <section className="directory-hero directory-hero--compact">
      <p className="eyebrow">Task details</p>
      <h1>Task information</h1>
      <p>Review the task brief, requirements, and next steps here.</p>
    </section>
  </main></ExperienceFallbackFrame>;
}

function WorkFallback() {
  return <ExperienceFallbackFrame><main className="page-shell">
    <section className="directory-hero directory-hero--compact">
      <p className="eyebrow">Worker workspace</p>
      <h1>Applications. <span>Delivery. Earnings.</span></h1>
      <p>See your selected work and count earnings from confirmed settlement receipts, not your wallet balance or a capped task feed.</p>
    </section>
    <section className="section-block">
      <div className="section-heading"><div><p className="eyebrow">Worker profile</p><h2>Your work, in one place</h2><p className="section-heading__description">Your profile, applications, delivery steps, and confirmed payments appear in this workspace.</p></div></div>
      <a className="button button--primary" href="/">Browse open tasks</a>
    </section>
  </main></ExperienceFallbackFrame>;
}

function WorkerFallback() {
  return <ExperienceFallbackFrame><main className="page-shell">
    <section className="directory-hero directory-hero--compact">
      <p className="eyebrow">Worker profile · account uniqueness check</p>
      <h1>Worker profile</h1>
      <p>Public eligibility, ratings, and completed-work summaries.</p>
      <small>Identity checks are separate from public ratings and completed-work records.</small>
    </section>
    <section className="section-block"><div className="section-heading"><div><p className="eyebrow">Public rating</p><h2>Worker ratings</h2></div></div></section>
    <section className="section-block"><div className="section-heading"><div><p className="eyebrow">Completed work</p><h2>Recent public task summaries</h2><p className="section-heading__description">These summaries contain no delivery report, evidence image or precise location.</p></div></div></section>
    <a className="button button--primary" href="/">Browse open tasks</a>
  </main></ExperienceFallbackFrame>;
}

const MarketplacePage = dynamic(() => import("./experience-pages").then((module) => module.MarketplacePage), {
  ssr: false,
  loading: () => <MarketplaceFallback />,
});
const TaskPage = dynamic(() => import("./experience-pages").then((module) => module.TaskPage), {
  ssr: false,
  loading: () => <TaskFallback />,
});
const WorkPage = dynamic(() => import("./experience-pages").then((module) => module.WorkPage), {
  ssr: false,
  loading: () => <WorkFallback />,
});
const WorkerPage = dynamic(() => import("./experience-pages").then((module) => module.WorkerPage), {
  ssr: false,
  loading: () => <WorkerFallback />,
});
// Render the real hiring layout on the server; its data sections own loading states.
const AgentsPage = dynamic(() => import("./experience-pages").then((module) => module.AgentsPage));

export function MarketplaceExperienceShell() { return <MarketplacePage />; }
export function TaskExperienceShell({ taskId }: { taskId: string }) { return <TaskPage taskId={taskId} />; }
export function WorkExperienceShell() { return <WorkPage />; }
export function WorkerExperienceShell({ workerId }: { workerId: string }) { return <WorkerPage workerId={workerId} />; }
export function AgentsExperienceShell() { return <AgentsPage />; }
