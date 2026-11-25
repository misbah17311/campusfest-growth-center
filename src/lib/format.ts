const inr = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 });
const int = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });

export const fmtInr = (v: number | null | undefined) => (v == null ? "—" : inr.format(v));
export const fmtInt = (v: number | null | undefined) => (v == null ? "—" : int.format(v));
export const fmtPct = (v: number | null | undefined, digits = 1) =>
  v == null || !Number.isFinite(v) ? "—" : `${(v * 100).toFixed(digits)}%`;

// Share of a goal, or null when there is no goal to compare against.
export const ofGoal = (actual: number | null | undefined, goal: number | null | undefined) =>
  actual == null || !goal ? null : actual / goal;

const longDate = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });
export const fmtDate = (iso: string) => longDate.format(new Date(`${iso}T12:00:00+05:30`));
