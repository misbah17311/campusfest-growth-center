"use client";

import { useMemo, useState } from "react";

export type WhatIfRow = {
  campaign_id: string;
  campaign_name: string;
  paid: boolean;
  spend: number;
  registered: number;
  visitors_per_registration: number;
};

const inr = (v: number) => `₹${Math.round(v).toLocaleString("en-IN")}`;
const int = (v: number) => Math.round(v).toLocaleString("en-IN");

// Budget reallocation what-if. Same formula as the target model
// (analysis/target_model.py): registrations scale with spend ** beta, where
// beta < 1 means each extra rupee buys less than the last. Beta is an
// assumption: paid reach saturated quickly in 2025, peer channels did not.
export function WhatIf({ rows, ratioBasis }: { rows: WhatIfRow[]; ratioBasis: string }) {
  const [spend, setSpend] = useState<Record<string, number>>(Object.fromEntries(rows.map((r) => [r.campaign_id, r.spend])));
  const [betaPaid, setBetaPaid] = useState(0.5);
  const [betaPeer, setBetaPeer] = useState(0.7);

  const result = useMemo(() => rows.map((r) => {
    const s1 = spend[r.campaign_id] ?? r.spend;
    const beta = r.paid ? betaPaid : betaPeer;
    const reg = r.spend > 0 ? r.registered * Math.pow(Math.max(s1, 0) / r.spend, beta) : r.registered;
    return { ...r, s1, reg, vis: reg * r.visitors_per_registration, base: r.registered * r.visitors_per_registration };
  }), [rows, spend, betaPaid, betaPeer]);

  const tot = result.reduce((a, r) => ({ s0: a.s0 + r.spend, s1: a.s1 + r.s1, r0: a.r0 + r.registered, r1: a.r1 + r.reg,
    v0: a.v0 + r.base, v1: a.v1 + r.vis }), { s0: 0, s1: 0, r0: 0, r1: 0, v0: 0, v1: 0 });

  return (
    <div>
      <div className="mb-3 flex flex-wrap gap-4 text-xs text-ink-2">
        <label className="flex items-center gap-2">Diminishing returns, paid reach (beta)
          <input type="number" step="0.05" min="0.1" max="1" value={betaPaid} onChange={(e) => setBetaPaid(Number(e.target.value))}
                 className="w-16 rounded-md border border-line bg-surface px-1.5 py-0.5 text-ink" /></label>
        <label className="flex items-center gap-2">Peer and group channels (beta)
          <input type="number" step="0.05" min="0.1" max="1" value={betaPeer} onChange={(e) => setBetaPeer(Number(e.target.value))}
                 className="w-16 rounded-md border border-line bg-surface px-1.5 py-0.5 text-ink" /></label>
        <button type="button" className="underline" onClick={() => setSpend(Object.fromEntries(rows.map((r) => [r.campaign_id, r.spend])))}>Reset spend</button>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead><tr className="border-b border-line text-xs text-ink-2">
            <th className="px-2 py-1 text-left font-medium">Campaign</th><th className="px-2 py-1 text-right font-medium">Spend so far</th>
            <th className="px-2 py-1 text-right font-medium">What-if spend</th><th className="px-2 py-1 text-right font-medium">Registrations</th>
            <th className="px-2 py-1 text-right font-medium">Expected visitors</th><th className="px-2 py-1 text-right font-medium">Change</th></tr></thead>
          <tbody>
            {result.map((r) => (
              <tr key={r.campaign_id} className="border-b border-line">
                <td className="px-2 py-1">{r.campaign_name}<span className="ml-1 text-xs text-muted">{r.paid ? "paid" : "peer"}</span></td>
                <td className="num px-2 py-1 text-right">{inr(r.spend)}</td>
                <td className="px-2 py-1 text-right">
                  <input type="number" step="1000" min="0" value={r.s1} aria-label={`What-if spend for ${r.campaign_name}`}
                         onChange={(e) => setSpend({ ...spend, [r.campaign_id]: Number(e.target.value) })}
                         className="num w-28 rounded-md border border-line bg-surface px-1.5 py-0.5 text-right text-ink" />
                </td>
                <td className="num px-2 py-1 text-right">{int(r.registered)} → {int(r.reg)}</td>
                <td className="num px-2 py-1 text-right">{int(r.base)} → {int(r.vis)}</td>
                <td className="num px-2 py-1 text-right">{r.vis - r.base >= 0 ? "+" : ""}{int(r.vis - r.base)}</td>
              </tr>
            ))}
            <tr className="font-medium">
              <td className="px-2 py-1">Total</td><td className="num px-2 py-1 text-right">{inr(tot.s0)}</td>
              <td className="num px-2 py-1 text-right">{inr(tot.s1)}</td>
              <td className="num px-2 py-1 text-right">{int(tot.r0)} → {int(tot.r1)}</td>
              <td className="num px-2 py-1 text-right">{int(tot.v0)} → {int(tot.v1)}</td>
              <td className="num px-2 py-1 text-right">{tot.v1 - tot.v0 >= 0 ? "+" : ""}{int(tot.v1 - tot.v0)}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-ink-2">
        Expected visitors use each campaign&apos;s visitors per registration ({ratioBasis}). This is a planning estimate, not a
        forecast: the response to spend outside the range observed in 2025 is an assumption, shown by beta. Walk-ins are not included.
      </p>
    </div>
  );
}
