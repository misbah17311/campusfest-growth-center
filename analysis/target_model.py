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

Win-back (a channel with no 2025 history, "C08"): 2025's verified visitors and
confirmed no-shows who did not opt out are messaged again. Registrations =
pool * share still reachable and eligible * incremental registration rate
(net of people who would have registered through another channel anyway);
confirmation and show-up as in the 2025 peer and group channels (ASSUMED).

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
PEER = ["C04", "C05", "C06", "C07"]  # group and peer channels; their averages stand in for win-back


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
        "identified": cm.identified.astype(float),
        "impressions": cm.impressions.astype(float),
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
    winback_pool: float = 0.0    # DERIVED: 2025 verified visitors + confirmed no-shows, minus opt-outs
    winback_reach: float = 0.0   # ASSUMED: share still reachable and eligible two years on (students, in Pune)
    winback_rate: float = 0.0    # ASSUMED: incremental registration rate among those reached (net of overlap)


def winback_row(base: pd.DataFrame) -> pd.DataFrame:
    """ASSUMED profile of a returning 2025 person: the confirmed-weighted average of the
    peer and group channels; no form abandonment (they register from a direct link) and
    no gate loss (bet 1 fixes the gate check)."""
    p = base.loc[PEER]
    w = p.confirmed / p.confirmed.sum()
    return pd.DataFrame({"channel": ["Win-back (2025 people)"], "spend_2025": [0.0], "registered": [0.0],
                         "form_starters": [0.0], "confirmed": [0.0], "waitlisted": [0.0], "came": [0.0], "gate_lost": [0.0],
                         "identified": [0.0], "impressions": [0.0],
                         "confirm_rate": [(p.confirm_rate * w).sum()], "waitlist_ratio": [(p.waitlist_ratio * w).sum()],
                         "abandon_ratio": [0.0], "no_show": [(p.true_no_show * w).sum()], "gate_loss": [0.0],
                         "true_no_show": [(p.true_no_show * w).sum()]}, index=["C08"])


def run(base: pd.DataFrame, s: Scenario) -> pd.DataFrame:
    r = pd.concat([base, winback_row(base)])
    r["spend"] = pd.Series(s.spend, dtype=float).reindex(r.index).fillna(0.0)
    beta = pd.Series({c: (s.beta_paid if c in PAID else s.beta_peer) for c in r.index})
    r["beta"] = beta
    scale = (r.spend / r.spend_2025.where(r.spend_2025 > 0)) ** beta
    r["reg_spend"] = r.registered * scale.fillna(0.0)          # before form recovery (drives reach needed)
    r.loc["C08", "reg_spend"] = s.winback_pool * s.winback_reach * s.winback_rate
    r["reg"] = r.reg_spend * (1 + s.form_recovery * r.abandon_ratio)
    r["conf"] = r.reg * (r.confirm_rate + s.waitlist_release * r.waitlist_ratio)
    tns = r.true_no_show
    if s.showup_regress:
        blended = (r.confirmed * r.true_no_show).sum() / r.confirmed.sum()
        grows = r.spend > r.spend_2025
        tns = tns.where(~grows, tns + s.showup_regress * (blended - tns).clip(lower=0))
    r["no_show_new"] = tns * (1 - s.reminder_effect) + r.gate_loss * (1 - s.gate_fix)
    r["visitors"] = r.conf * (1 - r.no_show_new)
    # Reach end of the funnel (DERIVED ratios, held at 2025 levels): people we must identify and
    # anonymous impressions behind them. Win-back people are already identified and need no ads.
    ratio = lambda col: (r[col] / r.registered.where(r.registered > 0)).fillna(0.0)
    r["identified_needed"] = r.reg_spend * ratio("identified")
    r.loc["C08", "identified_needed"] = s.winback_pool * s.winback_reach
    r["impressions_needed"] = r.reg_spend * ratio("impressions")
    return r


def summarise(r: pd.DataFrame, s: Scenario) -> dict:
    visitors = r.visitors.sum() + s.walk_ins
    spend = r.spend.sum() + s.programme_cost
    return {"scenario": s.name, "impressions": r.impressions_needed.sum(),
            "identified": r.identified_needed.sum() + s.walk_ins, "registrations": r.reg.sum(),
            "confirmed": r.conf.sum(), "came": r.visitors.sum(), "walk_ins": s.walk_ins,
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
    assert round(chk["identified"]) == 3625, chk
    pool = winback_pool(d)
    print(f"Win-back pool (DERIVED): {pool} people = 2025 verified visitors + confirmed no-shows, minus opt-outs")
    print(f"\nCheck: model reproduces 2025 with 2025 spend and no levers -> {chk['visitors']:.0f} visitors (actual 2,050)")

    # ---- ASSUMED: 2027 allocation of the same INR 3.0 lakh budget.
    # Money moves from the two channels whose confirmed registrants showed up least
    # (Paid Social 59%, Creators 60%) to the peer and group channels (81-92%).
    # Paid Social keeps a retargeting budget for form-abandoners and page visitors.
    plan = {"C01": 55_000,  # Campus Ambassadors (paid per verified attendee)
            "C02": 30_000,  # Paid Social, retargeting only (form abandoners, page visitors)
            "C03": 10_000,  # Creator Partners, performance codes only
            "C04": 82_500,  # College & club partnerships, group registration (incl. half the reserve)
            "C05": 57_500,  # Student referrals, reward on friend's verified attendance (incl. half the reserve)
            "C06": 20_000,  # Organic search + event listings
            "C07": 20_000,  # Community groups
            "C08": 10_000}  # Win back 2025's people: WhatsApp marketing messages (~INR 1 each incl. GST) + email
    programme = 15_000      # show-up programme: WhatsApp utility reminders, reconfirmation, extra gate scanners
    assert sum(plan.values()) + programme == 300_000

    base_s = Scenario("Base", spend=plan, beta_paid=0.5, beta_peer=0.7, reminder_effect=0.10, gate_fix=0.5, waitlist_release=0.5,
                      form_recovery=0.2, walk_ins=125, programme_cost=programme,
                      winback_pool=pool, winback_reach=0.4, winback_rate=0.10)
    stretch_s = Scenario("Stretch", spend=plan, beta_paid=0.6, beta_peer=0.9, reminder_effect=0.25, gate_fix=0.9, waitlist_release=0.9,
                         form_recovery=0.4, walk_ins=175, programme_cost=programme,
                         winback_pool=pool, winback_reach=0.5, winback_rate=0.20)

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
        cur = replace(cur, spend={**plan, "C08": 0})
        seq = [("1. reallocate budget", cur),
               ("1b. win back 2025's people", replace(cur, spend=plan, winback_pool=pool,
                                                      winback_reach=target.winback_reach, winback_rate=target.winback_rate))]
        seq.append(("2. form-abandoner recovery", replace(seq[-1][1], form_recovery=target.form_recovery)))
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
        m = (r.spend / (r.beta * r.visitors)).drop("C08").rename(name)  # win-back is pool-limited, not spend-driven
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

    print("\n== Ranking the bets: score = extra visitors per INR 1,000 of new money x confidence")
    print("   (each bet measured alone on top of 2025, Base settings; confidence High 1.0, Medium-high 0.8,")
    print("    Medium 0.6, Low 0.4)")
    ranked = rank_bets(base, base_s, s2025)
    for b in ranked:
        print(f"  {b['label']:52s} alone {b['alone']:+6.0f}  new money INR {b['new_money']:7,.0f}"
              f"  conf {b['confidence']:.1f}  score {b['score']:5.2f}")
    order = [b["key"] for b in ranked]
    for target in (base_s, stretch_s):
        print(f"\n== Contribution by bet ({target.name}; applied in rank order, parts add up to the total)")
        for label, delta, total in bridge_by_bet(base, target, s2025, order):
            print(f"  {label:70s} {delta:+7.0f}   -> {total:6.0f}")



def winback_pool(d: ref.Data) -> int:
    """DERIVED: people CampusFest already knows best: 2025 verified visitors plus confirmed
    registrants who did not come, minus everyone who opted out of messages."""
    v = set(ref.visitors(d, FINAL).person_id)
    ps = ref.person_status(ref.registration_status(d, FINAL), ["person_id"])
    conf = set(ps.loc[ps.status == "confirmed", "person_id"])
    opted_out = set(d.interactions.loc[d.interactions.event_type == "opted_out", "person_id"])
    return len((v | conf) - opted_out)


# The five bets: what each changes, the new money it needs, and the confidence in its evidence.
CONFIDENCE = {"High": 1.0, "Medium-high": 0.8, "Medium": 0.6, "Low": 0.4}


def bet_changes(key: str, target: Scenario, spend: dict) -> dict:
    plan = target.spend
    return {
        "showup": dict(waitlist_release=target.waitlist_release, reminder_effect=target.reminder_effect,
                       gate_fix=target.gate_fix, programme_cost=target.programme_cost),
        "partnerships": dict(spend={**spend, "C04": plan["C04"]}),
        "ambassadors": dict(spend={**spend, "C01": plan["C01"]}),
        "referrals": dict(spend={**spend, "C05": plan["C05"]}),
        "winback": dict(spend={**spend, "C08": plan["C08"]}, winback_pool=target.winback_pool,
                        winback_reach=target.winback_reach, winback_rate=target.winback_rate),
    }[key]


BETS = {  # key: (label, confidence, new money as a function of the plan and 2025 spend)
    "showup": ("Show-up and gate programme", "High", lambda plan, b, t: t.programme_cost),
    "partnerships": ("College & club partnerships (C04)", "Medium-high", lambda plan, b, t: plan["C04"] - b.spend_2025["C04"]),
    "ambassadors": ("Ambassadors paid per verified attendee (C01)", "Medium-high", lambda plan, b, t: plan["C01"] - b.spend_2025["C01"]),
    "referrals": ("Referral rewards on verified attendance (C05)", "Medium", lambda plan, b, t: plan["C05"] - b.spend_2025["C05"]),
    "winback": ("Win back 2025's people (C08)", "Low", lambda plan, b, t: plan["C08"]),
}


def rank_bets(base: pd.DataFrame, target: Scenario, s2025: Scenario) -> list[dict]:
    """Score each bet on its own (on top of 2025 with the target's betas), so the ranking does
    not depend on the order the bets are applied in."""
    start = replace(s2025, beta_paid=target.beta_paid, beta_peer=target.beta_peer)
    v0 = summarise(run(base, start), start)["visitors"]
    out = []
    for key, (label, conf, money) in BETS.items():
        s = replace(start, **bet_changes(key, target, dict(start.spend)))
        alone = summarise(run(base, s), s)["visitors"] - v0
        new_money = money(target.spend, base, target)
        out.append({"key": key, "label": label, "alone": alone, "new_money": new_money, "confidence": CONFIDENCE[conf],
                    "confidence_label": conf, "score": alone / (new_money / 1000) * CONFIDENCE[conf]})
    return sorted(out, key=lambda b: -b["score"])


def bridge_by_bet(base: pd.DataFrame, target: Scenario, s2025: Scenario, order: list[str]):
    """Contribution of each strategic bet, applied in rank order so the parts add
    up exactly to the total (each bet is measured on top of the ones before it)."""
    steps = []
    cur = replace(s2025, beta_paid=target.beta_paid, beta_peer=target.beta_peer)

    def add(label, **changes):
        nonlocal cur
        before = summarise(run(base, cur), cur)["visitors"]
        cur = replace(cur, **changes)
        after = summarise(run(base, cur), cur)["visitors"]
        steps.append((label, after - before, after))

    plan = target.spend
    for n, key in enumerate(order, 1):
        add(f"{n}. {BETS[key][0]}", **bet_changes(key, target, dict(cur.spend)))
    add("Other: Paid Social to retargeting only (C02) + form-abandoner recovery",
        spend={**cur.spend, "C02": plan["C02"]}, form_recovery=target.form_recovery)
    add("Other: cut Creators to performance codes (C03)", spend={**cur.spend, "C03": plan["C03"]})
    add("Other: Organic + listings (C06), Community (C07)", spend={**cur.spend, "C06": plan["C06"], "C07": plan["C07"]})
    add("Other: walk-ins", walk_ins=target.walk_ins)
    return steps


if __name__ == "__main__":
    main()
