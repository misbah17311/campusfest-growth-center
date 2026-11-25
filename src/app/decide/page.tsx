import { Suspense } from "react";
import { resolveAsOf } from "@/lib/asof";
import { getCampaignMetrics, getFunnel } from "@/lib/metrics";
import { getDecisions, getProjection, getRules } from "@/lib/analytics";
import { getInitiatives } from "@/lib/execution";
import { fmtDate, fmtInr, fmtInt, fmtPct } from "@/lib/format";
import { Card, DecisionBadge, PageTitle, Td, Th } from "@/components/ui";
import { ActionForm, inputCls, labelCls } from "@/components/ActionForm";
import { WhatIf } from "@/components/WhatIf";
import { setProjectionRatio, updateRules } from "@/app/actions";

export default function Page({ searchParams }: PageProps<"/decide">) {
  return (
    <Suspense fallback={<p className="text-sm text-ink-2">Loading…</p>}>
      <Decide searchParams={searchParams} />
    </Suspense>
  );
}

async function Decide({ searchParams }: { searchParams: PageProps<"/decide">["searchParams"] }) {
  const { asof } = await searchParams;
  const { asOf } = await resolveAsOf(asof);
  const [decisions, rules, m, f, proj, bets] = await Promise.all([
    getDecisions(asOf), getRules(), getCampaignMetrics(asOf), getFunnel(asOf), getProjection(asOf), getInitiatives(),
  ]);
  const post = f.event_phase === "after";
  const planRatio = proj?.visitors_per_registration ?? null;
  const whatIfRows = m.map((r) => ({
    campaign_id: r.campaign_id,
    campaign_name: r.campaign_name,
    paid: r.channel === "paid_social" || r.channel === "creators",
    spend: r.spend_inr,
    registered: r.registered,
    visitors_per_registration: post ? (r.registered ? r.visitors / r.registered : 0) : (planRatio ?? 0),
  }));

  return (
    <>
      <PageTitle title="Decide"
        intro={<>Scale, change or stop each campaign by pre-committed thresholds, test budget moves, and track the strategic
          bets. Before the festival only leading indicators exist (cost per registration, confirmation, form completion,
          opt-outs); after it, cost per verified visitor and show-up decide. Viewing {fmtDate(asOf)}.</>} />

      <Card title="Campaign decisions"
            subtitle={`Basis: ${decisions[0]?.basis ?? "—"} against the all-campaign figure. Rules apply in order: not enough data → stop → change (any quality problem) → scale → keep.`}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="border-b border-line"><Th>Campaign</Th><Th>Decision</Th><Th right>Cost</Th><Th right>× blended</Th><Th>Evidence</Th></tr></thead>
            <tbody>{decisions.map((d) => (
              <tr key={d.campaign_id} className="border-b border-line align-top">
                <Td className="font-medium">{d.campaign_name}</Td><Td><DecisionBadge decision={d.decision} /></Td>
                <Td right>{fmtInr(d.cost_metric)}</Td><Td right>{d.cost_ratio?.toFixed(2) ?? "—"}</Td>
                <Td><ul className="list-inside list-disc text-xs text-ink-2">{d.reasons.map((r) => <li key={r}>{r}</li>)}</ul></Td>
              </tr>))}</tbody>
          </table>
        </div>
      </Card>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-5">
        <Card className="lg:col-span-3" title="Budget what-if"
              subtitle="Move spend between campaigns and see the expected effect, using the same formula as the target model.">
          <WhatIf rows={whatIfRows}
                  ratioBasis={post ? "observed in this campaign, verified visitors ÷ registrations" : `the plan in force: ${fmtPct(planRatio, 2)}`} />
        </Card>

        <div className="space-y-4 lg:col-span-2">
          <Card title="Decision thresholds" subtitle={`Editable. Last changed ${rules.updated_at.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" })}.`}>
            <ActionForm action={updateRules} submitLabel="Save thresholds">
              <div className="grid grid-cols-2 gap-2">
                <label className={labelCls}>Scale if cost ≤ × blended<input name="scale_cost_ratio" defaultValue={rules.scale_cost_ratio} className={inputCls} /></label>
                <label className={labelCls}>Stop if cost ≥ × blended<input name="stop_cost_ratio" defaultValue={rules.stop_cost_ratio} className={inputCls} /></label>
                <label className={labelCls}>Min. confirmation rate<input name="min_confirm_rate" defaultValue={rules.min_confirm_rate} className={inputCls} /></label>
                <label className={labelCls}>Min. form completion<input name="min_form_completion" defaultValue={rules.min_form_completion} className={inputCls} /></label>
                <label className={labelCls}>Max. opt-out rate<input name="max_optout_rate" defaultValue={rules.max_optout_rate} className={inputCls} /></label>
                <label className={labelCls}>Min. show-up (after event)<input name="min_show_up" defaultValue={rules.min_show_up} className={inputCls} /></label>
                <label className={labelCls}>Max. gate loss (after event)<input name="max_gate_loss" defaultValue={rules.max_gate_loss} className={inputCls} /></label>
                <label className={labelCls}>Min. registrations to judge<input name="min_registrations" defaultValue={rules.min_registrations} className={inputCls} /></label>
                <label className={labelCls}>Cohort age for rates (days)<input name="maturity_days" defaultValue={rules.maturity_days} className={inputCls} /></label>
              </div>
              <p className="mt-2 text-xs text-ink-2">Rates are fractions (0.88 = 88%). Confirmation and form completion are judged only on
                registrations and form starts at least this many days old: in 2025, 95% of confirmations came within 4.1 days.</p>
            </ActionForm>
          </Card>

          <Card title="Projection assumption" subtitle="Visitors per registration used for pre-event projections. Leave empty to use the plan's own ratio.">
            <ActionForm action={setProjectionRatio} submitLabel="Save">
              <label className={labelCls}>Visitors per registration (0–1)
                <input name="value" placeholder={`plan ratio ${planRatio?.toFixed(4) ?? ""}`}
                       defaultValue={proj?.ratio_basis.startsWith("assumption") ? String(proj.visitors_per_registration) : ""} className={inputCls} /></label>
            </ActionForm>
          </Card>
        </div>
      </div>

      <Card className="mt-4" title="Strategic bets" subtitle="The five ranked bets from the growth plan, with the KPI and thresholds that decide each one.">
        {bets.length === 0 ? <p className="text-sm text-ink-2">No bets recorded yet.</p> : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="border-b border-line"><Th>#</Th><Th>Bet</Th><Th>Owner</Th><Th right>Budget</Th><Th right>Expected visitors</Th>
                <Th>Primary KPI</Th><Th>Scale / change / stop</Th><Th>Status</Th></tr></thead>
              <tbody>{bets.map((b) => (
                <tr key={b.initiative_id} className="border-b border-line align-top">
                  <Td>{b.rank ?? "—"}</Td>
                  <Td><div className="font-medium">{b.name}</div><div className="mt-0.5 max-w-sm text-xs text-ink-2">{b.hypothesis}</div></Td>
                  <Td className="text-xs">{b.owner_name ?? "—"}</Td><Td right>{fmtInr(b.budget_inr)}</Td>
                  <Td right>{b.expected_visitors == null ? "—" : `${b.expected_visitors > 0 ? "+" : b.expected_visitors < 0 ? "−" : ""}${fmtInt(Math.abs(b.expected_visitors))}`}</Td>
                  <Td className="text-xs">{b.primary_kpi}</Td>
                  <Td className="text-xs text-ink-2"><div>▲ {b.scale_rule}</div><div>◆ {b.change_rule}</div><div>■ {b.stop_rule}</div></Td>
                  <Td className="text-xs">{b.status}</Td>
                </tr>))}</tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
