"use client";

import { useState } from "react";
import { CartesianGrid, Legend, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

export type Series = { key: string; label: string; color: string; dashed?: boolean };

const fmtDay = (d: string) =>
  new Date(`${d}T12:00:00+05:30`).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" });
const fmtNum = (v: number, inr: boolean) =>
  inr ? `₹${Math.round(v).toLocaleString("en-IN")}` : Math.round(v).toLocaleString("en-IN");
const fmtTick = (v: number, inr: boolean) => {
  const s = Math.abs(v) >= 10000 ? `${(v / 1000).toFixed(0)}K` : v.toLocaleString("en-IN");
  return inr ? `₹${s}` : s;
};

// Multi-series line chart on one axis, with a crosshair tooltip, an optional
// goal line, and a table view (the accessible twin of the chart).
export function LineTrend({ data, series, goal, goalLabel, inr = false, height = 260, caption }: {
  data: Record<string, number | string | null>[];
  series: Series[];
  goal?: number | null;
  goalLabel?: string;
  inr?: boolean;
  height?: number;
  caption: string;
}) {
  const [table, setTable] = useState(false);
  return (
    <figure>
      <div className="mb-2 flex justify-end">
        <button type="button" onClick={() => setTable(!table)} className="text-xs text-ink-2 underline">
          {table ? "Show chart" : "Show as table"}
        </button>
      </div>
      {table ? (
        <div className="max-h-72 overflow-auto">
          <table className="w-full text-xs">
            <thead><tr><th className="px-2 py-1 text-left text-ink-2">Day</th>
              {series.map((s) => <th key={s.key} className="px-2 py-1 text-right text-ink-2">{s.label}</th>)}</tr></thead>
            <tbody>
              {data.map((r) => (
                <tr key={String(r.day)} className="border-t border-line">
                  <td className="px-2 py-1">{fmtDay(String(r.day))}</td>
                  {series.map((s) => <td key={s.key} className="num px-2 py-1 text-right">
                    {r[s.key] == null ? "—" : fmtNum(Number(r[s.key]), inr)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div style={{ height }}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data} margin={{ top: 8, right: 16, bottom: 0, left: 4 }}>
              <CartesianGrid vertical={false} stroke="var(--grid)" />
              <XAxis dataKey="day" tickFormatter={fmtDay} stroke="var(--axis)" tick={{ fill: "var(--muted)", fontSize: 11 }}
                     minTickGap={28} tickLine={false} />
              <YAxis stroke="var(--axis)" tick={{ fill: "var(--muted)", fontSize: 11 }} tickLine={false} axisLine={false}
                     tickFormatter={(v) => fmtTick(Number(v), inr)} width={inr ? 64 : 48}
                     domain={[0, (max: number) => Math.max(max, goal ?? 0) * 1.05]} />
              <Tooltip
                cursor={{ stroke: "var(--axis)", strokeWidth: 1 }}
                contentStyle={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 }}
                labelStyle={{ color: "var(--ink-2)" }}
                labelFormatter={(d) => fmtDay(String(d))}
                formatter={(v, name) => [fmtNum(Number(v), inr), String(name)]}
              />
              <Legend iconType="plainline" wrapperStyle={{ fontSize: 12, color: "var(--ink-2)" }}
                      itemSorter={(item) => series.findIndex((s) => s.key === item.dataKey)} />
              {goal != null && (
                <ReferenceLine y={goal} stroke="var(--muted)" strokeWidth={1}
                               label={{ value: goalLabel ?? "Goal", position: "insideTopLeft", fill: "var(--ink-2)", fontSize: 11 }} />
              )}
              {series.map((s) => (
                <Line key={s.key} type="monotone" dataKey={s.key} name={s.label} stroke={s.color} strokeWidth={2}
                      strokeDasharray={s.dashed ? "4 4" : undefined} dot={false} activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--surface)" }}
                      connectNulls isAnimationActive={false} />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
      <figcaption className="mt-2 text-xs text-ink-2">{caption}</figcaption>
    </figure>
  );
}
