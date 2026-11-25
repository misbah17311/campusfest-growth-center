import type { ReactNode } from "react";

export function Card({ title, subtitle, children, className = "" }: {
  title?: string; subtitle?: ReactNode; children: ReactNode; className?: string;
}) {
  return (
    <section className={`rounded-lg border border-line bg-surface p-4 ${className}`}>
      {title && <h2 className="text-sm font-semibold text-ink">{title}</h2>}
      {subtitle && <p className="mt-0.5 text-xs text-ink-2">{subtitle}</p>}
      <div className={title || subtitle ? "mt-3" : ""}>{children}</div>
    </section>
  );
}

// Ratio against a limit: fill and a lighter track of the same hue.
export function Meter({ value, label }: { value: number | null; label: string }) {
  const pct = value == null ? 0 : Math.max(0, Math.min(1, value)) * 100;
  return (
    <div role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)}
         className="h-2 w-full rounded-full bg-track">
      <div className="h-2 rounded-full bg-s1" style={{ width: `${pct}%` }} />
    </div>
  );
}

export function StatTile({ label, value, sub, meter, meterLabel }: {
  label: string; value: string; sub?: ReactNode; meter?: number | null; meterLabel?: string;
}) {
  return (
    <div className="rounded-lg border border-line bg-surface p-4">
      <div className="text-xs text-ink-2">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-ink">{value}</div>
      {sub && <div className="mt-1 text-xs text-ink-2">{sub}</div>}
      {meter !== undefined && <div className="mt-3"><Meter value={meter} label={meterLabel ?? label} /></div>}
    </div>
  );
}

const DECISION_STYLE: Record<string, { icon: string; color: string; label: string }> = {
  scale: { icon: "▲", color: "var(--good)", label: "Scale" },
  keep: { icon: "●", color: "var(--muted)", label: "Keep" },
  change: { icon: "◆", color: "var(--warning)", label: "Change" },
  stop: { icon: "■", color: "var(--critical)", label: "Stop" },
  "insufficient data": { icon: "?", color: "var(--muted)", label: "Not enough data" },
};

// Status always carries an icon and a label, never colour alone.
export function DecisionBadge({ decision }: { decision: string }) {
  const s = DECISION_STYLE[decision] ?? DECISION_STYLE.keep;
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-line px-2 py-0.5 text-xs text-ink">
      <span aria-hidden style={{ color: s.color }}>{s.icon}</span>
      {s.label}
    </span>
  );
}

export function StatusDot({ tone, children }: { tone: "good" | "warning" | "critical" | "muted"; children: ReactNode }) {
  const icon = { good: "✓", warning: "!", critical: "✕", muted: "•" }[tone];
  const color = { good: "var(--good)", warning: "var(--warning)", critical: "var(--critical)", muted: "var(--muted)" }[tone];
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-ink">
      <span aria-hidden className="font-bold" style={{ color }}>{icon}</span>
      {children}
    </span>
  );
}

export function PageTitle({ title, intro }: { title: string; intro: ReactNode }) {
  return (
    <div className="mb-4">
      <h1 className="text-xl font-semibold text-ink">{title}</h1>
      <p className="mt-1 max-w-3xl text-sm text-ink-2">{intro}</p>
    </div>
  );
}

export function Th({ children, right = false }: { children?: ReactNode; right?: boolean }) {
  return <th className={`px-2 py-1.5 text-xs font-medium text-ink-2 ${right ? "text-right" : "text-left"}`}>{children}</th>;
}
export function Td({ children, right = false, className = "" }: { children?: ReactNode; right?: boolean; className?: string }) {
  return <td className={`px-2 py-1.5 ${right ? "num text-right" : ""} ${className}`}>{children}</td>;
}
