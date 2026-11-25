"""Target model for the next CampusFest (Pune): how many verified unique external
visitors can we expect, from what, at what cost.

Every input is tagged:
  DERIVED  computed from the 2025 dataset (reproducible from the workbook)
  SOURCED  external evidence, with the source named
  ASSUMED  our judgement, with the reason

Structure (per acquisition channel c):
  registrations_c = reg_2025_c * (spend_c / spend_2025_c) ** beta      diminishing returns
                    * (1 + form_recovery * abandon_ratio_c)            form-abandoner recovery
  confirmed_c     = registrations_c * (confirm_rate_c + waitlist_release * waitlist_ratio_c)
  no_show_c       = true_no_show_c * (1 - reminder_effect)             reminders, reconfirmation
                    + gate_loss_c * (1 - gate_fix)                     confirmed people lost at the gate
  visitors_c      = confirmed_c * (1 - no_show_c)
  total           = sum(visitors_c) + walk_ins

Check built in: with 2025 spend and every lever at zero, the model must reproduce
the 2025 result (2,050) exactly.

Usage: .venv/bin/python analysis/target_model.py [--workbook PATH]
"""
from __future__ import annotations

import argparse
import sys
from dataclasses import dataclass, replace
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
import reference_metrics as ref  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
FINAL = "2025-04-20"
# Paid reach channels. Evidence for treating them differently (DERIVED): in 2025,
# Paid Social's cost per registration rose from INR 113 (Feb) to 199 (Mar), while
# Ambassadors (106->66), College Partnerships (114->53) and Referrals (177->46) got
# cheaper; Organic rose slightly (48->57). Monthly ratios are rough (spend and
# registrations are not aligned in time).
PAID = {"C02", "C03"}


# --------------------------------------------------------------------------
# DERIVED: 2025 per-channel funnel, with the no-show split into "did not come"
# and "came but was never admitted" (denied or unverified at the gate).
# --------------------------------------------------------------------------
def channel_baseline(d: ref.Data) -> pd.DataFrame:
    cm = pd.DataFrame(ref.campaign_metrics(d, FINAL)).T
    st = ref.registration_status(d, FINAL)
    ps = ref.person_status(st, ["campaign_id", "person_id"])
    confirmed = ps[ps.status == "confirmed"]
    vis = set(ref.visitors(d, FINAL).person_id)
    ck = d.checkins
    seen_at_gate = set(ck.loc[ck.person_id.isin(d.external_ids), "person_id"])
    gate_lost = confirmed[confirmed.person_id.isin(seen_at_gate) & ~confirmed.person_id.isin(vis)]
    cm["gate_lost"] = gate_lost.groupby("campaign_id").size().reindex(cm.index).fillna(0).astype(int)
    names = d.campaigns.set_index("campaign_id").campaign_name
    out = pd.DataFrame({
        "channel": names,
        "spend_2025": cm.spend_inr.astype(float),
        "registered": cm.registered.astype(float),
        "form_starters": cm.form_starters.astype(float),
        "confirmed": cm.confirmed.astype(float),
        "waitlisted": cm.waitlisted.astype(float),
        "came": cm.confirmed_who_attended.astype(float),
        "gate_lost": cm.gate_lost.astype(float),
    })
    out["confirm_rate"] = out.confirmed / out.registered
    out["waitlist_ratio"] = out.waitlisted / out.registered
    out["abandon_ratio"] = (out.form_starters - out.registered).clip(lower=0) / out.registered
    out["no_show"] = 1 - out.came / out.confirmed
    out["gate_loss"] = out.gate_lost / out.confirmed
    out["true_no_show"] = out.no_show - out.gate_loss
    return out


@dataclass(frozen=True)
class Scenario:
    name: str
    spend: dict            # channel id -> INR (ASSUMED allocation; see the plan in main())
    beta_paid: float       # ASSUMED diminishing-returns exponent for paid reach (Paid Social, Creators)
    beta_peer: float       # ASSUMED exponent for peer and group channels (1 = linear)
    reminder_effect: float  # relative cut in true no-show from reminders + reconfirmation
    gate_fix: float        # share of gate losses recovered
    waitlist_release: float  # share of would-be-waitlisted people confirmed instead
    form_recovery: float   # share of form abandoners recovered
    walk_ins: float
    programme_cost: float = 0.0  # show-up programme and other non-channel spend
    showup_regress: float = 0.0  # stress test: in channels whose spend grows, true no-show moves this share of
                                 # the way towards the 2025 all-channel rate (marginal people are less committed)


def run(base: pd.DataFrame, s: Scenario) -> pd.DataFrame:
    r = base.copy()
    r["spend"] = pd.Series(s.spend, dtype=float).reindex(r.index).fillna(0.0)
    beta = pd.Series({c: (s.beta_paid if c in PAID else s.beta_peer) for c in r.index})
    r["beta"] = beta
    r["reg"] = r.registered * (r.spend / r.spend_2025) ** beta * (1 + s.form_recovery * r.abandon_ratio)
    r["conf"] = r.reg * (r.confirm_rate + s.waitlist_release * r.waitlist_ratio)
    tns = r.true_no_show
    if s.showup_regress:
        blended = (r.confirmed * r.true_no_show).sum() / r.confirmed.sum()
        grows = r.spend > r.spend_2025
        tns = tns.where(~grows, tns + s.showup_regress * (blended - tns).clip(lower=0))
    r["no_show_new"] = tns * (1 - s.reminder_effect) + r.gate_loss * (1 - s.gate_fix)
    r["visitors"] = r.conf * (1 - r.no_show_new)
    return r


def summarise(r: pd.DataFrame, s: Scenario) -> dict:
    visitors = r.visitors.sum() + s.walk_ins
    spend = r.spend.sum() + s.programme_cost
    return {"scenario": s.name, "registrations": r.reg.sum(), "confirmed": r.conf.sum(),
            "visitors": visitors, "spend": spend, "inr_per_visitor": spend / visitors,
            "show_up": r.visitors.sum() / r.conf.sum()}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--workbook", default=str(ROOT / "data" / "original" / "Attendee Dataset.xlsx"))
    args = ap.parse_args()
    d = ref.load(args.workbook)
    base = channel_baseline(d)
    walk_ins_2025 = ref.funnel(d, FINAL)["visitors_walk_in"]

    pd.set_option("display.width", 200)
    print("== DERIVED: 2025 channel baseline")
    print(base[["channel", "spend_2025", "registered", "confirm_rate", "waitlist_ratio", "abandon_ratio",
                "no_show", "gate_loss", "true_no_show"]].round(3).to_string())

    # ---- Check: 2025 spend, no levers -> must reproduce 2025 exactly.
    s2025 = Scenario("2025 replay", spend=base.spend_2025.to_dict(), beta_paid=0.5, beta_peer=0.7,
                     reminder_effect=0, gate_fix=0,
                     waitlist_release=0, form_recovery=0, walk_ins=walk_ins_2025)
    chk = summarise(run(base, s2025), s2025)
    assert round(chk["visitors"]) == 2050, chk
    print(f"\nCheck: model reproduces 2025 with 2025 spend and no levers -> {chk['visitors']:.0f} visitors (actual 2,050)")

    # ---- ASSUMED: 2027 allocation of the same INR 3.0 lakh budget.
    # Money moves from the two channels whose confirmed registrants showed up least
    # (Paid Social 59%, Creators 60%) to the peer and group channels (81-92%).
    # Paid Social keeps a retargeting budget for form-abandoners and page visitors.
    plan = {"C01": 55_000,  # Campus Ambassadors (paid per verified attendee)
            "C02": 40_000,  # Paid Social, retargeting only
            "C03": 10_000,  # Creator Partners, performance codes only
            "C04": 82_500,  # College & club partnerships, group registration (incl. half the reserve)
            "C05": 57_500,  # Student referrals, reward on friend's verified attendance (incl. half the reserve)
            "C06": 20_000,  # Organic search + event listings
            "C07": 20_000}  # Community groups
    programme = 15_000      # show-up programme: WhatsApp utility reminders, reconfirmation, extra gate scanners
    assert sum(plan.values()) + programme == 300_000

    base_s = Scenario("Base", spend=plan, beta_paid=0.5, beta_peer=0.7, reminder_effect=0.10, gate_fix=0.5, waitlist_release=0.5,
                      form_recovery=0.2, walk_ins=125, programme_cost=programme)
    stretch_s = Scenario("Stretch", spend=plan, beta_paid=0.6, beta_peer=0.9, reminder_effect=0.25, gate_fix=0.9, waitlist_release=0.9,
                         form_recovery=0.4, walk_ins=175, programme_cost=programme)

    rows = [summarise(run(base, s2025), s2025)]
    detail = {}
    for s in (base_s, stretch_s):
        r = run(base, s)
        detail[s.name] = r
        rows.append(summarise(r, s))
    res = pd.DataFrame(rows).set_index("scenario")
    print("\n== Scenarios (same INR 3.0 lakh budget in 2027)")
    print(res.round(3).to_string())

    for name, r in detail.items():
        print(f"\n-- {name} by channel")
        print(r[["channel", "spend_2025", "spend", "registered", "reg", "conf", "no_show", "no_show_new",
                 "visitors"]].round(1).to_string())

    # ---- Lever-by-lever bridge from 2025 to Base and Stretch (applied in order,
    # so each lever is measured on top of the previous ones: no double counting).
    for target in (base_s, stretch_s):
        print(f"\n== Bridge 2025 -> {target.name}")
        steps = [("2025 actual", s2025),
                 ("1. reallocate budget", replace(s2025, spend=plan, beta_paid=target.beta_paid,
                                                  beta_peer=target.beta_peer)),
                 ("2. form-abandoner recovery", None),
                 ("3. waitlist auto-release", None),
                 ("4. reminders + reconfirmation", None),
                 ("5. gate fix", None),
                 ("6. walk-ins", None)]
        cur = steps[1][1]
        prev_v = summarise(run(base, s2025), s2025)["visitors"]
        print(f"  {'2025 actual':32s} {prev_v:7.0f}")
        seq = [("1. reallocate budget", cur),
               ("2. form-abandoner recovery", replace(cur, form_recovery=target.form_recovery)),
               ]
        seq.append(("3. waitlist auto-release", replace(seq[-1][1], waitlist_release=target.waitlist_release)))
        seq.append(("4. reminders + reconfirmation", replace(seq[-1][1], reminder_effect=target.reminder_effect)))
        seq.append(("5. gate fix", replace(seq[-1][1], gate_fix=target.gate_fix)))
        seq.append(("6. walk-ins", replace(seq[-1][1], walk_ins=target.walk_ins)))
        for label, s in seq:
            v = summarise(run(base, s), s)["visitors"]
            print(f"  {label:32s} {v:7.0f}   ({v - prev_v:+.0f})")
            prev_v = v

    # ---- Sensitivity: the two assumptions that move the answer most.
    print("\n== Sensitivity of total visitors (other Base settings fixed; paid-channel beta 0.5)")
    grid = []
    for beta in (0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0):
        row = {"peer beta": beta}
        for rem in (0.0, 0.10, 0.25):
            s = replace(base_s, beta_peer=beta, reminder_effect=rem)
            row[f"reminder {rem:.0%}"] = summarise(run(base, s), s)["visitors"]
        grid.append(row)
    print(pd.DataFrame(grid).set_index("peer beta").round(0).to_string())

    # ---- Stress tests on the Base case: what the commitment survives.
    print("\n== Stress tests (Base settings unless stated)")
    no_reserve = {**plan, "C04": plan["C04"] - 12_500, "C05": plan["C05"] - 12_500}
    tests = [("Base as planned", base_s),
             ("Peer beta 0.5 instead of 0.7", replace(base_s, beta_peer=0.5)),
             ("Scaled channels' show-up regresses halfway to the 2025 average", replace(base_s, showup_regress=0.5)),
             ("Reserve (INR 25k) never released", replace(base_s, spend=no_reserve)),
             ("Peer beta 0.5 AND show-up regresses halfway", replace(base_s, beta_peer=0.5, showup_regress=0.5)),
             ("All three together", replace(base_s, beta_peer=0.5, showup_regress=0.5, spend=no_reserve))]
    for label, s in tests:
        o = summarise(run(base, s), s)
        print(f"  {label:66s} {o['visitors']:6.0f} visitors   show-up {o['show_up']:.1%}   INR {o['inr_per_visitor']:.0f}/visitor")

    # Marginal cost of one more visitor at the plan allocation: visitors_c scale
    # as spend_c ** beta_c, so d(visitors)/d(spend) = beta_c * visitors_c / spend_c.
    print("\n== Where the next rupee goes: marginal INR per extra visitor at the plan allocation")
    for name, r in detail.items():
        m = (r.spend / (r.beta * r.visitors)).rename(name)
        print(m.round(0).to_frame().join(r.channel).to_string())

    # ---- Capacity: gate throughput is the binding operational constraint.
    f = ref.funnel(d, FINAL)
    v = ref.visitors(d, FINAL)
    ok = d.checkins[(d.checkins.result == "admitted") & (d.checkins.verification == "verified")
                    & d.checkins.person_id.isin(d.external_ids)]
    ok = ok.assign(day=ok.occurred_at.dt.date, hour=ok.occurred_at.dt.hour)
    first = ok.sort_values("occurred_at").drop_duplicates(["person_id", "day"])
    per_day = first.groupby("day").size()
    peak = first.groupby(["day", "hour"]).size().max()
    both = (ok.groupby("person_id").day.nunique() > 1).mean()
    peak_share = peak / f["visitors"]
    print("\n== Capacity check (DERIVED from 2025 check-ins)")
    print(f"  visitors on both days: {both:.1%}; day totals {per_day.to_dict()}; busiest hour {peak} first admissions"
          f" = {peak_share:.1%} of unique visitors")
    for name in ("Base", "Stretch"):
        u = res.loc[name, "visitors"]
        print(f"  {name}: {u:.0f} unique -> about {u * per_day.max() / f['visitors']:.0f} on the busier day,"
              f" peak gate load about {u * peak_share:.0f} admissions/hour (2025 peak: {peak})")

    for target in (base_s, stretch_s):
        print(f"\n== Contribution by bet ({target.name}; applied in rank order, parts add up to the total)")
        for label, delta, total in bridge_by_bet(base, target, s2025):
            print(f"  {label:70s} {delta:+7.0f}   -> {total:6.0f}")



def bridge_by_bet(base: pd.DataFrame, target: Scenario, s2025: Scenario):
    """Contribution of each strategic bet, applied in rank order so the parts add
    up exactly to the total (each bet is measured on top of the ones before it)."""
    spend = dict(s2025.spend)
    steps = []
    cur = replace(s2025, beta_paid=target.beta_paid, beta_peer=target.beta_peer)

    def add(label, **changes):
        nonlocal cur
        before = summarise(run(base, cur), cur)["visitors"]
        cur = replace(cur, **changes)
        after = summarise(run(base, cur), cur)["visitors"]
        steps.append((label, after - before, after))

    plan = target.spend
    add("1. College & club partnerships (C04)", spend={**spend, "C04": plan["C04"]}); spend = dict(cur.spend)
    add("2. Referral rewards on verified attendance (C05)", spend={**spend, "C05": plan["C05"]}); spend = dict(cur.spend)
    add("3. Show-up & gate programme (waitlist release, reminders, gate fix)",
        waitlist_release=target.waitlist_release, reminder_effect=target.reminder_effect, gate_fix=target.gate_fix)
    add("4. Paid Social to retargeting only (C02) + form-abandoner recovery",
        spend={**spend, "C02": plan["C02"]}, form_recovery=target.form_recovery); spend = dict(cur.spend)
    add("5. Ambassadors paid per verified attendee (C01)", spend={**spend, "C01": plan["C01"]}); spend = dict(cur.spend)
    add("Other: cut Creators to performance codes (C03)", spend={**spend, "C03": plan["C03"]}); spend = dict(cur.spend)
    add("Other: Organic + listings (C06), Community (C07)", spend={**spend, "C06": plan["C06"], "C07": plan["C07"]})
    add("Other: walk-ins", walk_ins=target.walk_ins, programme_cost=target.programme_cost)
    return steps


if __name__ == "__main__":
    main()
