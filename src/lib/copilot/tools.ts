import "server-only";
import { z } from "zod";
import { getPool, query } from "@/lib/db";
import { getEvent } from "@/lib/asof";
import { getCampaignMetrics, getFunnel, dataDiffersFromOriginal } from "@/lib/metrics";
import {
  getCampaignLeaks, getDailySeries, getDecisions, getLeadTime, getLeaks, getProjection, getQuality, getRules, getWeekly,
} from "@/lib/analytics";
import { getChanges, getInitiatives, getTargets, getTasks, getTeam } from "@/lib/execution";
import { DATA_LIMITS } from "@/lib/limits";
import { calculate } from "./calc";

// Every tool the copilot can call. Read tools call the same SQL functions as the
// dashboard (so the two always agree). Proposal tools never write: they return
// a proposal the user must confirm in the UI.

export type Proposal =
  | { kind: "create_task"; title: string; description: string | null; owner_id: string | null; owner_name: string | null; due_date: string | null;
      priority: "high" | "medium" | "low"; campaign_id: string | null; initiative_id: number | null; evidence: string; as_of: string }
  | { kind: "update_task"; task_id: number; title: string; status?: string; owner_id?: string | null; owner_name?: string | null; due_date?: string | null;
      priority?: string; reason: string }
  | { kind: "update_campaign"; campaign_id: string; campaign_name: string; status?: string; planned_budget_inr?: number | null;
      reason: string };

export type ToolContext = { asOf: string; proposals: Proposal[] };

const asOfParam = {
  as_of: { type: "string", description: "Date YYYY-MM-DD between 2025-01-15 and 2025-04-20 (end of that day, India time). Omit to use the date selected in the dashboard." },
};

export const TOOL_DEFS = [
  {
    name: "get_overview",
    description: "Headline funnel as of a date against the plan in force: identified external people, registered people, status counts (confirmed / interested / waitlisted / cancelled), verified external visitors, walk-ins, show-up rate of confirmed registrants, net spend vs budget, anonymous platform totals, event phase, and the pre-event projection. Also says whether the working data has been edited away from the original workbook.",
    parameters: { type: "object", properties: { ...asOfParam }, additionalProperties: false },
  },
  {
    name: "get_campaign_metrics",
    description: "Per-campaign funnel and efficiency as of a date: spend, impressions, clicks, reported reach (summed daily platform reach, NOT unique people), CTR, identified, form starters, registered, confirmed, cancelled, waitlisted, visitors, show-up, cost per registration, cost per verified visitor, nurture emails sent/opened/clicked, opt-outs, owner, status.",
    parameters: { type: "object", properties: { ...asOfParam, campaign_ids: { type: "array", items: { type: "string" }, description: "Optional campaign ids (C01..C07) to filter" } }, additionalProperties: false },
  },
  {
    name: "get_trend",
    description: "Time series. grain 'daily' WITHOUT campaign_ids = ALL CAMPAIGNS COMBINED: cumulative identified, registered, confirmed, visitors and net spend per day, plus registrations that day. grain 'daily' WITH campaign_ids = per campaign per day (NOT cumulative): net spend, impressions, clicks, reported reach, landing sessions, form-start events, registrations. grain 'weekly' = per campaign per week (weeks start Monday). Every result states its scope; never present an all-campaign figure as one campaign's.",
    parameters: { type: "object", properties: { ...asOfParam, grain: { type: "string", enum: ["daily", "weekly"] }, campaign_ids: { type: "array", items: { type: "string" } } }, required: ["grain"], additionalProperties: false },
  },
  {
    name: "get_funnel_leaks",
    description: "Where people leave the funnel as of a date, overall and per campaign: abandoned the registration form, never started it, still interested, waitlisted, cancelled, confirmed but lost at the gate (denied/pending only), confirmed but did not come, plus walk-ins. Also a gate breakdown: people with a denied scan, how many of them were later admitted, and people left pending/unverified.",
    parameters: { type: "object", properties: { ...asOfParam }, additionalProperties: false },
  },
  {
    name: "get_decisions",
    description: "The scale / keep / change / stop decision for each campaign from the pre-committed thresholds (cost vs blended, confirmation and form completion on mature cohorts, opt-outs, and after the event show-up and gate losses), with the evidence for each, plus the thresholds themselves.",
    parameters: { type: "object", properties: { ...asOfParam }, additionalProperties: false },
  },
  {
    name: "get_showup_by_lead_time",
    description: "Show-up of confirmed registrants grouped by how many days before the festival they registered (only after the festival has started).",
    parameters: { type: "object", properties: { ...asOfParam }, additionalProperties: false },
  },
  {
    name: "get_plan",
    description: "All plan versions (targets and constraints) with the date each takes effect: identified goal, registration goal, unique visitor goal, marketing budget, optional venue capacity. The version in force on a date is the latest one starting on or before it.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_tasks_and_bets",
    description: "Current tasks (title, owner, due date, status, priority, linked campaign, source) and the strategic bets (initiatives) with their KPIs and thresholds. Also the team members and their ids.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_change_log",
    description: "Recent edits to the data (who, when, what changed, before and after) and data-quality notes (duplicates removed, records excluded and why).",
    parameters: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 50 }, ...asOfParam }, additionalProperties: false },
  },
  {
    name: "describe_data",
    description: "The data model, metric definitions, the rules applied (deduplication, who counts as a visitor, as-of logic), what the data CANNOT answer, and the tables/functions available to run_sql. Call this before run_sql and whenever unsure whether the data can answer a question.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "run_sql",
    description: "Run ONE read-only SELECT (or WITH ... SELECT) against the database for questions the other tools do not cover. Max 200 rows, 4 s timeout, writes are impossible. Prefer the *_asof(date) functions, which already apply every data rule. Show the user the query if the answer depends on it.",
    parameters: { type: "object", properties: { sql: { type: "string" }, purpose: { type: "string", description: "One line: what this query answers" } }, required: ["sql", "purpose"], additionalProperties: false },
  },
  {
    name: "calculate",
    description: "Exact arithmetic. Use for EVERY number you derive yourself (ratios, differences, shares, what-ifs). Supports + - * / ^ ( ) min max round(x,digits) abs sqrt. Write numbers without thousands separators.",
    parameters: { type: "object", properties: { expression: { type: "string" }, label: { type: "string" } }, required: ["expression"], additionalProperties: false },
  },
  {
    name: "what_if_budget",
    description: "Estimate the effect of moving spend between campaigns, using the same diminishing-returns model as the plan: registrations_c = registered_c * (new_spend_c / spend_c) ^ beta, beta 0.5 for paid reach (Paid Social, Creators) and 0.7 for peer and group channels unless given. Visitors use each campaign's observed visitors per registration after the event, otherwise the plan's ratio. This is an estimate under stated assumptions, not a forecast.",
    parameters: { type: "object", properties: { ...asOfParam, new_spend: { type: "object", additionalProperties: { type: "number" }, description: "campaign_id -> new total spend in INR; omitted campaigns keep their spend" }, beta_paid: { type: "number" }, beta_peer: { type: "number" } }, required: ["new_spend"], additionalProperties: false },
  },
  {
    name: "propose_task",
    description: "Prepare a NEW task for the user to confirm. It is NOT created until the user clicks Confirm on the card. Include the evidence (numbers and date) that motivates it.",
    parameters: { type: "object", properties: {
      title: { type: "string" }, description: { type: "string" }, owner_id: { type: "string", description: "Team member id, e.g. T04" },
      due_date: { type: "string", description: "YYYY-MM-DD" }, priority: { type: "string", enum: ["high", "medium", "low"] },
      campaign_id: { type: "string" }, initiative_id: { type: "integer" }, evidence: { type: "string" },
    }, required: ["title", "evidence"], additionalProperties: false },
  },
  {
    name: "propose_task_update",
    description: "Prepare a change to an EXISTING task (status, owner, due date, priority) for the user to confirm. Not applied until confirmed.",
    parameters: { type: "object", properties: {
      task_id: { type: "integer" }, status: { type: "string", enum: ["todo", "in_progress", "blocked", "done"] }, owner_id: { type: "string" },
      due_date: { type: "string" }, priority: { type: "string", enum: ["high", "medium", "low"] }, reason: { type: "string" },
    }, required: ["task_id", "reason"], additionalProperties: false },
  },
  {
    name: "propose_campaign_update",
    description: "Prepare a change to a campaign's status (active / paused / stopped) or planned budget for the user to confirm. Not applied until confirmed.",
    parameters: { type: "object", properties: {
      campaign_id: { type: "string" }, status: { type: "string", enum: ["active", "paused", "stopped"] },
      planned_budget_inr: { type: "integer", minimum: 0 }, reason: { type: "string" },
    }, required: ["campaign_id", "reason"], additionalProperties: false },
  },
] as const;

const DateArg = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

async function asOfFrom(args: { as_of?: string }, ctx: ToolContext) {
  if (args.as_of == null) return ctx.asOf;
  const d = DateArg.parse(args.as_of);
  const e = await getEvent();
  if (d < e.history_start || d > e.history_end) {
    throw new Error(`as_of must be between ${e.history_start} and ${e.history_end}; the data covers only that range`);
  }
  return d;
}

const round = (v: unknown) => (typeof v === "number" && !Number.isInteger(v) ? Math.round(v * 10000) / 10000 : v);
// Timestamps are shown in India time (+05:30) so the model never misreads a UTC time.
const ist = (d: Date) => new Date(d.getTime() + 5.5 * 3600_000).toISOString().replace(/\.\d{3}Z$/, "+05:30");
const compact = <T extends Record<string, unknown>>(rows: T[]) =>
  rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v instanceof Date ? ist(v) : round(v)])));

const FORBIDDEN_SQL = /\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|copy|vacuum|reset_to_original|set_config|pg_sleep|pg_read|pg_ls|lo_import|lo_export|dblink|pg_terminate|pg_cancel)\b/i;

async function runReadOnlySql(sql: string) {
  const trimmed = sql.trim().replace(/;\s*$/, "");
  if (!/^(select|with)\b/i.test(trimmed)) throw new Error("Only a single SELECT or WITH ... SELECT is allowed");
  if (trimmed.includes(";")) throw new Error("Only one statement is allowed");
  if (FORBIDDEN_SQL.test(trimmed)) throw new Error("That query uses a keyword or function that is not allowed");
  const client = await getPool().connect();
  try {
    await client.query("begin transaction read only");
    await client.query("set local statement_timeout = '4s'");
    await client.query("set local search_path = public");
    const res = await client.query(`select * from (${trimmed}) as q limit 201`);
    await client.query("rollback");
    const rows = res.rows.slice(0, 200);
    return { row_count: rows.length, truncated: res.rows.length > 200, rows: compact(rows) };
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export async function runTool(name: string, rawArgs: unknown, ctx: ToolContext): Promise<unknown> {
  const args = (rawArgs ?? {}) as Record<string, unknown>;
  switch (name) {
    case "get_overview": {
      const d = await asOfFrom(args, ctx);
      const [f, proj, edited] = await Promise.all([getFunnel(d), getProjection(d), dataDiffersFromOriginal()]);
      return { as_of: d, funnel: compact([f])[0], projection: proj?.event_phase === "before" ? compact([proj])[0] : null,
        working_data_edited: edited };
    }
    case "get_campaign_metrics": {
      const d = await asOfFrom(args, ctx);
      const ids = (args.campaign_ids as string[] | undefined) ?? null;
      const rows = (await getCampaignMetrics(d)).filter((r) => !ids || ids.includes(r.campaign_id));
      return { as_of: d, note: "People-based stages use the recorded source campaign; impressions/clicks are anonymous events.", campaigns: compact(rows) };
    }
    case "get_trend": {
      const d = await asOfFrom(args, ctx);
      if (args.grain === "weekly") {
        const ids = (args.campaign_ids as string[] | undefined) ?? null;
        return { as_of: d, scope: ids ? `per campaign per week for ${ids.join(", ")}` : "per campaign per week, all campaigns",
          weekly: compact((await getWeekly(d)).filter((r) => !ids || ids.includes(r.campaign_id))) };
      }
      const ids = (args.campaign_ids as string[] | undefined) ?? null;
      if (ids && ids.length) {
        const rows = await query(
          `with days as (
             select c.campaign_id, c.campaign_name, gs::date as day
             from campaigns c, event e, generate_series(e.history_start, least($1::date, e.history_end), interval '1 day') gs
             where c.campaign_id = any($2)
           ),
           dm as (select campaign_id, activity_date as day, sum(marketing_spend_inr) as spend_inr, sum(impressions) as impressions,
                         sum(clicks) as clicks, sum(reported_reach) as reported_reach, sum(landing_page_sessions) as landing_sessions,
                         sum(registration_starts) as form_start_events
                  from daily_marketing where activity_date <= $1::date and campaign_id = any($2) group by 1, 2),
           rg as (select r.campaign_id, (r.registered_at at time zone 'Asia/Kolkata')::date as day, count(distinct r.person_id) as registrations
                  from registrations r join people p on p.person_id = r.person_id and p.person_type = 'external'
                  where r.registered_at < cutoff($1::date) and r.campaign_id = any($2) group by 1, 2)
           select days.campaign_id, days.campaign_name, days.day::text as day,
                  coalesce(dm.spend_inr, 0)::int as spend_inr, coalesce(dm.impressions, 0)::int as impressions,
                  coalesce(dm.clicks, 0)::int as clicks, coalesce(dm.reported_reach, 0)::int as reported_reach,
                  coalesce(dm.landing_sessions, 0)::int as landing_sessions, coalesce(dm.form_start_events, 0)::int as form_start_events,
                  coalesce(rg.registrations, 0)::int as registrations
           from days left join dm using (campaign_id, day) left join rg using (campaign_id, day)
           order by days.campaign_id, days.day`, [d, ids]);
        return { as_of: d, scope: `per campaign per day for ${ids.join(", ")} (daily values, not cumulative)`, daily: compact(rows as Record<string, unknown>[]) };
      }
      return { as_of: d, scope: "ALL CAMPAIGNS COMBINED, cumulative to each day (spend_inr is total net spend across every campaign)",
        daily: compact(await getDailySeries(d)) };
    }
    case "get_funnel_leaks": {
      const d = await asOfFrom(args, ctx);
      const [all, byCampaign, f, gate] = await Promise.all([getLeaks(d), getCampaignLeaks(d), getFunnel(d), query(
        `with ext as (select person_id from people where person_type = 'external'),
         ck as (select c.* from checkins c join ext using (person_id) where c.occurred_at < cutoff($1::date)),
         ok as (select distinct person_id from ck where result = 'admitted' and verification = 'verified'),
         den as (select distinct person_id from ck where result = 'denied'),
         pend as (select distinct person_id from ck where result = 'pending' or verification = 'unverified')
         select (select count(*) from den)::int as people_with_a_denied_scan,
                (select count(*) from den where person_id in (select person_id from ok))::int as denied_but_later_admitted,
                (select count(*) from den where person_id not in (select person_id from ok))::int as denied_never_admitted,
                (select count(*) from pend where person_id not in (select person_id from ok) and person_id not in (select person_id from den))::int as pending_or_unverified_only_never_admitted,
                (select count(*) from ck where result = 'denied')::int as denied_scan_records`, [d])]);
      return { as_of: d, overall: compact(all), by_campaign: compact(byCampaign),
        identified_not_registered: {
          identified: f.identified_external, registered: f.registered_people,
          gap: f.identified_external - f.registered_people,
          of_which_walked_in_without_registering: f.visitors_walk_in,
          note: "The leak rows exclude walk-ins: identified people who never registered but came anyway are visitors, not a leak. The leak rows plus walk-ins add up to the gap.",
        },
        gate_breakdown: { ...gate[0], note: "Denied is one check-in result; 'never admitted' also includes people left pending/unverified. Answer the question asked: denied people, or people never admitted." } };
    }
    case "get_decisions": {
      const d = await asOfFrom(args, ctx);
      const [dec, rules] = await Promise.all([getDecisions(d), getRules()]);
      return { as_of: d, decisions: compact(dec), thresholds: compact([rules])[0] };
    }
    case "get_showup_by_lead_time": {
      const d = await asOfFrom(args, ctx);
      return { as_of: d, buckets: compact(await getLeadTime(d)) };
    }
    case "get_plan":
      return { versions: compact(await getTargets()) };
    case "get_tasks_and_bets": {
      const [tasks, bets, team] = await Promise.all([getTasks(), getInitiatives(), getTeam()]);
      return { tasks: compact(tasks), bets: compact(bets), team };
    }
    case "get_change_log": {
      const d = await asOfFrom(args, ctx);
      const [changes, quality] = await Promise.all([getChanges(Number(args.limit ?? 20)), getQuality(d)]);
      return { changes: compact(changes), data_quality: compact(quality) };
    }
    case "describe_data":
      return DATA_DESCRIPTION;
    case "run_sql":
      return await runReadOnlySql(z.string().min(1).max(4000).parse(args.sql));
    case "calculate": {
      const expression = z.string().parse(args.expression);
      return { expression, result: calculate(expression), label: args.label ?? null };
    }
    case "what_if_budget":
      return await whatIf(args, ctx);
    case "propose_task": {
      const p = z.object({
        title: z.string().min(1).max(200), description: z.string().max(2000).optional(), owner_id: z.string().optional(),
        due_date: DateArg.optional(), priority: z.enum(["high", "medium", "low"]).optional(), campaign_id: z.string().optional(),
        initiative_id: z.number().int().optional(), evidence: z.string().min(1).max(2000),
      }).parse(args);
      await assertRefs({ owner_id: p.owner_id, campaign_id: p.campaign_id, initiative_id: p.initiative_id });
      const proposal: Proposal = { kind: "create_task", title: p.title, description: p.description ?? null, owner_id: p.owner_id ?? null,
        owner_name: await ownerName(p.owner_id),
        due_date: p.due_date ?? plusDays(ctx.asOf, 7), priority: p.priority ?? "medium", campaign_id: p.campaign_id ?? null,
        initiative_id: p.initiative_id ?? null, evidence: p.evidence, as_of: ctx.asOf };
      ctx.proposals.push(proposal);
      return { status: "proposal shown to the user; NOT created until they click Confirm", proposal };
    }
    case "propose_task_update": {
      const p = z.object({ task_id: z.number().int(), status: z.enum(["todo", "in_progress", "blocked", "done"]).optional(),
        owner_id: z.string().optional(), due_date: DateArg.optional(), priority: z.enum(["high", "medium", "low"]).optional(),
        reason: z.string().min(1) }).parse(args);
      const t = (await query<{ title: string }>("select title from tasks where task_id = $1", [p.task_id]))[0];
      if (!t) throw new Error(`No task with id ${p.task_id}`);
      await assertRefs({ owner_id: p.owner_id });
      const proposal: Proposal = { kind: "update_task", ...p, title: t.title, ...(p.owner_id ? { owner_name: await ownerName(p.owner_id) } : {}) };
      ctx.proposals.push(proposal);
      return { status: "proposal shown to the user; NOT applied until they click Confirm", proposal };
    }
    case "propose_campaign_update": {
      const p = z.object({ campaign_id: z.string(), status: z.enum(["active", "paused", "stopped"]).optional(),
        planned_budget_inr: z.number().int().min(0).optional(), reason: z.string().min(1) }).parse(args);
      const c = (await query<{ campaign_name: string }>("select campaign_name from campaigns where campaign_id = $1", [p.campaign_id]))[0];
      if (!c) throw new Error(`No campaign with id ${p.campaign_id}`);
      const proposal: Proposal = { kind: "update_campaign", ...p, campaign_name: c.campaign_name };
      ctx.proposals.push(proposal);
      return { status: "proposal shown to the user; NOT applied until they click Confirm", proposal };
    }
    default:
      throw new Error(`Unknown tool ${name}`);
  }
}

function plusDays(iso: string, n: number) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

async function ownerName(id?: string) {
  if (!id) return null;
  return (await query<{ owner_name: string }>("select owner_name from team where owner_id = $1", [id]))[0]?.owner_name ?? null;
}

async function assertRefs(r: { owner_id?: string; campaign_id?: string; initiative_id?: number }) {
  if (r.owner_id && !(await query("select 1 from team where owner_id = $1", [r.owner_id])).length)
    throw new Error(`Unknown owner_id ${r.owner_id}; call get_tasks_and_bets for the team list`);
  if (r.campaign_id && !(await query("select 1 from campaigns where campaign_id = $1", [r.campaign_id])).length)
    throw new Error(`Unknown campaign_id ${r.campaign_id}`);
  if (r.initiative_id && !(await query("select 1 from initiatives where initiative_id = $1", [r.initiative_id])).length)
    throw new Error(`Unknown initiative_id ${r.initiative_id}`);
}

async function whatIf(args: Record<string, unknown>, ctx: ToolContext) {
  const d = await asOfFrom(args as { as_of?: string }, ctx);
  const newSpend = z.record(z.string(), z.number().min(0)).parse(args.new_spend ?? {});
  const betaPaid = z.number().min(0.05).max(1.5).parse(args.beta_paid ?? 0.5);
  const betaPeer = z.number().min(0.05).max(1.5).parse(args.beta_peer ?? 0.7);
  const [m, f, proj] = await Promise.all([getCampaignMetrics(d), getFunnel(d), getProjection(d)]);
  const post = f.event_phase === "after";
  const rows = m.map((r) => {
    const paid = r.channel === "paid_social" || r.channel === "creators";
    const s1 = newSpend[r.campaign_id] ?? r.spend_inr;
    const beta = paid ? betaPaid : betaPeer;
    const reg1 = r.spend_inr > 0 ? r.registered * (s1 / r.spend_inr) ** beta : r.registered;
    const vpr = post ? (r.registered ? r.visitors / r.registered : 0) : (proj?.visitors_per_registration ?? 0);
    return { campaign_id: r.campaign_id, campaign_name: r.campaign_name, spend_now: r.spend_inr, spend_new: s1, beta,
      registrations_now: r.registered, registrations_new: Math.round(reg1), visitors_now: Math.round(r.registered * vpr),
      visitors_new: Math.round(reg1 * vpr) };
  });
  const sum = (k: keyof (typeof rows)[number]) => rows.reduce((a, r) => a + Number(r[k]), 0);
  return { as_of: d, assumptions: { beta_paid: betaPaid, beta_peer: betaPeer,
      visitors_per_registration: post ? "observed per campaign (verified visitors / registrations)" : `plan ratio ${proj?.visitors_per_registration}`,
      caveat: "Response to spend beyond the range seen in 2025 is assumed, not observed; walk-ins excluded." },
    campaigns: rows, totals: { spend_now: sum("spend_now"), spend_new: sum("spend_new"), registrations_now: sum("registrations_now"),
      registrations_new: sum("registrations_new"), visitors_now: sum("visitors_now"), visitors_new: sum("visitors_new") } };
}

export const DATA_DESCRIPTION = {
  dataset: "CampusFest 2025, a fictional two-day college festival on 12-13 April 2025. Records cover 15 Jan - 20 Apr 2025. All people and activity are synthetic. The product treats it as last year's campaign, replayed day by day.",
  as_of_rule: "Every metric takes a date meaning the END of that day in India time; nothing that happened later is used. Statuses are the latest version on or before that moment. Targets/budget are the plan version in force then (launch plan from 15 Jan, revised plan from 15 Mar 09:00).",
  definitions: {
    identified_external: "Distinct external people first seen on or before the date (campaign-acquired people plus walk-ins identified at the gate).",
    registered_people: "Distinct external people with a registration.",
    confirmed: "Registered people whose latest status is confirmed (a person with several registrations counts once, at their most advanced status).",
    visitor: "An EXTERNAL person with at least one check-in that is result=admitted AND verification=verified, counted once however many admissions. Internal, staff and test people never count. Denied/pending/unverified records alone do not count.",
    walk_in: "A visitor with no registration; has no campaign.",
    show_up_rate: "Confirmed registrants who became visitors / confirmed registrants. Undefined before the festival.",
    spend: "Net ledger spend: debits minus credits on their posting date; negative rows are vendor credits.",
    anonymous_counts: "Impressions, clicks, reported reach, landing sessions and registration_starts in daily_marketing are platform EVENT counts, not people. Never add reach across days as if it were unique people.",
    attribution: "Recorded source only: registrations carry the acquisition campaign; people carry first_campaign_id; a visitor is attributed through the registration on their first verified admission. Each person has exactly one campaign, so multi-touch attribution is impossible.",
    cost_per_registration: "Campaign net spend / registered people of that campaign.",
    cost_per_visitor: "Campaign net spend / verified visitors attributed to that campaign (walk-ins excluded). Only after the festival starts.",
    blended: "All-campaign totals, used as the reference for decisions.",
  },
  data_rules_already_applied: [
    "Import-retry duplicates (same ID, identical row) were removed at load: 2 in daily marketing, 4 in registration history, 20 in check-ins.",
    "All *_asof functions apply the external-only, admitted+verified, latest-status and cutoff rules.",
  ],
  cannot_answer: DATA_LIMITS,
  sql: {
    functions: [
      "funnel_asof(date)", "campaign_metrics_asof(date)", "registration_status_asof(date) -> registration_id, person_id, campaign_id, registered_at, status, status_since, is_external",
      "visitors_asof(date) -> person_id, first_admitted_at, registration_id, campaign_id, days_attended, admitted_day1, admitted_day2",
      "daily_series_asof(date)", "weekly_campaign_asof(date)", "funnel_leaks_asof(date)", "campaign_leaks_asof(date)",
      "showup_by_lead_time_asof(date)", "projection_asof(date)", "campaign_decisions_asof(date)", "target_asof(date)", "cutoff(date) -> timestamptz end of day IST",
    ],
    tables: {
      campaigns: "campaign_id, campaign_name, channel, target_audience, objective, owner_id, created_at, planned_start_at, planned_end_at, status, planned_budget_inr",
      team: "owner_id, owner_name",
      targets: "version_id, effective_at, identified_external_people_goal, registration_goal, unique_external_visitors_goal, marketing_budget_inr, target_version, venue_capacity_per_day",
      daily_marketing: "activity_id, campaign_id, owner_id, activity_date (date), impressions, clicks, reported_reach, landing_page_sessions, registration_starts, marketing_spend_inr, platform",
      people: "person_id, person_name, person_type (external|internal|staff|test), first_seen_at, first_touch_source, first_campaign_id, owner_id",
      interactions: "interaction_id, person_id, campaign_id, owner_id, occurred_at, event_type (page_visit|brochure_download|registration_start|event_question_submitted|nurture_email_sent|nurture_email_opened|nurture_email_clicked|opted_out), detail",
      registrations: "registration_id, person_id, campaign_id, owner_id, registered_at",
      registration_history: "history_id, registration_id, person_id, campaign_id, owner_id, effective_at, status (interested|confirmed|cancelled|waitlisted)",
      checkins: "event_id, person_id, registration_id, campaign_id, owner_id, occurred_at, result (admitted|denied|pending), verification (verified|unverified), source (scanner|manual)",
      tasks: "task_id, title, description, owner_id, due_date, status, priority, campaign_id, initiative_id, source, evidence, created_at",
      change_log: "change_id, changed_at, actor, table_name, row_id, action, before, after, note",
    },
    tips: "Timestamps are timestamptz; compare with cutoff('YYYY-MM-DD') for 'as of' filters, e.g. occurred_at < cutoff('2025-03-15'). Convert to IST dates with (ts at time zone 'Asia/Kolkata')::date. Raw tables are NOT filtered to external people or verified admissions: apply those rules yourself or use the *_asof functions.",
  },
};
