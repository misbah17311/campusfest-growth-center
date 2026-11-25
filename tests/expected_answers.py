"""Expected answers for the copilot evaluation, computed in pandas straight from
the workbook (independently of the app and of the copilot).

Writes tests/copilot_expected.json: for each item id, the key facts a correct
answer must contain ("must_include": numbers with a tolerance, or phrases), plus
notes for the human grader. Changed-data items (CD*) give baseline values and
the expected values after the documented edit.

  .venv/bin/python tests/expected_answers.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "analysis"))
import reference_metrics as ref  # noqa: E402

d = ref.load(ROOT / "data" / "original" / "Attendee Dataset.xlsx")
FINAL = "2025-04-20"
f = ref.funnel(d, FINAL)
cm = ref.campaign_metrics(d, FINAL)
names = d.campaigns.set_index("campaign_id").campaign_name.to_dict()
ext = d.external_ids
E = {}


def num(v, tol=0.0, label=""):
    return {"value": v, "tol": tol, "label": label}


# ---------------- factual
E["F01"] = {"must_include": [num(f["visitors"], 0, "verified unique external visitors")]}
E["F02"] = {"must_include": [num(f["spend_inr"], 0, "net spend"), num(f["budget_inr"], 0, "budget"),
                             num(f["budget_inr"] - f["spend_inr"], 0, "remaining")]}
E["F03"] = {"must_include": [num(f["registration_goal"], 0, "registration goal (revised plan)")]}
E["F04"] = {"must_include": [num(f["registered_people"], 0, "external people registered")],
            "notes": f"2,840 registration records include {len(d.registrations) - f['registered_people']} internal registrations"}
E["F05"] = {"must_include": [num(cm["C02"]["spend_inr"], 0, "Paid Social net spend")]}
c3 = d.campaigns.set_index("campaign_id").loc["C03"]
E["F06"] = {"must_include": ["Nisha Rao", "10 Feb", "13 Apr"],
            "notes": f"target_audience is a description ('{c3.target_audience}'), not a count; must say there is no audience size"}
ck = d.checkins
denied = ck[ck.result == "denied"]
vis_ids = set(ref.visitors(d, FINAL).person_id)
den_people = set(denied.person_id)
den_ext = den_people & ext
den_later_in = den_ext & vis_ids
E["F07"] = {"must_include": [num(len(den_ext), 0, "distinct external people with a denied check-in")],
            "notes": f"{len(denied)} denied rows after dedup; {len(den_people)} people of any type; of {len(den_ext)} external, "
                     f"{len(den_later_in)} later had a verified admission and {len(den_ext - vis_ids)} never did"}
reach_c06 = int(d.daily[d.daily.campaign_id == "C06"].reported_reach.sum())
E["F08"] = {"must_include": [num(reach_c06, 0, "summed daily reported reach (not unique people)")],
            "notes": "must say summed daily reach is not unique people"}
E["F09"] = {"must_include": [num(f["visitors_walk_in"], 0, "walk-ins")]}
credits = d.daily[d.daily.marketing_spend_inr < 0]
E["F10"] = {"must_include": [num(len(credits), 0, "credit rows"), num(int(-credits.marketing_spend_inr.sum()), 0, "total credits INR")]}
ok = ck[(ck.result == "admitted") & (ck.verification == "verified") & ck.person_id.isin(ext)]
both = int((ok.assign(day=ok.occurred_at.dt.date).groupby("person_id").day.nunique() > 1).sum())
E["F11"] = {"must_include": [num(both, 0, "visitors on both days")]}
E["F12"] = {"must_include": [num(f["status_confirmed"], 0, "confirmed"), num(f["status_waitlisted"], 0, "waitlisted"),
                             num(f["status_cancelled"], 0, "cancelled"), num(f["status_interested"], 0, "interested")]}

# ---------------- calculations
E["C01"] = {"must_include": [num(round(f["spend_inr"] / f["visitors"], 2), 1.0, "INR per verified visitor (all visitors)")],
            "notes": f"also acceptable if clearly defined: per campaign-attributed visitor INR {f['spend_inr'] / f['visitors_registered']:.2f}"}
E["C02"] = {"must_include": [num(round(100 * cm[c]["visitors"] / cm[c]["registered"], 1), 0.15, f"{names[c]} registration to visit %") for c in cm],
            "notes": "may also give confirmed-to-visit show-up; must state which"}
gap = f["visitors_goal"] - f["visitors"]
E["C03"] = {"must_include": [num(gap, 0, "visitors short of goal"), num(round(100 * gap / f["visitors_goal"], 2), 0.1, "% short")]}
cpr_c02 = cm["C02"]["spend_inr"] / cm["C02"]["registered"]
E["C04"] = {"must_include": [num(round(50000 / cpr_c02), 1, "extra registrations at constant cost per registration")],
            "notes": f"cost per registration INR {cpr_c02:.2f}; should flag that constant cost per registration is optimistic (diminishing returns)"}
E["C05"] = {"must_include": [num(cm["C02"]["clicks"], 0, "Paid Social clicks"), num(cm["C02"]["registered"], 0, "Paid Social registrations"),
                             num(round(100 * cm["C02"]["registered"] / cm["C02"]["clicks"], 1), 0.15, "registrations per click %")],
            "notes": "must say clicks are anonymous events, registrations are people, so the ratio mixes sources"}
cpc = {c: cm[c]["spend_inr"] / cm[c]["confirmed"] for c in ("C01", "C05")}
E["C06"] = {"must_include": [num(round(cpc["C01"], 2), 0.5, "Ambassadors INR per confirmed"), num(round(cpc["C05"], 2), 0.5, "Referrals INR per confirmed"),
                             num(round(cpc["C01"] - cpc["C05"], 2), 0.6, "difference")]}
st = ref.person_status(ref.registration_status(d, FINAL), ["person_id"])
wl = set(st.loc[st.status == "waitlisted", "person_id"])
wl_not_came = wl - vis_ids
extra = round(0.3 * len(wl_not_came))
E["C07"] = {"must_include": [num(len(wl), 0, "waitlisted people"), num(f["visitors"] + extra, 1, "hypothetical visitors"),
                             num(f["visitors_goal"] - (f["visitors"] + extra), 1, "still short")],
            "notes": f"{len(wl) - len(wl_not_came)} waitlisted people attended anyway; +{extra} -> {f['visitors'] + extra}, still below {f['visitors_goal']}"}
mar = d.daily[(d.daily.campaign_id == "C03") & (pd.to_datetime(d.daily.activity_date).dt.month == 3)]
E["C08"] = {"must_include": [num(int(mar.marketing_spend_inr.sum()), 0, "Creators March spend"),
                             num(round(mar.marketing_spend_inr.sum() / 31, 2), 1.0, "per calendar day")],
            "notes": f"spend was posted on {(mar.marketing_spend_inr != 0).sum()} days in March (per spend day INR {mar.marketing_spend_inr.sum() / max(1, (mar.marketing_spend_inr != 0).sum()):.0f}); either average is fine if defined"}

# ---------------- as of
fa = {day: ref.funnel(d, day) for day in ["2025-03-14", "2025-03-15", "2025-02-28", "2025-04-11", "2025-04-12", "2025-03-31", "2025-03-01"]}
E["A01"] = {"must_include": [num(fa["2025-03-14"]["visitors_goal"], 0, "visitor goal (launch plan)"), num(fa["2025-03-14"]["budget_inr"], 0, "budget (launch plan)")]}
E["A02"] = {"must_include": [num(fa["2025-03-15"]["budget_inr"], 0, "budget (revised plan from 15 Mar 09:00)")]}
E["A03"] = {"must_include": [num(fa["2025-02-28"]["status_confirmed"], 0, "confirmed at end of Feb")]}
E["A04"] = {"must_include": [num(0, 0, "visitors before the festival")], "notes": "must not leak 2,050 or day-1 numbers"}
E["A05"] = {"must_include": [num(fa["2025-04-12"]["visitors"], 0, "verified visitors on 12 Apr")]}
hist = d.history[d.history.registration_id == "R0001"].sort_values("effective_at")
lk = hist[hist.effective_at < ref.cutoff("2025-03-10")].iloc[-1].status
same_name = int((d.people.person_name == "Leena Kapoor").sum())
E["A06"] = {"must_include": [lk], "notes": f"R0001 history: {list(zip(hist.effective_at.dt.strftime('%d %b %H:%M'), hist.status))}; people named Leena Kapoor: {same_name}"}
c5 = ref.cutoff("2025-02-05")
live = d.campaigns[pd.to_datetime(d.campaigns.planned_start_at).dt.tz_localize(ref.IST) < c5]
sp = d.daily[d.daily.activity_date <= pd.Timestamp("2025-02-05").date()].groupby("campaign_id").marketing_spend_inr.sum()
E["A07"] = {"must_include": [names[c] for c in live.campaign_id],
            "notes": "planned start on or before 5 Feb: " + "; ".join(f"{names[c]} spent INR {int(sp.get(c, 0))}" for c in live.campaign_id)
                     + "; not started: " + ", ".join(names[c] for c in d.campaigns.campaign_id if c not in set(live.campaign_id))}
E["A08"] = {"must_include": [num(fa["2025-03-31"]["registered_people"], 0, "registered on 31 Mar"), num(fa["2025-03-31"]["registration_goal"], 0, "goal"),
                             num(12, 1, "days to the festival (12 Apr)")]}

# ---------------- multi-turn and others with numbers
E["M01"] = {"must_include": [num(cm["C01"]["visitors"], 0, "Ambassadors visitors"), num(cm["C02"]["visitors"], 0, "Paid Social visitors"),
                             num(round(cm["C01"]["cost_per_visitor"]), 1, "Ambassadors INR/visitor"), num(round(cm["C02"]["cost_per_visitor"]), 1, "Paid INR/visitor")]}
E["M02"] = {"must_include": [num(f["registration_goal"] - f["registered_people"], 0, "gap on 20 Apr"),
                             num(fa["2025-03-01"]["registration_goal"] - fa["2025-03-01"]["registered_people"], 0, "gap on 1 Mar (launch plan)")],
            "notes": f"1 Mar: {fa['2025-03-01']['registered_people']} of {fa['2025-03-01']['registration_goal']}; reason for the goal change is not recorded"}
noshow = {c: 1 - cm[c]["show_up_rate"] for c in cm}
worst = max(noshow, key=noshow.get)
E["M03"] = {"must_include": [names[worst], num(round(100 * noshow[worst], 1), 0.15, "no-show % of confirmed")],
            "notes": "; ".join(f"{names[c]} {100 * noshow[c]:.1f}%" for c in cm)}
E["M04"] = {"must_include": [num(cm["C03"]["spend_inr"], 0, "Creators spend")],
            "notes": f"halving at constant cost per registration -> {cm['C03']['registered'] / 2:.0f} fewer; with diminishing returns fewer than that; no creator-level data exists"}
f01 = ref.campaign_metrics(d, "2025-04-01")
top = sorted(f01, key=lambda c: -f01[c]["registered"])[:3]
own = d.campaigns.set_index("campaign_id").owner_id.to_dict()
E["M05"] = {"must_include": [names[c] for c in top],
            "notes": "top 3 on 1 Apr: " + ", ".join(f"{names[c]} {f01[c]['registered']}" for c in top) + f"; owner of 3rd: {own[top[2]]}"}
den_walk = {p for p in den_later_in if p not in set(d.registrations.person_id)}
E["M06"] = {"must_include": [num(len(den_ext), 0, "denied people"), num(len(den_later_in), 0, "later admitted"), num(len(den_walk), 0, "of whom walk-ins")]}

# ---------------- changed data
c02_0319 = int(d.daily[(d.daily.campaign_id == "C02") & (d.daily.activity_date <= pd.Timestamp("2025-03-19").date())].marketing_spend_inr.sum())
E["CD01"] = {"baseline": {"paid_spend": cm["C02"]["spend_inr"], "total_spend": f["spend_inr"]},
             "must_include": [num(cm["C02"]["spend_inr"] + 25000, 0, "Paid Social spend after edit"),
                              num(f["budget_inr"] - f["spend_inr"] - 25000, 0, "budget left after edit"),
                              num(c02_0319, 0, "Paid Social spend as of 19 Mar (unchanged)")]}
E["CD02"] = {"must_include": [num(2600, 0, "visitor goal in force on 20 Apr after edit"), num(2600 - f["visitors"], 0, "gap"),
                              num(2200, 0, "goal on 31 Mar"), num(30000, 0, "extra budget vs revised plan")]}
cf10 = ref.campaign_metrics(d, "2025-04-10")["C01"]
E["CD03"] = {"baseline": {"C01_confirmed_0410": cf10["confirmed"]},
             "must_include": [num(cf10["confirmed"] - 1, 0, "C01 confirmed as of 10 Apr after edit"), "confirmed"],
             "notes": "Leena Kapoor on 4 Apr: confirmed (edit only from 5 Apr 10:00)"}
f28 = ref.funnel(d, "2025-03-28")
E["CD04"] = {"must_include": [num(f28["budget_inr"] - f28["spend_inr"], 0, "budget remaining on 28 Mar")],
             "notes": "Paid Social must be shown as paused; status changes are not dated in the app, so 'since 25 Mar' cannot be verified from data"}

out = ROOT / "tests" / "copilot_expected.json"
out.write_text(json.dumps(E, indent=2, default=lambda o: o.item() if hasattr(o, "item") else str(o)))
print(f"Wrote {out} with {len(E)} items")
for k, v in E.items():
    print(k, [m["value"] if isinstance(m, dict) else m for m in v["must_include"]], "|", v.get("notes", "")[:150])
