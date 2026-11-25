"use server";

import { refresh } from "next/cache";
import { z } from "zod";
import { withTransaction } from "@/lib/db";

// Every mutation the UI can make. Each validates its input, runs in a
// transaction tagged with the actor (so the change-log trigger records who),
// then refreshes the page so every number recomputes from the database.

export type ActionResult = { ok: boolean; message: string };

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2025-03-20");
const optText = z.string().trim().max(2000).optional().transform((v) => (v ? v : null));
const optId = z.string().trim().optional().transform((v) => (v ? v : null));

function fail(err: unknown): ActionResult {
  if (err instanceof z.ZodError) return { ok: false, message: err.issues.map((i) => i.message).join("; ") };
  const msg = err instanceof Error ? err.message : String(err);
  return { ok: false, message: msg.replace(/^error: /, "") };
}

// ---------------------------------------------------------------- tasks
const TaskInput = z.object({
  title: z.string().trim().min(1, "A task needs a title").max(200),
  description: optText,
  owner_id: optId,
  due_date: isoDate.optional().or(z.literal("")).transform((v) => (v ? v : null)),
  priority: z.enum(["high", "medium", "low"]).default("medium"),
  campaign_id: optId,
  initiative_id: z.string().optional().transform((v) => (v ? Number(v) : null)),
});

export async function createTask(_: ActionResult | null, form: FormData): Promise<ActionResult> {
  try {
    const t = TaskInput.parse(Object.fromEntries(form));
    await withTransaction("user", (c) =>
      c.query(
        `insert into tasks (title, description, owner_id, due_date, priority, campaign_id, initiative_id, source)
         values ($1, $2, $3, $4, $5, $6, $7, 'manual')`,
        [t.title, t.description, t.owner_id, t.due_date, t.priority, t.campaign_id, t.initiative_id],
      ),
    );
    refresh();
    return { ok: true, message: `Task created: ${t.title}` };
  } catch (e) {
    return fail(e);
  }
}

const TaskUpdate = z.object({
  task_id: z.coerce.number().int().positive(),
  status: z.enum(["todo", "in_progress", "blocked", "done"]).optional(),
  owner_id: optId,
  due_date: isoDate.optional().or(z.literal("")).transform((v) => (v ? v : null)),
  priority: z.enum(["high", "medium", "low"]).optional(),
});

export async function updateTask(form: FormData) {
  const t = TaskUpdate.parse(Object.fromEntries(form));
  await withTransaction("user", (c) =>
    c.query(
      `update tasks set status = coalesce($2, status), owner_id = $3, due_date = $4,
              priority = coalesce($5, priority), updated_at = now() where task_id = $1`,
      [t.task_id, t.status ?? null, t.owner_id, t.due_date, t.priority ?? null],
    ),
  );
  refresh();
}

export async function deleteTask(form: FormData) {
  const id = z.coerce.number().int().positive().parse(form.get("task_id"));
  await withTransaction("user", (c) => c.query("delete from tasks where task_id = $1", [id]));
  refresh();
}

// ---------------------------------------------------------------- campaigns
const CampaignUpdate = z.object({
  campaign_id: z.string().min(1),
  status: z.enum(["active", "paused", "stopped"]),
  owner_id: optId,
  planned_budget_inr: z.string().optional().transform((v) => (v ? Number(v) : null))
    .refine((v) => v === null || (Number.isInteger(v) && v >= 0), "Planned budget must be a whole number of rupees, 0 or more"),
});

export async function updateCampaign(_: ActionResult | null, form: FormData): Promise<ActionResult> {
  try {
    const c = CampaignUpdate.parse(Object.fromEntries(form));
    await withTransaction("user", (tx) =>
      tx.query("update campaigns set status = $2, owner_id = $3, planned_budget_inr = $4 where campaign_id = $1",
        [c.campaign_id, c.status, c.owner_id, c.planned_budget_inr]),
    );
    refresh();
    return { ok: true, message: `Saved ${c.campaign_id}` };
  } catch (e) {
    return fail(e);
  }
}

// ---------------------------------------------------------------- targets (append a new dated version)
const TargetInput = z.object({
  effective_date: isoDate,
  target_version: z.string().trim().min(1).max(80),
  identified_external_people_goal: z.coerce.number().int().min(0),
  registration_goal: z.coerce.number().int().min(0),
  unique_external_visitors_goal: z.coerce.number().int().min(0),
  marketing_budget_inr: z.coerce.number().int().min(0),
  venue_capacity_per_day: z.string().optional().transform((v) => (v ? Number(v) : null)),
});

export async function addTargetVersion(_: ActionResult | null, form: FormData): Promise<ActionResult> {
  try {
    const t = TargetInput.parse(Object.fromEntries(form));
    await withTransaction("user", (c) =>
      c.query(
        `insert into targets (effective_at, identified_external_people_goal, registration_goal,
            unique_external_visitors_goal, marketing_budget_inr, target_version, venue_capacity_per_day)
         values (($1::date)::timestamp at time zone 'Asia/Kolkata', $2, $3, $4, $5, $6, $7)`,
        [t.effective_date, t.identified_external_people_goal, t.registration_goal, t.unique_external_visitors_goal,
          t.marketing_budget_inr, t.target_version, t.venue_capacity_per_day],
      ),
    );
    refresh();
    return { ok: true, message: `New plan "${t.target_version}" takes effect from the start of ${t.effective_date}` };
  } catch (e) {
    return fail(e);
  }
}

export async function deleteTargetVersion(form: FormData) {
  const id = z.coerce.number().int().positive().parse(form.get("version_id"));
  await withTransaction("user", (c) => c.query("delete from targets where version_id = $1", [id]));
  refresh();
}

// ---------------------------------------------------------------- spend (one campaign, one day)
const SpendInput = z.object({
  campaign_id: z.string().min(1),
  activity_date: isoDate,
  marketing_spend_inr: z.coerce.number().int("Spend is whole rupees"),
});

export async function setDailySpend(_: ActionResult | null, form: FormData): Promise<ActionResult> {
  try {
    const s = SpendInput.parse(Object.fromEntries(form));
    const result = await withTransaction("user", async (c) => {
      const rows = await c.query(
        "select activity_id, marketing_spend_inr from daily_marketing where campaign_id = $1 and activity_date = $2 order by activity_id",
        [s.campaign_id, s.activity_date]);
      if (rows.rows.length > 1) {
        throw new Error(`There are ${rows.rows.length} rows for this campaign and day; edit them in the database`);
      }
      if (rows.rows.length === 1) {
        await c.query("update daily_marketing set marketing_spend_inr = $2 where activity_id = $1",
          [rows.rows[0].activity_id, s.marketing_spend_inr]);
        return `Spend for ${s.campaign_id} on ${s.activity_date}: ₹${rows.rows[0].marketing_spend_inr} → ₹${s.marketing_spend_inr}`;
      }
      await c.query(
        `insert into daily_marketing (activity_id, campaign_id, owner_id, activity_date, impressions, clicks, reported_reach,
            landing_page_sessions, registration_starts, marketing_spend_inr, platform)
         select $1, c.campaign_id, c.owner_id, $3, 0, 0, 0, 0, 0, $4, 'manual entry (Growth Center)'
         from campaigns c where c.campaign_id = $2`,
        [`MANUAL-${s.campaign_id}-${s.activity_date}`, s.campaign_id, s.activity_date, s.marketing_spend_inr]);
      return `Added a spend row of ₹${s.marketing_spend_inr} for ${s.campaign_id} on ${s.activity_date}`;
    });
    refresh();
    return { ok: true, message: result };
  } catch (e) {
    return fail(e);
  }
}

// ---------------------------------------------------------------- decision thresholds and assumptions
const RulesInput = z.object({
  min_registrations: z.coerce.number().int().min(1),
  scale_cost_ratio: z.coerce.number().positive(),
  stop_cost_ratio: z.coerce.number().positive(),
  min_confirm_rate: z.coerce.number().min(0).max(1),
  min_form_completion: z.coerce.number().min(0).max(1),
  max_optout_rate: z.coerce.number().min(0).max(1),
  min_show_up: z.coerce.number().min(0).max(1),
  max_gate_loss: z.coerce.number().min(0).max(1),
  maturity_days: z.coerce.number().int().min(0).max(60),
}).refine((r) => r.scale_cost_ratio < r.stop_cost_ratio, "The scale threshold must be below the stop threshold");

export async function updateRules(_: ActionResult | null, form: FormData): Promise<ActionResult> {
  try {
    const r = RulesInput.parse(Object.fromEntries(form));
    await withTransaction("user", (c) =>
      c.query(
        `update decision_rules set min_registrations = $1, scale_cost_ratio = $2, stop_cost_ratio = $3,
            min_confirm_rate = $4, min_form_completion = $5, max_optout_rate = $6, min_show_up = $7,
            max_gate_loss = $8, maturity_days = $9, updated_at = now() where id = 1`,
        [r.min_registrations, r.scale_cost_ratio, r.stop_cost_ratio, r.min_confirm_rate, r.min_form_completion,
          r.max_optout_rate, r.min_show_up, r.max_gate_loss, r.maturity_days]),
    );
    refresh();
    return { ok: true, message: "Thresholds saved; every decision has been recomputed." };
  } catch (e) {
    return fail(e);
  }
}

export async function setProjectionRatio(_: ActionResult | null, form: FormData): Promise<ActionResult> {
  try {
    const raw = String(form.get("value") ?? "").trim();
    await withTransaction("user", async (c) => {
      if (!raw) {
        await c.query("delete from assumptions where key = 'projection_visitors_per_registration'");
        return;
      }
      const v = z.coerce.number().min(0).max(1).parse(raw);
      await c.query(
        `insert into assumptions (key, label, value, unit, basis, note)
         values ('projection_visitors_per_registration', 'Visitors per registration (projection)', $1, 'ratio', 'assumed',
                 'Set on the Decide page')
         on conflict (key) do update set value = excluded.value`, [v]);
    });
    refresh();
    return { ok: true, message: raw ? `Projection now uses ${raw} visitors per registration` : "Projection uses the plan's own ratio again" };
  } catch (e) {
    return fail(e);
  }
}

// ---------------------------------------------------------------- reset
export async function resetToOriginal(_: ActionResult | null, form: FormData): Promise<ActionResult> {
  if (form.get("confirm") !== "yes") return { ok: false, message: "Tick the box to confirm the reset" };
  try {
    await withTransaction("user", (c) => c.query("select reset_to_original('user')"));
    refresh();
    return { ok: true, message: "Working data reset to the original workbook. Tasks and bets were kept." };
  } catch (e) {
    return fail(e);
  }
}
