import "server-only";
import { query } from "./db";

export type Task = {
  task_id: number;
  title: string;
  description: string | null;
  owner_id: string | null;
  owner_name: string | null;
  due_date: string | null;
  status: "todo" | "in_progress" | "blocked" | "done";
  priority: "high" | "medium" | "low";
  campaign_id: string | null;
  campaign_name: string | null;
  initiative_id: number | null;
  initiative_name: string | null;
  source: "manual" | "copilot";
  evidence: Record<string, unknown> | null;
  created_at: Date;
};

export type TeamMember = { owner_id: string; owner_name: string };
export type CampaignRow = {
  campaign_id: string; campaign_name: string; channel: string; owner_id: string | null; status: string;
  planned_budget_inr: number | null;
};
export type TargetRow = {
  version_id: number; effective_at: Date; effective_date: string; target_version: string;
  identified_external_people_goal: number; registration_goal: number; unique_external_visitors_goal: number;
  marketing_budget_inr: number; venue_capacity_per_day: number | null;
};
export type ChangeRow = {
  change_id: number; changed_at: Date; actor: string; table_name: string; row_id: string | null; action: string;
  before: Record<string, unknown> | null; after: Record<string, unknown> | null; note: string | null;
};
export type Initiative = {
  initiative_id: number; rank: number | null; name: string; hypothesis: string | null; owner_id: string | null;
  owner_name: string | null; budget_inr: number | null; start_date: string | null; end_date: string | null;
  primary_kpi: string | null; scale_rule: string | null; change_rule: string | null; stop_rule: string | null;
  expected_visitors: number | null; status: string; campaign_ids: string[];
};

export const getTasks = () =>
  query<Task>(`select t.*, tm.owner_name, c.campaign_name, i.name as initiative_name
               from tasks t left join team tm using (owner_id) left join campaigns c using (campaign_id)
               left join initiatives i using (initiative_id)
               order by (t.status = 'done'), t.due_date nulls last, t.task_id`);
export const getTeam = () => query<TeamMember>("select owner_id, owner_name from team order by owner_name");
export const getCampaignList = () =>
  query<CampaignRow>("select campaign_id, campaign_name, channel, owner_id, status, planned_budget_inr from campaigns order by campaign_id");
export const getTargets = () =>
  query<TargetRow>(`select *, (effective_at at time zone 'Asia/Kolkata')::date::text as effective_date
                    from targets order by effective_at`);
export const getChanges = (limit = 50) =>
  query<ChangeRow>("select * from change_log order by change_id desc limit $1", [limit]);
export const getInitiatives = () =>
  query<Initiative>(`select i.*, tm.owner_name from initiatives i left join team tm using (owner_id)
                     order by i.rank nulls last, i.initiative_id`);
export const getImportReport = () =>
  query<{ sheet: string; rows_read: number; duplicate_rows_removed: number; conflicting_ids: number; rows_loaded: number;
          run_at: Date; source_file: string; target_schema: string }>(
    `select * from import_report where run_id = (select run_id from import_report order by run_at desc, report_id desc limit 1)
     order by report_id`);
