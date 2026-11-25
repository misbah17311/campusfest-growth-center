import "server-only";
import { query } from "./db";

// Typed wrappers around db/analytics.sql (shared by dashboard and copilot).

export type DailyRow = {
  day: string;
  identified: number;
  registered: number;
  confirmed: number;
  visitors: number;
  spend_inr: number;
  registrations_on_day: number;
};

export type WeeklyRow = {
  campaign_id: string;
  week_start: string;
  spend_inr: number;
  impressions: number;
  clicks: number;
  landing_sessions: number;
  form_start_events: number;
  identified: number;
  registrations: number;
};

export type LeakRow = { sort_order: number; stage: string; leak: string; people: number | null; note: string };

export type CampaignLeakRow = {
  campaign_id: string;
  abandoned_form: number;
  never_started: number;
  interested: number;
  waitlisted: number;
  cancelled: number;
  gate_lost: number | null;
  did_not_come: number | null;
};

export type LeadTimeRow = { bucket: string; sort_order: number; confirmed: number; came: number; show_up_rate: number | null };
export type QualityRow = { item: string; value: number; note: string };

export type Projection = {
  event_phase: "before" | "during" | "after";
  days_to_event: number;
  registered_now: number;
  registered_14d_ago: number;
  run_rate_per_day: number;
  projected_registrations: number | null;
  registration_goal: number | null;
  required_rate_per_day: number | null;
  visitors_per_registration: number | null;
  ratio_basis: string;
  projected_visitors: number | null;
  visitors_goal: number | null;
};

export type Decision = {
  campaign_id: string;
  campaign_name: string;
  decision: "scale" | "keep" | "change" | "stop" | "insufficient data";
  basis: string;
  cost_metric: number | null;
  blended_cost: number | null;
  cost_ratio: number | null;
  reasons: string[];
};

export type DecisionRules = {
  min_registrations: number;
  scale_cost_ratio: number;
  stop_cost_ratio: number;
  min_confirm_rate: number;
  min_form_completion: number;
  max_optout_rate: number;
  min_show_up: number;
  max_gate_loss: number;
  maturity_days: number;
  updated_at: Date;
};

export const getDailySeries = (asOf: string) =>
  query<DailyRow>("select * from daily_series_asof($1::date)", [asOf]);
export const getWeekly = (asOf: string) =>
  query<WeeklyRow>("select * from weekly_campaign_asof($1::date)", [asOf]);
export const getLeaks = (asOf: string) => query<LeakRow>("select * from funnel_leaks_asof($1::date)", [asOf]);
export const getCampaignLeaks = (asOf: string) =>
  query<CampaignLeakRow>("select * from campaign_leaks_asof($1::date)", [asOf]);
export const getLeadTime = (asOf: string) =>
  query<LeadTimeRow>("select * from showup_by_lead_time_asof($1::date)", [asOf]);
export const getQuality = (asOf: string) => query<QualityRow>("select * from data_quality_asof($1::date)", [asOf]);
export const getProjection = async (asOf: string) =>
  (await query<Projection>("select * from projection_asof($1::date)", [asOf]))[0];
export const getDecisions = (asOf: string) =>
  query<Decision>("select * from campaign_decisions_asof($1::date)", [asOf]);
export const getRules = async () => (await query<DecisionRules>("select * from decision_rules where id = 1"))[0];
