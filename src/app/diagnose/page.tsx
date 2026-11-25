import { Suspense } from "react";
import { resolveAsOf } from "@/lib/asof";
import { getCampaignMetrics, getFunnel } from "@/lib/metrics";
import { getCampaignLeaks, getLeadTime, getLeaks, getQuality } from "@/lib/analytics";
import { fmtDate, fmtInt, fmtPct } from "@/lib/format";
import { Card, PageTitle, StatusDot, Td, Th } from "@/components/ui";
import { HeatCell, divergingColor } from "@/components/charts/Heatmap";
import { DATA_LIMITS } from "@/lib/limits";

export default function Page({ searchParams }: PageProps<"/diagnose">) {
  return (
    <Suspense fallback={<p className="text-sm text-ink-2">Loading…</p>}>
      <Diagnose searchParams={searchParams} />
    </Suspense>
  );
}



async function Diagnose({ searchParams }: { searchParams: PageProps<"/diagnose">["searchParams"] }) {
  const { asof } = await searchParams;
  const { asOf } = await resolveAsOf(asof);
  const [m, f, leaks, cleaks, lead, quality] = await Promise.all([
    getCampaignMetrics(asOf), getFunnel(asOf), getLeaks(asOf), getCampaignLeaks(asOf), getLeadTime(asOf), getQuality(asOf),
  ]);
  const post = f.event_phase !== "before";
  const sum = (k: keyof (typeof m)[number]) => m.reduce((a, r) => a + Number(r[k] ?? 0), 0);
  const overall = {
    ctr: sum("clicks") / Math.max(1, sum("impressions")),
    identified_to_registered: sum("registered") / Math.max(1, sum("identified")),
    starter_to_registered: sum("registered") / Math.max(1, sum("form_starters")),
    registered_to_confirmed: sum("confirmed") / Math.max(1, sum("registered")),
    show_up_rate: post ? sum("confirmed_who_attended") / Math.max(1, sum("confirmed")) : null,
    optout: sum("opted_out") / Math.max(1, sum("nurture_sent")),
  };
  const stages: { key: keyof typeof overall; label: string; higherBetter: boolean; get: (r: (typeof m)[number]) => number | null }[] = [
    { key: "ctr", label: "Click-through", higherBetter: true, get: (r) => r.ctr },
    { key: "identified_to_registered", label: "Identified → registered", higherBetter: true, get: (r) => r.identified_to_registered },
    { key: "starter_to_registered", label: "Form completion", higherBetter: true, get: (r) => r.starter_to_registered },
    { key: "registered_to_confirmed", label: "Registered → confirmed", higherBetter: true, get: (r) => r.registered_to_confirmed },
    { key: "show_up_rate", label: "Confirmed → visited", higherBetter: true, get: (r) => r.show_up_rate },
    { key: "optout", label: "Nurture opt-out", higherBetter: false, get: (r) => (r.nurture_sent ? r.opted_out / r.nurture_sent : null) },
  ];
  const gate = cleaks.filter((c) => (c.gate_lost ?? 0) > 0);
  const name = Object.fromEntries(m.map((r) => [r.campaign_id, r.campaign_name]));
  const maxLeak = Math.max(...leaks.map((l) => l.people ?? 0), 1);

  return (
    <>
      <PageTitle title="Diagnose"
        intro={<>Where each campaign loses people, compared with all campaigns together, at the end of {fmtDate(asOf)}.
          Conversion stages use people; click-through uses anonymous platform events.</>} />

      <Card title="Stage conversion against the all-campaign rate"
            subtitle="Blue = better than all campaigns combined, red = worse, gray = within 1 percentage point. Darker = bigger gap (full colour at 10 points).">
        <div className="overflow-x-auto">
          <table className="border-collapse text-xs">
            <thead><tr><th className="px-2 py-1 text-left font-medium text-ink-2">Campaign</th>
              {stages.map((s) => <th key={s.key} className="px-2 py-1 font-medium text-ink-2">{s.label}</th>)}</tr></thead>
            <tbody>
              {m.map((r) => (
                <tr key={r.campaign_id}>
                  <td className="whitespace-nowrap px-2 py-1">{r.campaign_name}</td>
                  {stages.map((s) => {
                    const v = s.get(r);
                    const ref = overall[s.key];
                    const delta = v == null || ref == null ? null : (s.higherBetter ? v - ref : ref - v) * 100;
                    const c = divergingColor(delta, 10);
                    return <HeatCell key={s.key} text={fmtPct(v)} bg={c.bg} fg={c.fg}
                      title={`${r.campaign_name} · ${s.label}: ${fmtPct(v)} vs ${fmtPct(ref)} for all campaigns`} />;
                  })}
                </tr>
              ))}
              <tr className="font-medium"><td className="px-2 py-1">All campaigns</td>
                {stages.map((s) => <td key={s.key} className="num px-2 py-1 text-center">{fmtPct(overall[s.key])}</td>)}</tr>
            </tbody>
          </table>
        </div>
      </Card>

      {gate.length > 0 && (
        <Card className="mt-4" title="Finding: confirmed registrants lost at the gate">
          {gate.map((g) => (
            <p key={g.campaign_id} className="text-sm">
              <StatusDot tone="critical">{fmtInt(g.gate_lost)} confirmed {name[g.campaign_id]} registrants</StatusDot>{" "}
              reached the gate (they have check-in records) but only ever got denied or pending/unverified results, so they
              never count as visitors. That is {fmtPct((g.gate_lost ?? 0) / Math.max(1, m.find((r) => r.campaign_id === g.campaign_id)!.confirmed))} of
              the campaign's confirmed registrants. Counting them, confirmed {name[g.campaign_id]} registrants reached the gate at{" "}
              {fmtPct(((m.find((r) => r.campaign_id === g.campaign_id)!.confirmed_who_attended) + (g.gate_lost ?? 0)) /
                Math.max(1, m.find((r) => r.campaign_id === g.campaign_id)!.confirmed))}. The data does not record why they were
              denied, so the cause (registration details, QR codes, scanner) has to be checked with the gate team.
            </p>
          ))}
        </Card>
      )}

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card title="Where people leave the funnel (all campaigns)" subtitle="External people only; each person counted once at the stage where they stopped.">
          <ul className="space-y-2.5">
            {leaks.map((l) => (
              <li key={l.sort_order} title={l.note}>
                <div className="flex justify-between text-xs"><span className="text-ink-2">{l.stage}: <span className="text-ink">{l.leak}</span></span>
                  <span className="num">{l.people == null ? "after the event" : fmtInt(l.people)}</span></div>
                <div className="mt-1 h-2.5 rounded-r" style={{ width: `${((l.people ?? 0) / maxLeak) * 100}%`,
                  background: l.sort_order === 8 ? "var(--s3)" : "var(--s1)" }} />
              </li>
            ))}
          </ul>
        </Card>

        <Card title="Show-up by how early people registered" subtitle="Confirmed registrants, grouped by days between registering and the festival.">
          {post ? (
            <table className="w-full text-sm">
              <thead><tr className="border-b border-line"><Th>Registered</Th><Th right>Confirmed</Th><Th right>Came</Th><Th right>Show-up</Th><Th /></tr></thead>
              <tbody>{lead.map((b) => (
                <tr key={b.bucket} className="border-b border-line">
                  <Td>{b.bucket} before</Td><Td right>{fmtInt(b.confirmed)}</Td><Td right>{fmtInt(b.came)}</Td><Td right>{fmtPct(b.show_up_rate)}</Td>
                  <Td><div className="h-2 w-24 rounded-full bg-track"><div className="h-2 rounded-full bg-s1" style={{ width: `${(b.show_up_rate ?? 0) * 100}%` }} /></div></Td>
                </tr>))}</tbody>
            </table>
          ) : <p className="text-sm text-ink-2">Available once the festival has started (show-up cannot be observed before it).</p>}
          <p className="mt-2 text-xs text-ink-2">Observational: early registrants also come more from some channels than others, so lead time and channel are mixed together here.</p>
        </Card>
      </div>

      <Card className="mt-4" title="Leaks by campaign" subtitle="Same stages as above, split by recorded source campaign.">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="border-b border-line"><Th>Campaign</Th><Th right>Abandoned form</Th><Th right>Never started form</Th>
              <Th right>Still interested</Th><Th right>Waitlisted</Th><Th right>Cancelled</Th><Th right>Lost at gate</Th><Th right>Did not come</Th></tr></thead>
            <tbody>{cleaks.map((c) => (
              <tr key={c.campaign_id} className="border-b border-line"><Td>{name[c.campaign_id]}</Td>
                <Td right>{fmtInt(c.abandoned_form)}</Td><Td right>{fmtInt(c.never_started)}</Td><Td right>{fmtInt(c.interested)}</Td>
                <Td right>{fmtInt(c.waitlisted)}</Td><Td right>{fmtInt(c.cancelled)}</Td><Td right>{fmtInt(c.gate_lost)}</Td><Td right>{fmtInt(c.did_not_come)}</Td></tr>
            ))}</tbody>
          </table>
        </div>
      </Card>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card title="Data quality" subtitle="What was removed or excluded before any number was computed, and why.">
          <table className="w-full text-xs">
            <tbody>{quality.map((q) => (
              <tr key={q.item} className="border-b border-line align-top"><Td>{q.item}<div className="text-ink-2">{q.note}</div></Td><Td right>{fmtInt(q.value)}</Td></tr>
            ))}</tbody>
          </table>
        </Card>
        <Card title="What this data cannot tell you" subtitle="Questions the copilot will decline to answer from data, and why.">
          <ul className="list-inside list-disc space-y-1.5 text-sm text-ink-2">
            {DATA_LIMITS.map((d) => <li key={d}>{d}</li>)}
          </ul>
        </Card>
      </div>
    </>
  );
}
