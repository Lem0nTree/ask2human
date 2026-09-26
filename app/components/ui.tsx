import type { ReactNode } from "react";
import Image from "next/image";
import logo from "../img/ask2human_logo.png";

export function BrandMark() {
  return <span className="brand-mark"><Image className="brand-mark__logo" src={logo} alt="" priority /></span>;
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

export function LoadingState({ label, variant = "list" }: { label: string; variant?: "list" | "detail" | "profile" | "workspace" }) {
  return <div className={`loading-state loading-state--${variant}`} role="status" aria-label={label}>
    {variant === "detail" ? <>
      <div className="loading-state__detail-head"><span className="skeleton-block skeleton-block--heading" /><span className="skeleton-block skeleton-block--badge" /></div>
      <div className="loading-state__facts">{Array.from({ length: 6 }, (_, index) => <div className="loading-state__fact" key={index}><span className="skeleton-block skeleton-block--short" /><span className="skeleton-block skeleton-block--medium" /></div>)}</div>
      <div className="loading-state__copy"><span className="skeleton-block" /><span className="skeleton-block skeleton-block--wide" /><span className="skeleton-block skeleton-block--half" /></div>
    </> : variant === "profile" ? <>
      <div className="loading-state__profile-head"><span className="skeleton-block skeleton-block--heading" /><span className="skeleton-block skeleton-block--medium" /><span className="skeleton-block skeleton-block--badge" /></div>
      <LoadingRows count={2} />
    </> : variant === "workspace" ? <>
      <div className="loading-state__panels">{Array.from({ length: 2 }, (_, index) => <div className="loading-state__panel" key={index}><span className="skeleton-block skeleton-block--medium" /><span className="skeleton-block" /><span className="skeleton-block skeleton-block--wide" /><span className="skeleton-block skeleton-block--button" /></div>)}</div>
      <LoadingRows count={2} />
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
