import "server-only";
import { query } from "./db";

export type EventInfo = {
  event_name: string;
  history_start: string; // YYYY-MM-DD
  history_end: string;
  event_starts_at: Date;
  event_ends_at: Date;
};

export async function getEvent(): Promise<EventInfo> {
  const rows = await query<EventInfo>(
    "select event_name, history_start, history_end, event_starts_at, event_ends_at from event limit 1",
  );
  if (!rows[0]) throw new Error("No event row: has the database been loaded?");
  return rows[0];
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// The "as of" date comes from the URL (?asof=YYYY-MM-DD). It defaults to the
// last covered day and is clamped to the covered range, so a typo can never
// produce a date outside the data.
export async function resolveAsOf(raw: string | string[] | undefined): Promise<{ asOf: string; event: EventInfo }> {
  const event = await getEvent();
  const value = Array.isArray(raw) ? raw[0] : raw;
  let asOf = value && ISO_DATE.test(value) && !Number.isNaN(Date.parse(value)) ? value : event.history_end;
  if (asOf < event.history_start) asOf = event.history_start;
  if (asOf > event.history_end) asOf = event.history_end;
  return { asOf, event };
}
