"""Verified baseline for CampusFest 2025 (attendee dataset).

Every rule below comes from the dataset's own "Read me" tab:
  * exact repeats of activity_id / history_id / event_id are import retries -> count once
  * registration status = latest history version at or before the selected end of day
  * a real attendee = person_type 'external' + check-in 'admitted' + 'verified',
    counted as distinct person_id (one person can be admitted several times)
  * impressions / clicks / reach / sessions / starts are anonymous event counts, not people
  * spend is net (negative rows are vendor credits)

Usage: python3 -I analysis/baseline.py "data/original/Attendee Dataset.xlsx" [YYYY-MM-DD]
"""
import sys
import pandas as pd

pd.set_option("display.width", 260)
pd.set_option("display.max_columns", 40)

path = sys.argv[1]
asof = pd.Timestamp(sys.argv[2]) if len(sys.argv) > 2 else pd.Timestamp("2025-04-20")
cut = asof.normalize() + pd.Timedelta(days=1)  # end of the selected day


def section(t):
    print("\n" + "=" * 8 + " " + t)


X = pd.ExcelFile(path)
raw = {s: X.parse(s) for s in X.sheet_names}
targets = raw["Targets"]
camps = raw["Campaigns"]
people = raw["People"]
daily_raw, hist_raw, chk_raw = raw["Daily Marketing"], raw["Registration History"], raw["Check-ins"]
inter, regs = raw["Interest and Engagement"], raw["Registrations"]

section("1. Import-retry duplicates removed")
daily = daily_raw.drop_duplicates("activity_id")
hist = hist_raw.drop_duplicates("history_id")
chk = chk_raw.drop_duplicates("event_id")
for name, a, b, key in [("Daily Marketing", daily_raw, daily, "activity_id"),
                        ("Registration History", hist_raw, hist, "history_id"),
                        ("Check-ins", chk_raw, chk, "event_id")]:
    # confirm the repeated IDs really are identical rows, not conflicting versions
    conflicting = a.drop_duplicates().duplicated(key).sum()
    print(f"{name}: {len(a)} rows -> {len(b)} ({len(a)-len(b)} repeats, {conflicting} conflicting)")
print("Interactions dup ids:", inter.interaction_id.duplicated().sum(),
      "| Registrations dup ids:", regs.registration_id.duplicated().sum(),
      "| People dup ids:", people.person_id.duplicated().sum())

# as-of filter
daily = daily[daily.activity_date < cut]
hist = hist[hist.effective_at < cut]
chk = chk[chk.occurred_at < cut]
inter = inter[inter.occurred_at < cut]
regs = regs[regs.registered_at < cut]
people_asof = people[people.first_seen_at < cut]
tgt = targets[targets.effective_at < cut].sort_values("effective_at").iloc[-1]

ext_ids = set(people.loc[people.person_type == "external", "person_id"])
ptype = people.set_index("person_id").person_type

section(f"2. Funnel as of end of {asof.date()}  (targets in force: {tgt.target_version})")
ext_people = people_asof[people_asof.person_type == "external"]
regs_ext = regs[regs.person_id.isin(ext_ids)]
latest = hist.sort_values(["effective_at", "history_id"]).groupby("registration_id").tail(1)
latest_ext = latest[latest.person_id.isin(ext_ids)]
ok = chk[(chk.result == "admitted") & (chk.verification == "verified")]
ok_ext = ok[ok.person_id.isin(ext_ids)]
visitors = set(ok_ext.person_id)
confirmed = set(latest_ext.loc[latest_ext.status == "confirmed", "person_id"])
spend = daily.marketing_spend_inr.sum()

print("Anonymous events (NOT people): impressions", daily.impressions.sum(), "| clicks", daily.clicks.sum(),
      "| landing sessions", daily.landing_page_sessions.sum(), "| form starts", daily.registration_starts.sum())
rows = [
    ("Identified external people", len(ext_people), tgt.identified_external_people_goal),
    ("External registrations", len(regs_ext), tgt.registration_goal),
    ("  latest status confirmed", len(confirmed), None),
    ("Verified external visitors", len(visitors), tgt.unique_external_visitors_goal),
    ("Net marketing spend (INR)", spend, tgt.marketing_budget_inr),
]
for label, actual, goal in rows:
    g = f"goal {goal:,.0f}  ({actual/goal:.1%})" if goal else ""
    print(f"  {label:32s} {actual:>10,.0f}   {g}")
print("  latest status, external:", latest_ext.status.value_counts().to_dict())
print("  people by type x first touch:\n", pd.crosstab(people_asof.person_type, people_asof.first_touch_source).to_string())
reg_vis = visitors & set(regs_ext.person_id)
print(f"  visitors with a registration: {len(reg_vis)} | walk-ins (no registration): {len(visitors - set(regs_ext.person_id))}")
if confirmed:
    print(f"  show-up rate of confirmed: {len(confirmed & visitors)}/{len(confirmed)} = {len(confirmed & visitors)/len(confirmed):.1%}")
print("  visitors whose latest status is NOT confirmed:", len(reg_vis - confirmed))
if visitors:
    print(f"  spend per verified visitor: INR {spend/len(visitors):.0f} | per registration: INR {spend/max(len(regs_ext),1):.0f}")

section("3. Records that must NOT be counted as attendees")
print("check-in result x verification:\n", pd.crosstab(chk.result, chk.verification).to_string())
print("admitted+verified rows by person type:", ok.person_id.map(ptype).value_counts().to_dict())
print("distinct admitted+verified persons by type:", ok.drop_duplicates("person_id").person_id.map(ptype).value_counts().to_dict())
bad = chk[~((chk.result == "admitted") & (chk.verification == "verified"))]
only_bad = set(bad.person_id) - set(ok.person_id)
print(f"people with only denied/pending/unverified records (never a verified admission): {len(only_bad)}")
print("  their types:", pd.Series(list(only_bad)).map(ptype).value_counts().to_dict() if only_bad else {})
print("  their latest registration status:", latest[latest.person_id.isin(only_bad)].status.value_counts().to_dict())
print("naive count (distinct person_id in raw check-ins):", chk_raw.person_id.nunique(), "-> correct:", len(visitors))
print("source of verified external admissions:", ok_ext.source.value_counts().to_dict(),
      "| persons seen only via manual:", len(set(ok_ext[ok_ext.source == "manual"].person_id) - set(ok_ext[ok_ext.source == "scanner"].person_id)))

section("4. Attendance by day and hour (verified external, distinct people)")
if len(ok_ext):
    d = ok_ext.assign(day=ok_ext.occurred_at.dt.date, hour=ok_ext.occurred_at.dt.hour)
    per_day = d.groupby("day").person_id.nunique()
    print("per day:", per_day.to_dict(), "| attended both days:", int((d.groupby("person_id").day.nunique() > 1).sum()))
    first = d.sort_values("occurred_at").drop_duplicates(["person_id", "day"])
    print("first admission per person per day, by hour:\n", pd.crosstab(first.hour, first.day).to_string())

section("5. Attribution consistency (can one person carry two campaigns?)")
m = regs.merge(people[["person_id", "first_campaign_id"]], on="person_id")
print("registrations whose campaign != person's first campaign:", int((m.campaign_id != m.first_campaign_id).sum()), "of", len(m))
c2 = chk.dropna(subset=["registration_id"]).merge(regs[["registration_id", "campaign_id"]], on="registration_id", suffixes=("", "_reg"))
print("check-ins whose campaign != registration's campaign:", int((c2.campaign_id != c2.campaign_id_reg).sum()), "of", len(c2))
i2 = inter.merge(people[["person_id", "first_campaign_id"]], on="person_id")
print("interactions whose campaign != person's first campaign:", int((i2.campaign_id != i2.first_campaign_id).sum()), "of", len(i2))

section("6. Per campaign (people-based stages use the recorded source campaign)")
g = daily.groupby("campaign_id").agg(impressions=("impressions", "sum"), clicks=("clicks", "sum"),
                                     sessions=("landing_page_sessions", "sum"), form_starts=("registration_starts", "sum"),
                                     spend=("marketing_spend_inr", "sum"))
g["identified"] = ext_people.groupby("first_campaign_id").size()
g["registered"] = regs_ext.groupby("campaign_id").size()
g["confirmed"] = latest_ext[latest_ext.status == "confirmed"].groupby("campaign_id").size()
g["cancelled"] = latest_ext[latest_ext.status == "cancelled"].groupby("campaign_id").size()
g["waitlisted"] = latest_ext[latest_ext.status == "waitlisted"].groupby("campaign_id").size()
g["visitors"] = regs_ext[regs_ext.person_id.isin(visitors)].groupby("campaign_id").size()
g = g.fillna(0).astype(int)
g.insert(0, "campaign", camps.set_index("campaign_id").campaign_name)
tot = g.drop(columns="campaign").sum(); tot["campaign"] = "TOTAL (campaign-attributed)"
g.loc["ALL"] = tot
r = pd.DataFrame({"campaign": g.campaign})
r["ctr"] = g.clicks / g.impressions
r["click>session"] = g.sessions / g.clicks
r["session>start"] = g.form_starts / g.sessions
r["identified>reg"] = g.registered / g.identified
r["reg>confirmed"] = g.confirmed / g.registered
r["confirmed>visit"] = g.visitors / g.confirmed
r["identified>visit"] = g.visitors / g.identified
r["spend_share"] = g.spend / g.loc["ALL", "spend"]
r["visitor_share"] = g.visitors / g.loc["ALL", "visitors"]
r["inr_per_reg"] = g.spend / g.registered
r["inr_per_visitor"] = g.spend / g.visitors
print(g.to_string())
print(r.round(3).to_string())

section("7. Does show-up depend on how early someone registered? (external, confirmed)")
ev = pd.Timestamp("2025-04-12")
t = regs_ext[regs_ext.person_id.isin(confirmed)].copy()
t["days_before"] = (ev - t.registered_at.dt.normalize()).dt.days
t["bucket"] = pd.cut(t.days_before, [-1, 7, 14, 28, 42, 56, 200], labels=["0-7d", "8-14d", "15-28d", "29-42d", "43-56d", "57d+"])
t["came"] = t.person_id.isin(visitors)
print(t.groupby("bucket", observed=True).came.agg(["size", "sum", "mean"]).round(3).to_string())
print("by campaign x bucket (show-up rate):\n", t.pivot_table(index="campaign_name", columns="bucket", values="came", aggfunc="mean", observed=True).round(2).to_string())

section("8. Engagement signals vs outcomes (observational, not causal)")
ev_by_person = inter.groupby("person_id").event_type.agg(set)
p = ext_people[ext_people.first_touch_source == "campaign"][["person_id", "first_campaign_name"]].copy()
p["registered"] = p.person_id.isin(set(regs_ext.person_id))
p["confirmed"] = p.person_id.isin(confirmed)
p["came"] = p.person_id.isin(visitors)
for e in ["brochure_download", "registration_start", "event_question_submitted", "nurture_email_sent",
          "nurture_email_opened", "nurture_email_clicked", "opted_out"]:
    has = p.person_id.map(lambda x: e in ev_by_person.get(x, set()))
    a, b = p[has], p[~has]
    print(f"  {e:26s} n={len(a):5d}  reg {a.registered.mean():.1%} vs {b.registered.mean():.1%} without"
          f" | came {a.came.mean():.1%} vs {b.came.mean():.1%}"
          f" | came-if-confirmed {a[a.confirmed].came.mean():.1%} vs {b[b.confirmed].came.mean():.1%}")
never = p[~p.registered]
print("identified but never registered:", len(never), "by campaign:", never.first_campaign_name.value_counts().to_dict())
print("  of them: started the form", int(never.person_id.map(lambda x: "registration_start" in ev_by_person.get(x, set())).sum()),
      "| downloaded brochure", int(never.person_id.map(lambda x: "brochure_download" in ev_by_person.get(x, set())).sum()),
      "| opted out", int(never.person_id.map(lambda x: "opted_out" in ev_by_person.get(x, set())).sum()))
# who received nurture email: before or after registering?
ne = inter[inter.event_type == "nurture_email_sent"].merge(regs[["person_id", "registered_at"]], on="person_id", how="left")
print("nurture emails sent:", len(ne), "| to never-registered:", int(ne.registered_at.isna().sum()),
      "| sent before registration:", int((ne.occurred_at < ne.registered_at).sum()),
      "| sent after registration:", int((ne.occurred_at >= ne.registered_at).sum()))
print("nurture emails by campaign:", inter[inter.event_type == "nurture_email_sent"].campaign_name.value_counts().to_dict())

section("9. Status journeys")
seq = hist.sort_values(["effective_at", "history_id"]).groupby("registration_id").status.agg(lambda s: " > ".join(s))
seq_ext = seq[seq.index.isin(set(regs_ext.registration_id))]
print(seq_ext.value_counts().to_string())
came_by_seq = pd.DataFrame({"seq": seq_ext, "came": seq_ext.index.map(regs.set_index("registration_id").person_id).isin(visitors)})
print("show-up by journey:\n", came_by_seq.groupby("seq").came.agg(["size", "mean"]).round(3).to_string())
wl = latest_ext[latest_ext.status == "waitlisted"]
print("waitlisted (latest) by campaign:", wl.campaign_name.value_counts().to_dict(), "| became waitlisted between", wl.effective_at.min(), "and", wl.effective_at.max())
cn = latest_ext[latest_ext.status == "cancelled"]
print("cancelled (latest) by campaign:", cn.campaign_name.value_counts().to_dict())

section("10. Weekly trajectory")
w_reg = regs_ext.groupby(regs_ext.registered_at.dt.to_period("W-SUN")).size().rename("registrations")
w_sp = daily.groupby(daily.activity_date.dt.to_period("W-SUN")).marketing_spend_inr.sum().rename("spend")
w_id = ext_people.groupby(ext_people.first_seen_at.dt.to_period("W-SUN")).size().rename("identified")
w = pd.concat([w_id, w_reg, w_sp], axis=1).fillna(0).astype(int)
w["cum_reg"] = w.registrations.cumsum(); w["cum_spend"] = w.spend.cumsum()
print(w.to_string())
print("monthly cost per registration by campaign (spend in month / registrations in month):")
ms = daily.groupby(["campaign_name", daily.activity_date.dt.to_period("M")]).marketing_spend_inr.sum().unstack(fill_value=0)
mr = regs_ext.groupby(["campaign_name", regs_ext.registered_at.dt.to_period("M")]).size().unstack(fill_value=0)
print("spend:\n", ms.to_string()); print("registrations:\n", mr.to_string())
print("negative spend rows (vendor credits):\n", daily[daily.marketing_spend_inr < 0][["campaign_name", "activity_date", "marketing_spend_inr", "platform"]].to_string(index=False))
print("days with spend>0 per campaign:", daily[daily.marketing_spend_inr > 0].groupby("campaign_name").size().to_dict())

section("11. Position against the plan that was in force on key dates")
for day in ["2025-02-15", "2025-03-14", "2025-03-15", "2025-04-01", "2025-04-11", "2025-04-13"]:
    c = pd.Timestamp(day) + pd.Timedelta(days=1)
    tg = targets[targets.effective_at < c].sort_values("effective_at").iloc[-1]
    n_id = ((people.person_type == "external") & (people.first_seen_at < c)).sum()
    n_reg = (regs_ext.registered_at < c).sum()
    lat = hist[hist.effective_at < c].sort_values(["effective_at", "history_id"]).groupby("registration_id").tail(1)
    n_conf = ((lat.status == "confirmed") & lat.person_id.isin(ext_ids)).sum()
    n_vis = ok_ext[ok_ext.occurred_at < c].person_id.nunique()
    sp = daily[daily.activity_date < c].marketing_spend_inr.sum()
    print(f"  {day}: identified {n_id}/{tg.identified_external_people_goal:.0f} | registered {n_reg}/{tg.registration_goal:.0f}"
          f" | confirmed {n_conf} | visitors {n_vis}/{tg.unique_external_visitors_goal:.0f} | spend {sp}/{tg.marketing_budget_inr:.0f}  [{tg.target_version}]")

section("12. Owners")
o = regs_ext.groupby("owner_name").size().rename("registered").to_frame()
o["visitors"] = regs_ext[regs_ext.person_id.isin(visitors)].groupby("owner_name").size()
o["spend"] = daily.groupby("owner_name").marketing_spend_inr.sum()
print(o.to_string())
