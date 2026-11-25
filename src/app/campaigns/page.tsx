import { Suspense } from "react";
import Link from "next/link";
import { resolveAsOf } from "@/lib/asof";
import { getCampaignMetrics } from "@/lib/metrics";
import { getDecisions, getWeekly } from "@/lib/analytics";
import { fmtDate, fmtInr, fmtInt, fmtPct } from "@/lib/format";
import { Card, DecisionBadge, PageTitle, Td, Th } from "@/components/ui";
import { HeatCell, sequentialColor } from "@/components/charts/Heatmap";

export default function Page({ searchParams }: PageProps<"/campaigns">) {
  return (
    <Suspense fallback={<p className="text-sm text-ink-2">Loading…</p>}>
      <Campaigns searchParams={searchParams} />
    </Suspense>
  );
}

const METRICS = {
  registrations: { label: "Registrations (people)", hue: "blue" as const },
  spend: { label: "Net spend (₹)", hue: "orange" as const },
  cpr: { label: "Cost per registration (₹)", hue: "orange" as const },
};

async function Campaigns({ searchParams }: { searchParams: PageProps<"/campaigns">["searchParams"] }) {
  const sp = await searchParams;
  const { asOf } = await resolveAsOf(sp.asof);
  const metric = (typeof sp.metric === "string" && sp.metric in METRICS ? sp.metric : "registrations") as keyof typeof METRICS;
  const [rows, weekly, decisions] = await Promise.all([getCampaignMetrics(asOf), getWeekly(asOf), getDecisions(asOf)]);
  const dec = Object.fromEntries(decisions.map((d) => [d.campaign_id, d]));
  const post = rows.some((r) => r.show_up_rate != null);

  const weeks = [...new Set(weekly.map((w) => w.week_start))].sort();
  const cell = (w: (typeof weekly)[number]) =>
    metric === "registrations" ? w.registrations : metric === "spend" ? w.spend_inr
      : w.registrations > 0 ? w.spend_inr / w.registrations : null;
  const values = weekly.map(cell).filter((v): v is number => v != null);
  const max = Math.max(...values, 1);
  const fmtCell = (v: number | null) => (v == null ? "—" : metric === "registrations" ? fmtInt(v) : fmtInt(Math.round(v)));

  return (
    <>
      <PageTitle title="Campaigns"
        intro={<>Every campaign's funnel and efficiency at the end of {fmtDate(asOf)}. People-based stages use the recorded
          source campaign. Impressions and clicks are anonymous platform events, not people. Show-up and cost per verified
          visitor exist only once the festival has started.</>} />

      <Card title="Campaign scorecard" subtitle={<>Decision column from the rules on the <Link className="underline" href={`/decide?asof=${asOf}`}>Decide</Link> page.</>}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="border-b border-line">
              <Th>Campaign</Th><Th>Owner</Th><Th right>Spend</Th><Th right>CTR</Th><Th right>Identified</Th><Th right>Registered</Th>
              <Th right>Ident.→reg.</Th><Th right>Reg.→conf.</Th><Th right>Confirmed</Th><Th right>Visitors</Th><Th right>Show-up</Th>
              <Th right>₹ / reg.</Th><Th right>₹ / visitor</Th><Th>Decision</Th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.campaign_id} className="border-b border-line">
                  <Td><div className="font-medium">{r.campaign_name}</div>
                    <div className="text-xs text-muted">{r.channel}{r.status !== "active" ? ` · ${r.status}` : ""}</div></Td>
                  <Td className="text-xs">{r.owner_name ?? "—"}</Td>
                  <Td right>{fmtInr(r.spend_inr)}</Td><Td right>{fmtPct(r.ctr)}</Td>
                  <Td right>{fmtInt(r.identified)}</Td><Td right>{fmtInt(r.registered)}</Td>
                  <Td right>{fmtPct(r.identified_to_registered)}</Td><Td right>{fmtPct(r.registered_to_confirmed)}</Td>
                  <Td right>{fmtInt(r.confirmed)}</Td><Td right>{post ? fmtInt(r.visitors) : "—"}</Td>
                  <Td right>{fmtPct(r.show_up_rate)}</Td><Td right>{fmtInr(r.cost_per_registration)}</Td>
                  <Td right>{fmtInr(r.cost_per_visitor)}</Td>
                  <Td>{dec[r.campaign_id] && <DecisionBadge decision={dec[r.campaign_id].decision} />}</Td>
                </tr>
              ))}
              <tr className="font-medium">
                <Td>All campaigns</Td><Td />
                <Td right>{fmtInr(rows.reduce((a, r) => a + r.spend_inr, 0))}</Td>
                <Td right>{fmtPct(rows.reduce((a, r) => a + r.clicks, 0) / Math.max(1, rows.reduce((a, r) => a + r.impressions, 0)))}</Td>
                <Td right>{fmtInt(rows.reduce((a, r) => a + r.identified, 0))}</Td>
                <Td right>{fmtInt(rows.reduce((a, r) => a + r.registered, 0))}</Td><Td /><Td />
                <Td right>{fmtInt(rows.reduce((a, r) => a + r.confirmed, 0))}</Td>
                <Td right>{post ? fmtInt(rows.reduce((a, r) => a + r.visitors, 0)) : "—"}</Td><Td /><Td /><Td /><Td />
              </tr>
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-xs text-ink-2">CTR = clicks ÷ impressions (anonymous events). "All campaigns" visitors exclude walk-ins, who have no campaign.</p>
      </Card>

      <Card className="mt-4" title={`Weekly ${METRICS[metric].label.toLowerCase()} by campaign`}
            subtitle="Weeks start on Monday. Darker = more. Hover a cell for the exact value.">
        <div className="mb-3 flex flex-wrap gap-1">
          {(Object.keys(METRICS) as (keyof typeof METRICS)[]).map((m) => (
            <Link key={m} href={`/campaigns?asof=${asOf}&metric=${m}`}
                  className={`rounded-full border px-2.5 py-0.5 text-xs ${m === metric ? "border-ink text-ink" : "border-line text-ink-2"}`}>
              {METRICS[m].label}
            </Link>
          ))}
        </div>
        <div className="overflow-x-auto">
          <table className="border-collapse text-xs">
            <thead><tr><th className="px-2 py-1 text-left font-medium text-ink-2">Campaign</th>
              {weeks.map((w) => <th key={w} className="px-1 py-1 font-normal text-muted">{fmtDate(w).replace(" 2025", "")}</th>)}</tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.campaign_id}>
                  <td className="whitespace-nowrap px-2 py-1 text-ink">{r.campaign_name}</td>
                  {weeks.map((w) => {
                    const row = weekly.find((x) => x.campaign_id === r.campaign_id && x.week_start === w)!;
                    const v = cell(row);
                    const c = sequentialColor(v, max, METRICS[metric].hue);
                    return <HeatCell key={w} text={fmtCell(v)} bg={c.bg} fg={c.fg}
                                     title={`${r.campaign_name}, week of ${fmtDate(w)}: ${fmtCell(v)} · spend ₹${fmtInt(row.spend_inr)} · ${row.registrations} registrations`} />;
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-xs text-ink-2">
          Weekly cost per registration is a rough signal: spend in 2025 was posted on a few days per campaign and people often
          register weeks after seeing an ad, so a week's spend and that week's registrations are not cause and effect.
        </p>
      </Card>
    </>
  );
}
