"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

const LINKS = [
  { href: "/", label: "Overview" },
  { href: "/campaigns", label: "Campaigns" },
  { href: "/diagnose", label: "Diagnose" },
  { href: "/decide", label: "Decide" },
  { href: "/execute", label: "Execute" },
];

const PRESETS = [
  { date: "2025-02-15", label: "15 Feb" },
  { date: "2025-03-15", label: "15 Mar · plan revised" },
  { date: "2025-04-01", label: "1 Apr" },
  { date: "2025-04-11", label: "11 Apr · eve" },
  { date: "2025-04-12", label: "12 Apr · day 1" },
  { date: "2025-04-20", label: "20 Apr · final" },
];

// Navigation that keeps the selected "as of" date, plus the date control.
export function HeaderControls({ min, max }: { min: string; max: string }) {
  const pathname = usePathname();
  const router = useRouter();
  const params = useSearchParams();
  const asOf = params.get("asof") ?? max;

  const withAsOf = (href: string) => (params.get("asof") ? `${href}?asof=${params.get("asof")}` : href);
  const go = (d: string) => {
    if (!d) return;
    const next = new URLSearchParams(params.toString());
    next.set("asof", d);
    router.push(`${pathname}?${next.toString()}`);
  };

  return (
    <div className="flex flex-col gap-3">
      <nav className="flex flex-wrap gap-1" aria-label="Sections">
        {LINKS.map((l) => {
          const active = l.href === "/" ? pathname === "/" : pathname.startsWith(l.href);
          return (
            <Link key={l.href} href={withAsOf(l.href)}
                  className={`rounded-md px-3 py-1.5 text-sm ${active ? "bg-ink text-surface" : "text-ink-2 hover:bg-grid"}`}>
              {l.label}
            </Link>
          );
        })}
      </nav>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <label htmlFor="asof" className="text-ink-2">Viewing as of the end of</label>
        <input id="asof" type="date" min={min} max={max} value={asOf}
               onChange={(e) => go(e.target.value)}
               className="rounded-md border border-line bg-surface px-2 py-1 text-ink" />
        <span className="text-xs text-muted">(India time; nothing after this day is used)</span>
        <div className="flex flex-wrap gap-1">
          {PRESETS.map((p) => (
            <button key={p.date} type="button" onClick={() => go(p.date)}
                    className={`rounded-full border px-2.5 py-0.5 text-xs ${p.date === asOf ? "border-ink text-ink" : "border-line text-ink-2 hover:bg-grid"}`}>
              {p.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
