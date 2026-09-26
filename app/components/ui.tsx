import type { ReactNode } from "react";
import Image from "next/image";
import logo from "../img/ask2human_logo2.png";

export function BrandMark() {
  return <span className="brand-mark"><Image className="brand-mark__logo" src={logo} alt="" priority /></span>;
}

export function SiteFooter() {
  return <footer className="site-footer page-shell">
    <span>ask2human</span>
    <span>Mainnet USDC · confirmed receipts determine earnings</span>
    <span>Identity checks and evidence review establish different facts</span>
    <div className="site-footer__socials" role="group" aria-label="Social media">
      <span className="site-footer__social-icon site-footer__social-icon--twitter" role="img" aria-label="Twitter" title="Twitter">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M23.953 4.57a10 10 0 0 1-2.825.775 4.958 4.958 0 0 0 2.163-2.723 9.99 9.99 0 0 1-3.127 1.195 4.92 4.92 0 0 0-8.384 4.482A13.98 13.98 0 0 1 1.64 3.162a4.822 4.822 0 0 0-.666 2.475c0 1.71.87 3.213 2.188 4.096a4.904 4.904 0 0 1-2.228-.616v.06a4.923 4.923 0 0 0 3.946 4.827 4.996 4.996 0 0 1-2.224.084 4.936 4.936 0 0 0 4.604 3.42A9.897 9.897 0 0 1 0 19.54a13.94 13.94 0 0 0 7.548 2.212c9.057 0 14.01-7.503 14.01-14.01 0-.213-.005-.425-.014-.636a10.012 10.012 0 0 0 2.46-2.548z" /></svg>
      </span>
      <span className="site-footer__social-icon site-footer__social-icon--telegram" role="img" aria-label="Telegram" title="Telegram">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m22 2-7 20-4-9-9-4Z" /><path d="M22 2 11 13" /></svg>
      </span>
    </div>
  </footer>;
}

export function StatusBadge({ value, tone = "neutral" }: { value: string; tone?: "success" | "warning" | "danger" | "neutral" | "info" }) {
  return <span className={`status-badge status-badge--${tone}`}><span className="status-badge__dot" aria-hidden="true" />{value}</span>;
}

export function Callout({ title, children, tone = "info" }: { title: string; children: ReactNode; tone?: "info" | "warning" | "danger" | "success" }) {
  return <aside className={`callout callout--${tone}`}><span className="callout__icon" aria-hidden="true">{tone === "danger" ? "!" : "i"}</span><div><strong>{title}</strong><div className="callout__body">{children}</div></div></aside>;
}

export function EmptyState({ title, children }: { title: string; children: ReactNode }) {
  return <div className="empty-state"><span className="empty-state__orb" aria-hidden="true">∅</span><div><h3>{title}</h3><p>{children}</p></div></div>;
}

export function SectionHeading({ eyebrow, title, description }: { eyebrow: string; title: string; description: string }) {
  return <div className="section-heading"><div><p className="eyebrow">{eyebrow}</p><h2>{title}</h2><p className="section-heading__description">{description}</p></div></div>;
}

export function LoadingState({ label, variant = "list" }: { label: string; variant?: "list" | "detail" | "inline" }) {
  if (variant === "inline") return <span className="loading-state loading-state--inline" role="status" aria-label={label}><span className="skeleton-block skeleton-block--short" /></span>;

  return <div className={`loading-state loading-state--${variant}`} role="status" aria-label={label}>
    {variant === "detail" ? <>
      <div className="loading-state__detail-head"><span className="skeleton-block skeleton-block--heading" /><span className="skeleton-block skeleton-block--badge" /></div>
      <div className="loading-state__facts">{Array.from({ length: 6 }, (_, index) => <div className="loading-state__fact" key={index}><span className="skeleton-block skeleton-block--short" /><span className="skeleton-block skeleton-block--medium" /></div>)}</div>
      <div className="loading-state__copy"><span className="skeleton-block" /><span className="skeleton-block skeleton-block--wide" /><span className="skeleton-block skeleton-block--half" /></div>
    </> : <LoadingRows count={3} />}
  </div>;
}

function LoadingRows({ count }: { count: number }) {
  return <div className="loading-state__rows">{Array.from({ length: count }, (_, index) => <div className="loading-state__row" key={index}>
    <span className="skeleton-block skeleton-block--art" />
    <div className="loading-state__row-copy"><span className="skeleton-block skeleton-block--wide" /><span className="skeleton-block" /><span className="skeleton-block skeleton-block--half" /></div>
    <span className="skeleton-block skeleton-block--badge" />
  </div>)}</div>;
}
