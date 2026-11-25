"""Internal consistency of the SQL analytics: different functions that describe
the same population must add up. Read-only, so it can run against any database.

  .venv/bin/python tests/test_sql_consistency.py --db-url postgresql://...
"""
from __future__ import annotations

import argparse
import os
import sys

import psycopg
from psycopg.rows import dict_row

DATES = ["2025-02-15", "2025-03-15", "2025-04-11", "2025-04-12", "2025-04-20"]
FAILS: list[str] = []


def check(name: str, cond: bool, detail: str = ""):
    print(("PASS " if cond else "FAIL ") + name + (f"  ({detail})" if detail and not cond else ""))
    if not cond:
        FAILS.append(name)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db-url", default=os.environ.get("DATABASE_URL"))
    with psycopg.connect(ap.parse_args().db_url, row_factory=dict_row) as conn:
        q = lambda sql, *a: conn.execute(sql, a).fetchall()
        bad = q("""select count(*) as n from daily_series_asof('2025-04-20') d cross join lateral funnel_asof(d.day) f
                   where d.identified <> f.identified_external or d.registered <> f.registered_people
                      or d.confirmed <> f.status_confirmed or d.visitors <> f.visitors or d.spend_inr <> f.spend_inr""")[0]["n"]
        check("every daily-series row equals funnel_asof for that day (96 days)", bad == 0, f"{bad} mismatching days")

        for day in DATES:
            f = q("select * from funnel_asof(%s)", day)[0]
            cm = q("select * from campaign_metrics_asof(%s)", day)
            lk = {r["sort_order"]: r["people"] for r in q("select * from funnel_leaks_asof(%s)", day)}
            ident_campaign = q("""select count(*) as n from people where person_type = 'external'
                                  and first_touch_source = 'campaign' and first_seen_at < cutoff(%s)""", day)[0]["n"]
            check(f"{day}: campaign registrations add up to the total",
                  sum(r["registered"] for r in cm) == f["registered_people"])
            check(f"{day}: campaign spend adds up to the total", sum(r["spend_inr"] for r in cm) == f["spend_inr"])
            check(f"{day}: campaign visitors + walk-ins = all visitors",
                  sum(r["visitors"] for r in cm) + f["visitors_walk_in"] == f["visitors"])
            check(f"{day}: identified via campaign = registered + abandoned form + never started",
                  ident_campaign == f["registered_people"] + lk[1] + lk[2],
                  f"{ident_campaign} vs {f['registered_people']} + {lk[1]} + {lk[2]}")
            check(f"{day}: registered = confirmed + interested + waitlisted + cancelled + unknown",
                  f["registered_people"] == f["status_confirmed"] + f["status_interested"] + f["status_waitlisted"]
                  + f["status_cancelled"] + f["status_unknown"])
            if f["event_phase"] != "before":
                check(f"{day}: confirmed = came + lost at gate + did not come",
                      f["status_confirmed"] == f["confirmed_who_attended"] + lk[6] + lk[7])
            else:
                check(f"{day}: no visitors and no show-up before the event",
                      f["visitors"] == 0 and f["show_up_rate"] is None and lk[6] is None)
            dec = q("select * from campaign_decisions_asof(%s)", day)
            check(f"{day}: one decision per campaign, all valid",
                  len(dec) == len(cm) and all(r["decision"] in ("scale", "keep", "change", "stop", "insufficient data")
                                              for r in dec))
    print(f"\n{len(FAILS)} failures")
    return 1 if FAILS else 0


if __name__ == "__main__":
    sys.exit(main())
