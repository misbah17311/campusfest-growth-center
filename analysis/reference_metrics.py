"""Reference implementation of the Growth Center metrics in pandas.

It reads the workbook directly (never the database) and applies the dataset's
rules independently of the SQL in db/metrics.sql. analysis/reconcile.py
compares the two field by field. Agreement shows that the SQL implements the
written rules without coding slips; it cannot show that the rules themselves
were read correctly, because the same person wrote both. The rules are listed
at the top of db/metrics.sql with their source.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import pandas as pd

IST = "Asia/Kolkata"
STATUS_PRIORITY = ["confirmed", "waitlisted", "interested", "cancelled", "unknown"]


def _ist(s: pd.Series) -> pd.Series:
    s = pd.to_datetime(s)
    return s.dt.tz_localize(IST) if s.dt.tz is None else s.dt.tz_convert(IST)


@dataclass
class Data:
    event: pd.DataFrame
    targets: pd.DataFrame
    campaigns: pd.DataFrame
    daily: pd.DataFrame
    people: pd.DataFrame
    interactions: pd.DataFrame
    registrations: pd.DataFrame
    history: pd.DataFrame
    checkins: pd.DataFrame

    @property
    def external_ids(self) -> set:
        return set(self.people.loc[self.people.person_type == "external", "person_id"])


def load(path: str | Path) -> Data:
    b = pd.read_excel(path, sheet_name=None)
    dedup = lambda df: df.drop_duplicates()  # exact import-retry copies
    ev = b["Event"].copy()
    for c in ["event_starts_at", "event_ends_at"]:
        ev[c] = _ist(ev[c])
    tg = dedup(b["Targets"]).copy(); tg["effective_at"] = _ist(tg["effective_at"])
    dm = dedup(b["Daily Marketing"]).copy(); dm["activity_date"] = pd.to_datetime(dm["activity_date"]).dt.date
    pe = dedup(b["People"]).copy(); pe["first_seen_at"] = _ist(pe["first_seen_at"])
    ia = dedup(b["Interest and Engagement"]).copy(); ia["occurred_at"] = _ist(ia["occurred_at"])
    rg = dedup(b["Registrations"]).copy(); rg["registered_at"] = _ist(rg["registered_at"])
    rh = dedup(b["Registration History"]).copy(); rh["effective_at"] = _ist(rh["effective_at"])
    ck = dedup(b["Check-ins"]).copy(); ck["occurred_at"] = _ist(ck["occurred_at"])
    return Data(ev, tg, dedup(b["Campaigns"]).copy(), dm, pe, ia, rg, rh, ck)


def cutoff(asof) -> pd.Timestamp:
    """End of the selected day in India time."""
    return pd.Timestamp(asof).tz_localize(IST).normalize() + pd.Timedelta(days=1)


def phase(d: Data, asof) -> str:
    c = cutoff(asof)
    e = d.event.iloc[0]
    if c <= e.event_starts_at:
        return "before"
    if c <= e.event_ends_at:
        return "during"
    return "after"


def target(d: Data, asof):
    t = d.targets[d.targets.effective_at < cutoff(asof)].sort_values("effective_at")
    return None if t.empty else t.iloc[-1]


def registration_status(d: Data, asof) -> pd.DataFrame:
    c = cutoff(asof)
    regs = d.registrations[d.registrations.registered_at < c]
    h = d.history[d.history.effective_at < c].sort_values(["registration_id", "effective_at", "history_id"])
    latest = h.groupby("registration_id").tail(1)[["registration_id", "status"]]
    st = regs.merge(latest, on="registration_id", how="left")
    st["status"] = st["status"].fillna("unknown")
    return st[st.person_id.isin(d.external_ids)]


def person_status(st: pd.DataFrame, by: list[str]) -> pd.DataFrame:
    """Most advanced status per person (or per campaign and person)."""
    rank = {s: i for i, s in enumerate(STATUS_PRIORITY)}
    s = st.assign(r=st.status.map(rank)).sort_values("r")
    return s.drop_duplicates(by, keep="first")[by + ["status"]]


def visitors(d: Data, asof) -> pd.DataFrame:
    c = cutoff(asof)
    ok = d.checkins[(d.checkins.occurred_at < c) & (d.checkins.result == "admitted")
                    & (d.checkins.verification == "verified") & d.checkins.person_id.isin(d.external_ids)]
    first = ok.sort_values(["person_id", "occurred_at", "event_id"]).drop_duplicates("person_id")
    first = first[["person_id", "registration_id"]].merge(
        d.registrations[["registration_id", "campaign_id"]], on="registration_id", how="left")
    return first


def funnel(d: Data, asof) -> dict:
    c = cutoff(asof)
    t = target(d, asof)
    ph = phase(d, asof)
    st = registration_status(d, asof)
    ps = person_status(st, ["person_id"])
    v = visitors(d, asof)
    vis = set(v.person_id)
    regp = set(ps.person_id)
    conf = set(ps.loc[ps.status == "confirmed", "person_id"])
    dm = d.daily[d.daily.activity_date <= pd.Timestamp(asof).date()]
    g = lambda col: None if t is None else int(t[col])
    return {
        "event_phase": ph,
        "target_version": None if t is None else t.target_version,
        "identified_external": int(((d.people.person_type == "external") & (d.people.first_seen_at < c)).sum()),
        "identified_goal": g("identified_external_people_goal"),
        "registered_people": len(regp),
        "registration_goal": g("registration_goal"),
        **{f"status_{s}": int((ps.status == s).sum()) for s in STATUS_PRIORITY},
        "visitors": len(vis),
        "visitors_goal": g("unique_external_visitors_goal"),
        "visitors_registered": len(vis & regp),
        "visitors_walk_in": len(vis - regp),
        "confirmed_who_attended": len(conf & vis),
        "show_up_rate": None if ph == "before" or not conf else len(conf & vis) / len(conf),
        "spend_inr": int(dm.marketing_spend_inr.sum()),
        "budget_inr": g("marketing_budget_inr"),
        "impressions": int(dm.impressions.sum()),
        "clicks": int(dm.clicks.sum()),
        "landing_sessions": int(dm.landing_page_sessions.sum()),
        "form_start_events": int(dm.registration_starts.sum()),
    }


def campaign_metrics(d: Data, asof) -> dict[str, dict]:
    c = cutoff(asof)
    ph = phase(d, asof)
    ext = d.people[(d.people.person_type == "external") & (d.people.first_seen_at < c)]
    st = registration_status(d, asof)
    pc = person_status(st, ["campaign_id", "person_id"])
    v = visitors(d, asof)
    vis = set(v.person_id)
    ia = d.interactions[(d.interactions.occurred_at < c) & d.interactions.person_id.isin(d.external_ids)]
    dm = d.daily[d.daily.activity_date <= pd.Timestamp(asof).date()]

    def ratio(a, b, digits=None):
        return None if not b else a / b

    out = {}
    for cid in d.campaigns.campaign_id:
        p = pc[pc.campaign_id == cid]
        conf = set(p.loc[p.status == "confirmed", "person_id"])
        cdm = dm[dm.campaign_id == cid]
        people_with = lambda et: ia.loc[(ia.campaign_id == cid) & (ia.event_type == et), "person_id"].nunique()
        row = {
            "spend_inr": int(cdm.marketing_spend_inr.sum()),
            "impressions": int(cdm.impressions.sum()),
            "clicks": int(cdm.clicks.sum()),
            "reported_reach": int(cdm.reported_reach.sum()),
            "landing_sessions": int(cdm.landing_page_sessions.sum()),
            "form_start_events": int(cdm.registration_starts.sum()),
            "identified": int((ext.first_campaign_id == cid).sum()),
            "form_starters": int(people_with("registration_start")),
            "registered": len(p),
            "confirmed": len(conf),
            "cancelled": int((p.status == "cancelled").sum()),
            "waitlisted": int((p.status == "waitlisted").sum()),
            "interested": int((p.status == "interested").sum()),
            "visitors": int((v.campaign_id == cid).sum()),
            "confirmed_who_attended": len(conf & vis),
            "nurture_sent": int(people_with("nurture_email_sent")),
            "nurture_opened": int(people_with("nurture_email_opened")),
            "nurture_clicked": int(people_with("nurture_email_clicked")),
            "opted_out": int(people_with("opted_out")),
        }
        row.update({
            "ctr": ratio(row["clicks"], row["impressions"]),
            "identified_to_registered": ratio(row["registered"], row["identified"]),
            "starter_to_registered": ratio(row["registered"], row["form_starters"]),
            "registered_to_confirmed": ratio(row["confirmed"], row["registered"]),
            "show_up_rate": None if ph == "before" else ratio(row["confirmed_who_attended"], row["confirmed"]),
            "cost_per_registration": ratio(row["spend_inr"], row["registered"]),
            "cost_per_visitor": None if ph == "before" else ratio(row["spend_inr"], row["visitors"]),
        })
        out[cid] = row
    return out
