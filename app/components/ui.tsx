import type { ReactNode } from "react";

export function BrandMark() {
  return <span className="brand-mark"><span className="brand-mark__glyph" aria-hidden="true">2</span><span className="brand-mark__name">ask2human</span></span>;
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

export function LoadingState({ label }: { label: string }) {
  return <div className="loading-state" role="status"><span className="loading-state__spinner" aria-hidden="true" />{label}</div>;
}
