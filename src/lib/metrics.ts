import "server-only";
import { query } from "./db";

// Typed wrappers around the SQL metric functions in db/metrics.sql. The
// dashboard and the copilot both read through these, so they always agree.

export type Funnel = {
  as_of: string;
  event_phase: "before" | "during" | "after";
  target_version: string | null;
  identified_external: number;
  identified_goal: number | null;
  registered_people: number;
  registration_goal: number | null;
  status_interested: number;
  status_confirmed: number;
  status_waitlisted: number;
  status_cancelled: number;
  status_unknown: number;
  visitors: number;
  visitors_goal: number | null;
  visitors_registered: number;
  visitors_walk_in: number;
  confirmed_who_attended: number;
  show_up_rate: number | null;
  spend_inr: number;
  budget_inr: number | null;
  impressions: number;
  clicks: number;
  landing_sessions: number;
  form_start_events: number;
};

export type CampaignMetrics = {
  campaign_id: string;
  campaign_name: string;
  channel: string;
  owner_id: string | null;
  owner_name: string | null;
  status: "active" | "paused" | "stopped";
  planned_budget_inr: number | null;
  spend_inr: number;
  impressions: number;
  clicks: number;
  reported_reach: number;
  landing_sessions: number;
  form_start_events: number;
  identified: number;
  form_starters: number;
  registered: number;
  confirmed: number;
  cancelled: number;
  waitlisted: number;
  interested: number;
  visitors: number;
  confirmed_who_attended: number;
  nurture_sent: number;
  nurture_opened: number;
  nurture_clicked: number;
  opted_out: number;
  ctr: number | null;
  identified_to_registered: number | null;
  starter_to_registered: number | null;
  registered_to_confirmed: number | null;
  show_up_rate: number | null;
  cost_per_registration: number | null;
  cost_per_visitor: number | null;
};

export async function getFunnel(asOf: string): Promise<Funnel> {
  const rows = await query<Funnel>("select * from funnel_asof($1::date)", [asOf]);
  return rows[0];
}

export async function getCampaignMetrics(asOf: string): Promise<CampaignMetrics[]> {
  return query<CampaignMetrics>("select * from campaign_metrics_asof($1::date)", [asOf]);
}

export async function dataDiffersFromOriginal(): Promise<boolean> {
  const rows = await query<{ d: boolean }>("select data_differs_from_original() as d");
  return rows[0].d;
}
