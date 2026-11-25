// Runs the copilot evaluation set against a running app and records every
// answer with the tools it used, for grading.
//
//   BASE_URL=http://localhost:3100 node tests/eval_copilot.mjs [questions.json] [--model accounts/fireworks/models/...] [--only id1,id2]
//
// Each item: { id, category, question, as_of, follow_up_turns[] }. Multi-turn
// items send the follow-ups in the same conversation. Results are written to
// tests/results/eval_<model>_<timestamp>.json; grading is done separately
// (tests/grade_copilot.py) against expected values computed independently.
import fs from "node:fs";
import path from "node:path";
import pg from "pg";

// Changed-data scenarios: applied to the LOCAL database before the item, reset after.
const EDITS = {
  CD01: [`update daily_marketing set marketing_spend_inr = marketing_spend_inr + 25000 where campaign_id = 'C02' and activity_date = '2025-03-20'`],
  CD02: [`insert into targets (effective_at, identified_external_people_goal, registration_goal, unique_external_visitors_goal, marketing_budget_inr, target_version)
          values ('2025-04-01 09:00+05:30', 4000, 3500, 2600, 330000, 'Attendee stretch plan')`],
  CD03: [`insert into registration_history (history_id, registration_id, person_id, campaign_id, owner_id, effective_at, status)
          select 'EVAL-CD03', registration_id, person_id, campaign_id, owner_id, '2025-04-05 10:00+05:30', 'cancelled' from registrations where registration_id = 'R0001'`],
  CD04: [`update campaigns set status = 'paused' where campaign_id = 'C02'`],
};
const db = process.env.DATABASE_URL ? new pg.Client({ connectionString: process.env.DATABASE_URL }) : null;
if (db) {
  if (!/127\.0\.0\.1|localhost/.test(process.env.DATABASE_URL)) throw new Error("Edits are only applied to a local database");
  await db.connect();
}

const args = process.argv.slice(2);
const file = args.find((a) => a.endsWith(".json")) ?? "tests/copilot_questions.json";
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : "");
const only = flag("--only").split(",").filter(Boolean);
const skip = flag("--skip").split(",").filter(Boolean);
const MODEL = flag("--model") || undefined;
const BASE = process.env.BASE_URL ?? "http://localhost:3100";
const items = JSON.parse(fs.readFileSync(file, "utf8")).filter((q) => (!only.length || only.includes(q.id)) && !skip.includes(q.id));

async function ask(message, history, asOf) {
  const t0 = Date.now();
  const res = await fetch(`${BASE}/api/chat`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, history, asOf, page: "/", model: MODEL }),
  });
  if (!res.ok) return { error: `HTTP ${res.status}: ${await res.text()}`, ms: Date.now() - t0 };
  const text = await res.text();
  const events = text.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const answer = events.find((e) => e.type === "answer");
  const err = events.find((e) => e.type === "error");
  return { answer: answer?.text ?? null, error: err?.message ?? null, tools: events.filter((e) => e.type === "tool").map((e) => e.summary),
    proposals: answer?.proposals ?? [], model: answer?.model, usage: answer?.usage, ms: Date.now() - t0 };
}

const results = [];
let model = "unknown";
for (const q of items) {
  if (EDITS[q.id]) {
    if (!db) { console.log(`${q.id} skipped: set DATABASE_URL (local) to apply its data edit`); continue; }
    await db.query("select reset_to_original('eval')");
    for (const sql of EDITS[q.id]) {
      const r = await db.query(sql);
      if (r.rowCount !== 1) throw new Error(`${q.id}: edit changed ${r.rowCount} rows`);
    }
  }
  const history = [];
  const turns = [q.question, ...(q.follow_up_turns ?? [])];
  const out = [];
  for (const turn of turns) {
    const r = await ask(turn, history, q.as_of ?? "2025-04-20");
    out.push({ question: turn, ...r });
    if (r.model) model = r.model;
    history.push({ role: "user", content: turn });
    if (r.answer) history.push({ role: "assistant", content: r.answer });
    process.stdout.write(`${q.id} ${r.error ? "ERROR " + r.error.slice(0, 80) : "ok"} (${(r.ms / 1000).toFixed(1)}s, ${r.tools?.length ?? 0} tools)\n`);
  }
  results.push({ ...q, turns: out });
  if (EDITS[q.id]) await db.query("select reset_to_original('eval')");
}
if (db) await db.end();
const dir = "tests/results";
fs.mkdirSync(dir, { recursive: true });
const name = path.join(dir, `eval_${(MODEL ?? model).split("/").pop()}_${new Date().toISOString().replace(/[:.]/g, "-")}${only.length ? "_partial" : ""}.json`);
fs.writeFileSync(name, JSON.stringify(results, null, 2));
const tok = results.flatMap((r) => r.turns).reduce((a, t) => ({ p: a.p + (t.usage?.prompt ?? 0), c: a.c + (t.usage?.completion ?? 0) }), { p: 0, c: 0 });
console.log(`\nWrote ${name}\nTurns: ${results.flatMap((r) => r.turns).length}, errors: ${results.flatMap((r) => r.turns).filter((t) => t.error).length}, tokens: ${tok.p} prompt + ${tok.c} completion`);
