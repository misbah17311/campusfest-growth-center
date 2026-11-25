import { z } from "zod";
import { withTransaction } from "@/lib/db";

// Applies a proposal the user confirmed in the copilot panel. Inputs are
// re-validated here (never trusted from the client), and the change log records
// the actor as "copilot" (proposed by the copilot, confirmed by the user).
const Proposal = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("create_task"), title: z.string().min(1).max(200), description: z.string().max(2000).nullable(),
    owner_id: z.string().nullable(), owner_name: z.string().nullable().optional(), due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
    priority: z.enum(["high", "medium", "low"]), campaign_id: z.string().nullable(), initiative_id: z.number().int().nullable(),
    evidence: z.string().max(2000), as_of: z.string(),
  }),
  z.object({
    kind: z.literal("update_task"), task_id: z.number().int(), title: z.string(), status: z.enum(["todo", "in_progress", "blocked", "done"]).optional(),
    owner_id: z.string().nullable().optional(), owner_name: z.string().nullable().optional(), due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    priority: z.enum(["high", "medium", "low"]).optional(), reason: z.string(),
  }),
  z.object({
    kind: z.literal("update_campaign"), campaign_id: z.string(), campaign_name: z.string(), status: z.enum(["active", "paused", "stopped"]).optional(),
    planned_budget_inr: z.number().int().min(0).nullable().optional(), reason: z.string(),
  }),
]);

export async function POST(req: Request) {
  const parsed = Proposal.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ ok: false, message: "Invalid proposal" }, { status: 400 });
  const p = parsed.data;
  try {
    const message = await withTransaction("copilot", async (c) => {
      if (p.kind === "create_task") {
        const r = await c.query(
          `insert into tasks (title, description, owner_id, due_date, priority, campaign_id, initiative_id, source, evidence)
           values ($1, $2, $3, $4, $5, $6, $7, 'copilot', $8) returning task_id`,
          [p.title, p.description, p.owner_id, p.due_date, p.priority, p.campaign_id, p.initiative_id,
            JSON.stringify({ as_of: p.as_of, evidence: p.evidence })]);
        return `Task #${r.rows[0].task_id} created: ${p.title}`;
      }
      if (p.kind === "update_task") {
        const r = await c.query(
          `update tasks set status = coalesce($2, status),
              owner_id = case when $3::boolean then $4 else owner_id end,
              due_date = case when $5::boolean then $6::date else due_date end,
              priority = coalesce($7, priority), updated_at = now()
           where task_id = $1`,
          [p.task_id, p.status ?? null, p.owner_id !== undefined, p.owner_id ?? null, p.due_date !== undefined, p.due_date ?? null, p.priority ?? null]);
        if (r.rowCount === 0) throw new Error(`Task #${p.task_id} no longer exists`);
        return `Task #${p.task_id} updated`;
      }
      const r = await c.query(
        `update campaigns set status = coalesce($2, status),
            planned_budget_inr = case when $3::boolean then $4 else planned_budget_inr end
         where campaign_id = $1`,
        [p.campaign_id, p.status ?? null, p.planned_budget_inr !== undefined, p.planned_budget_inr ?? null]);
      if (r.rowCount === 0) throw new Error(`Campaign ${p.campaign_id} not found`);
      return `${p.campaign_name} updated`;
    });
    return Response.json({ ok: true, message });
  } catch (e) {
    return Response.json({ ok: false, message: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
