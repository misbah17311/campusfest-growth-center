import { Suspense } from "react";
import { resolveAsOf } from "@/lib/asof";
import { getCampaignList, getChanges, getImportReport, getInitiatives, getTargets, getTasks, getTeam } from "@/lib/execution";
import { fmtDate, fmtInr, fmtInt } from "@/lib/format";
import { Card, PageTitle, StatusDot, Td, Th } from "@/components/ui";
import { ActionForm, inputCls, labelCls } from "@/components/ActionForm";
import { Disclosure } from "@/components/Disclosure";
import {
  addTargetVersion, createTask, deleteTargetVersion, deleteTask, resetToOriginal, setDailySpend, updateCampaign, updateTask,
} from "@/app/actions";

export default function Page({ searchParams }: PageProps<"/execute">) {
  return (
    <Suspense fallback={<p className="text-sm text-ink-2">Loading…</p>}>
      <Execute searchParams={searchParams} />
    </Suspense>
  );
}

const STATUS_LABEL = { todo: "To do", in_progress: "In progress", blocked: "Blocked", done: "Done" } as const;

function addDays(iso: string, n: number) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

async function Execute({ searchParams }: { searchParams: PageProps<"/execute">["searchParams"] }) {
  const { asof } = await searchParams;
  const { asOf, event } = await resolveAsOf(asof);
  const [tasks, team, campaigns, targets, changes, initiatives, imports] = await Promise.all([
    getTasks(), getTeam(), getCampaignList(), getTargets(), getChanges(), getInitiatives(), getImportReport(),
  ]);
  const open = tasks.filter((t) => t.status !== "done");

  return (
    <>
      <PageTitle title="Execute"
        intro={<>Tasks, owners and deadlines, plus the campaign data and plan the analytics run on. Every change here is
          saved, recorded in the change log, and immediately reflected on every other page. Deadlines are judged against
          the date you are viewing ({fmtDate(asOf)}).</>} />

      <Card title={`Tasks · ${open.length} open`} subtitle="Created here or by the copilot (after you confirm its proposal).">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="border-b border-line"><Th>Task</Th><Th>Linked to</Th><Th>Status · owner · due · priority</Th><Th /></tr></thead>
            <tbody>
              {tasks.length === 0 && <tr><Td className="text-ink-2">No tasks yet.</Td></tr>}
              {tasks.map((t) => {
                const overdue = t.status !== "done" && t.due_date != null && t.due_date < asOf;
                return (
                  <tr key={t.task_id} className="border-b border-line align-top">
                    <Td>
                      <div className="font-medium">{t.title}</div>
                      {t.description && <div className="mt-0.5 max-w-md text-xs text-ink-2">{t.description}</div>}
                      <div className="mt-1 flex flex-wrap gap-3">
                        {t.source === "copilot" && <StatusDot tone="muted">from copilot</StatusDot>}
                        {overdue && <StatusDot tone="critical">overdue (due {fmtDate(t.due_date!)})</StatusDot>}
                        {t.status === "done" && <StatusDot tone="good">done</StatusDot>}
                      </div>
                    </Td>
                    <Td className="text-xs text-ink-2">{t.campaign_name ?? "—"}{t.initiative_name ? ` · ${t.initiative_name}` : ""}</Td>
                    <Td>
                      <form action={updateTask} className="flex flex-wrap items-center gap-1.5">
                        <input type="hidden" name="task_id" value={t.task_id} />
                        <select name="status" defaultValue={t.status} className={`${inputCls} w-auto`} aria-label="Status">
                          {Object.entries(STATUS_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                        </select>
                        <select name="owner_id" defaultValue={t.owner_id ?? ""} className={`${inputCls} w-auto`} aria-label="Owner">
                          <option value="">Unassigned</option>
                          {team.map((m) => <option key={m.owner_id} value={m.owner_id}>{m.owner_name}</option>)}
                        </select>
                        <input type="date" name="due_date" defaultValue={t.due_date ?? ""} className={`${inputCls} w-auto`} aria-label="Due date" />
                        <select name="priority" defaultValue={t.priority} className={`${inputCls} w-auto`} aria-label="Priority">
                          <option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option>
                        </select>
                        <button className="rounded-md border border-line px-2 py-1 text-xs">Save</button>
                      </form>
                    </Td>
                    <Td>
                      <form action={deleteTask}><input type="hidden" name="task_id" value={t.task_id} />
                        <button className="text-xs text-ink-2 underline" aria-label={`Delete task ${t.title}`}>Delete</button></form>
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <Disclosure label="New task">
          <ActionForm action={createTask} submitLabel="Create task" className="mt-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <label className={`${labelCls} sm:col-span-3`}>Title<input name="title" required maxLength={200} className={inputCls} /></label>
              <label className={`${labelCls} sm:col-span-3`}>Description<textarea name="description" rows={2} className={inputCls} /></label>
              <label className={labelCls}>Owner<select name="owner_id" className={inputCls}><option value="">Unassigned</option>
                {team.map((m) => <option key={m.owner_id} value={m.owner_id}>{m.owner_name}</option>)}</select></label>
              <label className={labelCls}>Due date<input type="date" name="due_date" defaultValue={addDays(asOf, 7)} className={inputCls} /></label>
              <label className={labelCls}>Priority<select name="priority" defaultValue="medium" className={inputCls}>
                <option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option></select></label>
              <label className={labelCls}>Campaign<select name="campaign_id" className={inputCls}><option value="">None</option>
                {campaigns.map((c) => <option key={c.campaign_id} value={c.campaign_id}>{c.campaign_name}</option>)}</select></label>
              <label className={labelCls}>Strategic bet<select name="initiative_id" className={inputCls}><option value="">None</option>
                {initiatives.map((i) => <option key={i.initiative_id} value={i.initiative_id}>{i.name}</option>)}</select></label>
            </div>
          </ActionForm>
        </Disclosure>
      </Card>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card title="Campaigns" subtitle="Status, owner and planned budget (status and planned budget are our additions to the source data).">
          <div className="space-y-3">
            {campaigns.map((c) => (
              <ActionForm key={c.campaign_id} action={updateCampaign} submitLabel="Save" className="border-b border-line pb-3">
                <input type="hidden" name="campaign_id" value={c.campaign_id} />
                <div className="text-sm font-medium">{c.campaign_name} <span className="text-xs text-muted">{c.campaign_id} · {c.channel}</span></div>
                <div className="mt-2 grid grid-cols-3 gap-2">
                  <label className={labelCls}>Status<select name="status" defaultValue={c.status} className={inputCls}>
                    <option value="active">Active</option><option value="paused">Paused</option><option value="stopped">Stopped</option></select></label>
                  <label className={labelCls}>Owner<select name="owner_id" defaultValue={c.owner_id ?? ""} className={inputCls}>
                    <option value="">Unassigned</option>{team.map((m) => <option key={m.owner_id} value={m.owner_id}>{m.owner_name}</option>)}</select></label>
                  <label className={labelCls}>Planned budget (₹)<input name="planned_budget_inr" inputMode="numeric"
                    defaultValue={c.planned_budget_inr ?? ""} className={inputCls} /></label>
                </div>
              </ActionForm>
            ))}
          </div>
        </Card>

        <div className="space-y-4">
          <Card title="Plan versions (targets and constraints)"
                subtitle="The version in force on a date is the latest one starting on or before it. Add a version rather than overwrite history.">
            <table className="w-full text-xs">
              <thead><tr className="border-b border-line"><Th>From</Th><Th>Version</Th><Th right>Identified</Th><Th right>Registered</Th>
                <Th right>Visitors</Th><Th right>Budget</Th><Th right>Capacity/day</Th><Th /></tr></thead>
              <tbody>
                {targets.map((t) => (
                  <tr key={t.version_id} className="border-b border-line">
                    <Td>{fmtDate(t.effective_date)}</Td><Td>{t.target_version}</Td>
                    <Td right>{fmtInt(t.identified_external_people_goal)}</Td><Td right>{fmtInt(t.registration_goal)}</Td>
                    <Td right>{fmtInt(t.unique_external_visitors_goal)}</Td><Td right>{fmtInr(t.marketing_budget_inr)}</Td>
                    <Td right>{fmtInt(t.venue_capacity_per_day)}</Td>
                    <Td><form action={deleteTargetVersion}><input type="hidden" name="version_id" value={t.version_id} />
                      <button className="text-ink-2 underline">Delete</button></form></Td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Disclosure label="Add a plan version">
              <ActionForm action={addTargetVersion} submitLabel="Add version" className="mt-3">
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  <label className={labelCls}>Effective from<input type="date" name="effective_date" required defaultValue={asOf} className={inputCls} /></label>
                  <label className={`${labelCls} sm:col-span-2`}>Name<input name="target_version" required defaultValue="Revised plan" className={inputCls} /></label>
                  <label className={labelCls}>Identified goal<input name="identified_external_people_goal" required inputMode="numeric" defaultValue={targets.at(-1)?.identified_external_people_goal} className={inputCls} /></label>
                  <label className={labelCls}>Registration goal<input name="registration_goal" required inputMode="numeric" defaultValue={targets.at(-1)?.registration_goal} className={inputCls} /></label>
                  <label className={labelCls}>Visitor goal<input name="unique_external_visitors_goal" required inputMode="numeric" defaultValue={targets.at(-1)?.unique_external_visitors_goal} className={inputCls} /></label>
                  <label className={labelCls}>Budget (₹)<input name="marketing_budget_inr" required inputMode="numeric" defaultValue={targets.at(-1)?.marketing_budget_inr} className={inputCls} /></label>
                  <label className={labelCls}>Venue capacity / day<input name="venue_capacity_per_day" inputMode="numeric" className={inputCls} /></label>
                </div>
              </ActionForm>
            </Disclosure>
          </Card>

          <Card title="Correct or add daily spend" subtitle="Updates the campaign's ledger row for that day, or adds one. Negative values are vendor credits.">
            <ActionForm action={setDailySpend} submitLabel="Save spend">
              <div className="grid grid-cols-3 gap-2">
                <label className={labelCls}>Campaign<select name="campaign_id" className={inputCls}>
                  {campaigns.map((c) => <option key={c.campaign_id} value={c.campaign_id}>{c.campaign_name}</option>)}</select></label>
                <label className={labelCls}>Day<input type="date" name="activity_date" required defaultValue={asOf}
                  min={event.history_start} max={event.history_end} className={inputCls} /></label>
                <label className={labelCls}>Net spend (₹)<input name="marketing_spend_inr" required inputMode="numeric" className={inputCls} /></label>
              </div>
            </ActionForm>
          </Card>

          <Card title="Reset to the original data"
                subtitle="Restores every source table to the original workbook. Tasks, bets, thresholds and assumptions are kept.">
            <ActionForm action={resetToOriginal} submitLabel="Reset data">
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="confirm" value="yes" />
                I understand this discards all edits to campaign, people, registration, check-in and spend data.</label>
            </ActionForm>
          </Card>
        </div>
      </div>

      <Card className="mt-4" title="Change log" subtitle="Every insert, update and delete, with who made it (user or copilot) and the before and after values.">
        <div id="changes" className="max-h-96 overflow-auto">
          <table className="w-full text-xs">
            <thead><tr className="border-b border-line"><Th>When (IST)</Th><Th>Who</Th><Th>What</Th><Th>Change</Th></tr></thead>
            <tbody>
              {changes.length === 0 && <tr><Td className="text-ink-2">No changes yet.</Td></tr>}
              {changes.map((c) => (
                <tr key={c.change_id} className="border-b border-line align-top">
                  <Td className="whitespace-nowrap">{c.changed_at.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" })}</Td>
                  <Td>{c.actor}</Td>
                  <Td>{c.action} {c.table_name}{c.row_id ? ` ${c.row_id}` : ""}</Td>
                  <Td className="text-ink-2">{c.note ?? describeChange(c.before, c.after)}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card className="mt-4" title="Last data import" subtitle="Rows read, import-retry duplicates removed, conflicting IDs, rows loaded.">
        <table className="w-full text-xs">
          <thead><tr className="border-b border-line"><Th>Sheet</Th><Th right>Read</Th><Th right>Duplicates removed</Th><Th right>Conflicting IDs</Th><Th right>Loaded</Th></tr></thead>
          <tbody>{imports.map((r) => (
            <tr key={r.sheet} className="border-b border-line"><Td>{r.sheet}</Td><Td right>{fmtInt(r.rows_read)}</Td>
              <Td right>{fmtInt(r.duplicate_rows_removed)}</Td><Td right>{fmtInt(r.conflicting_ids)}</Td><Td right>{fmtInt(r.rows_loaded)}</Td></tr>
          ))}</tbody>
        </table>
      </Card>
    </>
  );
}

function describeChange(before: Record<string, unknown> | null, after: Record<string, unknown> | null) {
  if (before && after) {
    const diffs = Object.keys(after).filter((k) => k !== "updated_at" && JSON.stringify(before[k]) !== JSON.stringify(after[k]));
    return diffs.map((k) => `${k}: ${fmt(before[k])} → ${fmt(after[k])}`).join("; ") || "no visible change";
  }
  const row = after ?? before ?? {};
  const name = row["title"] ?? row["campaign_name"] ?? row["target_version"] ?? row["activity_id"] ?? "";
  return String(name);
}
const fmt = (v: unknown) => (v == null ? "∅" : typeof v === "object" ? JSON.stringify(v) : String(v));
