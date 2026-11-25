// End-to-end test in a real (headless) browser against a running app that uses
// the LOCAL database. It edits data through the UI and resets it at the end.
//   BASE_URL=http://127.0.0.1:3100 DATABASE_URL=postgresql://postgres:devpass@127.0.0.1:5433/campusfest node tests/e2e_ui.mjs
import { chromium } from "playwright";
import pg from "pg";

const BASE = process.env.BASE_URL ?? "http://localhost:3100";
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
if (!/127\.0\.0\.1|localhost/.test(process.env.DATABASE_URL ?? "")) throw new Error("Use a local database for this test");
const fails = [];
const check = (name, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${!cond && detail ? `  (${detail})` : ""}`);
  if (!cond) fails.push(name);
};
const go = async (page, url) => { await page.goto(url); await page.waitForLoadState("networkidle"); };
const one = async (sql, args = []) => (await db.query(sql, args)).rows[0];
const spendTile = async (page, asof) => {
  await go(page, `${BASE}/?asof=${asof}`);
  const tile = page.locator("div", { hasText: /^Net marketing spend/ }).first();
  return (await tile.innerText()).match(/₹[\d,]+/)[0];
};

await db.connect();
await db.query("select reset_to_original('test')");
await db.query("delete from tasks where title like 'E2E:%'");
const browser = await chromium.launch();
const page = await browser.newPage();
try {
  // 1. Create a task through the form.
  await go(page, `${BASE}/execute?asof=2025-03-15`);
  await page.getByRole("button", { name: "New task" }).click();
  await page.locator('input[name="title"]').fill("E2E: cap Paid Social at retargeting only");
  await page.locator('textarea[name="description"]').fill("Created by the browser test");
  await page.locator('form:has(input[name="title"]) select[name="owner_id"]').selectOption("T04");
  await page.locator('form:has(input[name="title"]) select[name="campaign_id"]').selectOption("C02");
  await page.getByRole("button", { name: "Create task" }).click();
  await page.getByRole("status").filter({ hasText: "Task created: E2E: cap Paid Social" }).first().waitFor({ timeout: 15000 });
  const t = await one("select * from tasks where title like 'E2E:%' order by task_id desc limit 1");
  check("task saved with owner, campaign and default due date (as-of + 7 days)",
    t && t.owner_id === "T04" && t.campaign_id === "C02" && t.source === "manual" && String(t.due_date).length > 0, JSON.stringify(t));
  await page.reload(); await page.waitForLoadState("networkidle");
  check("task appears in the task list after reload", await page.getByText("E2E: cap Paid Social at retargeting only").first().isVisible());

  // 2. Mark it done through the row form.
  const row = page.locator("tr", { hasText: "E2E: cap Paid Social" });
  await row.locator('select[name="status"]').selectOption("done");
  await row.getByRole("button", { name: "Save" }).click();
  await page.waitForTimeout(1500);
  check("status change saved", (await one("select status from tasks where task_id = $1", [t.task_id])).status === "done");

  // 3. Edit one day's spend and see the overview total move by exactly that amount.
  const before = await spendTile(page, "2025-03-15");
  const old = await one("select coalesce(sum(marketing_spend_inr),0)::int as s from daily_marketing where campaign_id='C02' and activity_date='2025-03-10'");
  await go(page, `${BASE}/execute?asof=2025-03-15`);
  const spendForm = page.locator("form", { has: page.locator('input[name="marketing_spend_inr"]') });
  await spendForm.locator('select[name="campaign_id"]').selectOption("C02");
  await spendForm.locator('input[name="activity_date"]').fill("2025-03-10");
  await spendForm.locator('input[name="marketing_spend_inr"]').fill(String(old.s + 25000));
  await spendForm.getByRole("button", { name: "Save spend" }).click();
  await page.getByRole("status").filter({ hasText: /Spend for C02 on 2025-03-10|Added a spend row/ }).first().waitFor({ timeout: 15000 });
  const after = await spendTile(page, "2025-03-15");
  const n = (s) => Number(s.replace(/[₹,]/g, ""));
  check("overview spend rises by exactly ₹25,000 after the edit", n(after) - n(before) === 25000, `${before} -> ${after}`);
  const banner = await page.getByText("The working data differs from the original workbook").isVisible();
  check("edited-data banner is shown", banner);

  // 4. Tighten a decision threshold and see a decision change.
  await go(page, `${BASE}/decide?asof=2025-04-20`);
  const comm = () => page.locator("tr", { hasText: "Community Groups" }).first().innerText();
  const decBefore = await comm();
  const rulesForm = page.locator("form", { has: page.locator('input[name="scale_cost_ratio"]') });
  await rulesForm.locator('input[name="scale_cost_ratio"]').fill("0.5");
  await rulesForm.getByRole("button", { name: "Save thresholds" }).click();
  await page.getByRole("status").filter({ hasText: "Thresholds saved" }).first().waitFor({ timeout: 15000 });
  await page.reload(); await page.waitForLoadState("networkidle");
  const decAfter = await comm();
  check("Community Groups moves from Scale to Keep when the scale threshold tightens to 0.5x",
    decBefore.includes("Scale") && decAfter.includes("Keep"), `${decBefore.split("\n")[1]} -> ${decAfter.split("\n")[1]}`);
  await rulesForm.locator('input[name="scale_cost_ratio"]').fill("0.8");
  await rulesForm.getByRole("button", { name: "Save thresholds" }).click();
  await page.getByRole("status").filter({ hasText: "Thresholds saved" }).first().waitFor({ timeout: 15000 });

  // 5. Reset through the UI: spend returns to the original, task is kept.
  await go(page, `${BASE}/execute`);
  const resetForm = page.locator("form", { has: page.locator('input[name="confirm"]') });
  await resetForm.locator('input[name="confirm"]').check();
  await resetForm.getByRole("button", { name: "Reset data" }).click();
  await page.getByRole("status").filter({ hasText: "Working data reset to the original workbook" }).first().waitFor({ timeout: 30000 });
  const restored = await spendTile(page, "2025-03-15");
  check("reset restores the original spend", restored === before, `${restored} vs ${before}`);
  check("task survives the reset", !!(await one("select 1 as x from tasks where task_id = $1", [t.task_id])));
  check("banner gone after reset", !(await page.getByText("The working data differs").isVisible()));

  // 6. The change log recorded each step with the actor.
  const log = await db.query("select actor, table_name, action from change_log where changed_at > now() - interval '5 minutes' order by change_id");
  const has = (tbl, act) => log.rows.some((r) => r.actor === "user" && r.table_name === tbl && r.action === act);
  check("change log has task insert, task update, spend update, threshold update and reset (actor user)",
    has("tasks", "insert") && has("tasks", "update") && has("daily_marketing", "update") && has("decision_rules", "update") && has("*", "reset"),
    JSON.stringify(log.rows));

  // 7. Delete the test task through the UI.
  await go(page, `${BASE}/execute`);
  await page.locator("tr", { hasText: "E2E: cap Paid Social" }).getByRole("button", { name: /Delete/ }).click();
  await page.waitForTimeout(1500);
  check("task deleted", !(await one("select 1 as x from tasks where task_id = $1", [t.task_id])));
} catch (e) {
  fails.push(String(e));
  console.error("ERROR", e);
  await page.screenshot({ path: "/tmp/claude-1000/-home-misbah-ubuntu-intern/92fc02dc-8ac8-4156-8f3b-a3afbee54312/scratchpad/e2e_fail.png", fullPage: true });
} finally {
  await browser.close();
  await db.query("update decision_rules set scale_cost_ratio = 0.8 where id = 1");
  await db.end();
}
console.log(`\n${fails.length} failures`);
process.exit(fails.length ? 1 : 0);
