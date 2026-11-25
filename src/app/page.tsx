import { Suspense } from "react";
import Link from "next/link";
import { resolveAsOf } from "@/lib/asof";
import { getFunnel } from "@/lib/metrics";
import { getDailySeries, getDecisions, getProjection } from "@/lib/analytics";
import { fmtDate, fmtInr, fmtInt, fmtPct, ofGoal } from "@/lib/format";
import { Card, DecisionBadge, PageTitle, StatTile } from "@/components/ui";
import { LineTrend } from "@/components/charts/LineTrend";

export default function Page({ searchParams }: PageProps<"/">) {
  return (
    <Suspense fallback={<p className="text-sm text-ink-2">Loading live metrics…</p>}>
      <Overview searchParams={searchParams} />
    </Suspense>
  );
}

async function Overview({ searchParams }: { searchParams: PageProps<"/">["searchParams"] }) {
  const { asof } = await searchParams;
  const { asOf, event } = await resolveAsOf(asof);
  const [f, daily, proj, decisions] = await Promise.all([
    getFunnel(asOf), getDailySeries(asOf), getProjection(asOf), getDecisions(asOf),
  ]);
  const before = f.event_phase === "before";
  const attention = decisions.filter((d) => d.decision === "stop" || d.decision === "change");

  const stages = [
    { label: "Identified external people", value: f.identified_external, goal: f.identified_goal },
    { label: "Registered people", value: f.registered_people, goal: f.registration_goal },
    { label: "Confirmed (latest status)", value: f.status_confirmed, goal: null },
    { label: "Verified external visitors", value: f.visitors, goal: f.visitors_goal },
  ];
  const max = Math.max(...stages.map((s) => Math.max(s.value, s.goal ?? 0)), 1);
  const ramp = ["#1c5cab", "#256abf", "#3987e5", "#6da7ec"];

  return (
    <>
      <PageTitle
        title="Overview"
        intro={<>Where the campaign stands at the end of <strong>{fmtDate(asOf)}</strong> against the plan in force
          ({f.target_version ?? "none yet"}). A visitor counts only if they are an external person with an admitted and
          verified check-in, counted once. Event: {fmtDate(event.history_start)} data start; festival 12–13 Apr 2025.</>}
      />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Identified external people" value={fmtInt(f.identified_external)}
                  sub={<>of {fmtInt(f.identified_goal)} goal · {fmtPct(ofGoal(f.identified_external, f.identified_goal))}</>}
                  meter={ofGoal(f.identified_external, f.identified_goal)} />
        <StatTile label="Registered people" value={fmtInt(f.registered_people)}
                  sub={<>of {fmtInt(f.registration_goal)} goal · {fmtPct(ofGoal(f.registered_people, f.registration_goal))}</>}
                  meter={ofGoal(f.registered_people, f.registration_goal)} />
        <StatTile label="Verified external visitors" value={before ? "—" : fmtInt(f.visitors)}
                  sub={before ? <>event not started · goal {fmtInt(f.visitors_goal)}</>
                    : <>of {fmtInt(f.visitors_goal)} goal · {fmtPct(ofGoal(f.visitors, f.visitors_goal))} · show-up {fmtPct(f.show_up_rate)}</>}
                  meter={before ? null : ofGoal(f.visitors, f.visitors_goal)} />
        <StatTile label="Net marketing spend" value={fmtInr(f.spend_inr)}
                  sub={<>of {fmtInr(f.budget_inr)} budget · {fmtPct(ofGoal(f.spend_inr, f.budget_inr))} used</>}
                  meter={ofGoal(f.spend_inr, f.budget_inr)} />
      </div>

      {before && proj?.projected_registrations != null && (
        <Card className="mt-4" title="Projection to the event (from data up to this day only)"
              subtitle="Pace = registrations in the last 14 days. Visitors per registration: the plan's own ratio unless an assumption is set on the Decide page.">
          <div className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-3">
            <div>
              <div className="text-xs text-ink-2">Projected registrations</div>
              <div className="text-xl font-semibold">{fmtInt(proj.projected_registrations)}</div>
              <div className="text-xs text-ink-2">goal {fmtInt(proj.registration_goal)} · {fmtPct(ofGoal(proj.projected_registrations, proj.registration_goal))}</div>
            </div>
            <div>
              <div className="text-xs text-ink-2">Pace needed vs current</div>
              <div className="text-xl font-semibold">{fmtInt(proj.required_rate_per_day)} / day</div>
              <div className="text-xs text-ink-2">current {proj.run_rate_per_day.toFixed(1)} / day · {proj.days_to_event} days left</div>
            </div>
            <div>
              <div className="text-xs text-ink-2">Projected visitors</div>
              <div className="text-xl font-semibold">{fmtInt(proj.projected_visitors)}</div>
              <div className="text-xs text-ink-2">goal {fmtInt(proj.visitors_goal)} · {fmtPct(proj.visitors_per_registration, 2)} per registration ({proj.ratio_basis})</div>
            </div>
          </div>
        </Card>
      )}

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-5">
        <Card className="lg:col-span-3" title="Cumulative funnel over time"
              subtitle="Registered and confirmed people (latest status that day); visitors appear from the first festival day.">
          <LineTrend
            data={daily.map((d) => ({ day: d.day, registered: d.registered, confirmed: d.confirmed, visitors: d.visitors || null }))}
            series={[
              { key: "registered", label: "Registered", color: "var(--s1)" },
              { key: "confirmed", label: "Confirmed", color: "var(--s2)" },
              { key: "visitors", label: "Verified visitors", color: "var(--s3)" },
            ]}
            goal={f.registration_goal} goalLabel={`Registration goal ${fmtInt(f.registration_goal)}`}
            caption="Hover for exact values; the table view lists every day."
          />
        </Card>
        <Card className="lg:col-span-2" title="Funnel against goals" subtitle="Thin mark = goal in the plan in force.">
          <div className="space-y-3">
            {stages.map((s, i) => (
              <div key={s.label}>
                <div className="flex justify-between text-xs"><span className="text-ink-2">{s.label}</span>
                  <span className="num text-ink">{fmtInt(s.value)}{s.goal ? ` / ${fmtInt(s.goal)}` : ""}</span></div>
                <div className="relative mt-1 h-3">
                  <div className="h-3 rounded-r" style={{ width: `${(s.value / max) * 100}%`, background: ramp[i] }}
                       title={`${s.label}: ${fmtInt(s.value)}`} />
                  {s.goal != null && (
                    <div className="absolute top-[-3px] h-[18px] w-[2px] bg-ink" style={{ left: `${(s.goal / max) * 100}%` }}
                         title={`Goal ${fmtInt(s.goal)}`} />
                  )}
                </div>
              </div>
            ))}
          </div>
          <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
            <dt className="text-ink-2">Interested (not yet confirmed)</dt><dd className="num text-right">{fmtInt(f.status_interested)}</dd>
            <dt className="text-ink-2">Waitlisted</dt><dd className="num text-right">{fmtInt(f.status_waitlisted)}</dd>
            <dt className="text-ink-2">Cancelled</dt><dd className="num text-right">{fmtInt(f.status_cancelled)}</dd>
            <dt className="text-ink-2">Walk-in visitors (no registration)</dt><dd className="num text-right">{before ? "—" : fmtInt(f.visitors_walk_in)}</dd>
          </dl>
        </Card>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-5">
        <Card className="lg:col-span-3" title="Net spend against budget"
              subtitle="Cumulative net ledger spend (vendor credits subtract on their posting date).">
          <LineTrend data={daily.map((d) => ({ day: d.day, spend: d.spend_inr }))}
                     series={[{ key: "spend", label: "Net spend", color: "var(--s1)" }]}
                     goal={f.budget_inr} goalLabel={`Budget ${fmtInr(f.budget_inr)}`} inr height={200}
                     caption="The budget line is the approved limit in the plan in force on this day." />
        </Card>
        <Card className="lg:col-span-2" title="Needs attention" subtitle={<>From the decision rules on the <Link className="underline" href={`/decide?asof=${asOf}`}>Decide</Link> page.</>}>
          {attention.length === 0 ? <p className="text-sm text-ink-2">No campaign is flagged to change or stop.</p> : (
            <ul className="space-y-3">
              {attention.map((d) => (
                <li key={d.campaign_id} className="text-sm">
                  <div className="flex items-center gap-2"><DecisionBadge decision={d.decision} /><span className="font-medium">{d.campaign_name}</span></div>
                  <ul className="ml-1 mt-1 list-inside list-disc text-xs text-ink-2">
                    {d.reasons.map((r) => <li key={r}>{r}</li>)}
                  </ul>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
