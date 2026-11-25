"""Edit, as-of and reset behaviour of the database layer.

Runs only against a local database (refuses any other host), because it edits
data and then resets it.

  .venv/bin/python tests/test_db_edits.py --db-url postgresql://postgres:devpass@127.0.0.1:5433/campusfest
"""
from __future__ import annotations

import argparse
import os
import sys
from urllib.parse import urlparse

import psycopg
from psycopg.rows import dict_row

FAILS = []


def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + (f"  ({detail})" if detail and not cond else ""))
    if not cond:
        FAILS.append(name)


def funnel(conn, day):
    return conn.execute("select * from funnel_asof(%s)", (day,)).fetchone()


def campaigns(conn, day):
    return {r["campaign_id"]: r for r in conn.execute("select * from campaign_metrics_asof(%s)", (day,))}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db-url", default=os.environ.get("DATABASE_URL"))
    url = ap.parse_args().db_url
    if urlparse(url).hostname not in ("127.0.0.1", "localhost"):
        raise SystemExit("Refusing to run: this test edits data and must use a local database.")

    with psycopg.connect(url, row_factory=dict_row, autocommit=True) as conn:
        conn.execute("select reset_to_original('test')")
        base_f = funnel(conn, "2025-04-20")
        base_c = campaigns(conn, "2025-04-20")
        base_f_0410 = funnel(conn, "2025-04-10")
        log0 = conn.execute("select max(change_id) as m from change_log").fetchone()["m"] or 0
        check("starts identical to original", conn.execute("select data_differs_from_original() d").fetchone()["d"] is False)

        # A task linked to a campaign must survive a reset with its link intact.
        task_id = conn.execute("insert into tasks (title, owner_id, campaign_id, source) "
                               "values ('test task', 'T04', 'C02', 'manual') returning task_id").fetchone()["task_id"]

        # 1. Spend edit flows into totals and only the edited campaign.
        row = conn.execute("select activity_id, marketing_spend_inr from daily_marketing "
                           "where campaign_id = 'C02' and marketing_spend_inr > 0 order by activity_date limit 1").fetchone()
        conn.execute("update daily_marketing set marketing_spend_inr = marketing_spend_inr + 10000 "
                     "where activity_id = %s", (row["activity_id"],))
        f, c = funnel(conn, "2025-04-20"), campaigns(conn, "2025-04-20")
        check("spend edit raises total spend by 10,000", f["spend_inr"] == base_f["spend_inr"] + 10000,
              f"{base_f['spend_inr']} -> {f['spend_inr']}")
        check("spend edit raises Paid Social spend by 10,000", c["C02"]["spend_inr"] == base_c["C02"]["spend_inr"] + 10000)
        check("spend edit changes Paid Social cost per registration",
              c["C02"]["cost_per_registration"] != base_c["C02"]["cost_per_registration"])
        check("spend edit leaves other campaigns unchanged",
              all(c[k] == base_c[k] for k in base_c if k != "C02"))
        check("spend edit leaves visitors unchanged", f["visitors"] == base_f["visitors"])
        logged = conn.execute("select * from change_log where change_id > %s and table_name = 'daily_marketing'",
                              (log0,)).fetchall()
        check("spend edit is in the change log with before and after",
              len(logged) == 1 and logged[0]["before"]["marketing_spend_inr"] == row["marketing_spend_inr"]
              and logged[0]["after"]["marketing_spend_inr"] == row["marketing_spend_inr"] + 10000)

        # 2. A status change dated 11 Apr 23:00 must not leak into 10 Apr.
        reg = conn.execute("""select s.registration_id, s.person_id from registration_status_asof('2025-04-11') s
                              where s.is_external and s.status = 'confirmed'
                                and s.person_id not in (select person_id from visitors_asof('2025-04-20'))
                              order by s.registration_id limit 1""").fetchone()
        conn.execute("""insert into registration_history (history_id, registration_id, person_id, campaign_id, owner_id,
                            effective_at, status)
                        select 'TEST-H1', r.registration_id, r.person_id, r.campaign_id, r.owner_id,
                               '2025-04-11 23:00+05:30', 'cancelled'
                        from registrations r where r.registration_id = %s""", (reg["registration_id"],))
        check("new cancellation reduces confirmed as of 11 Apr by 1",
              funnel(conn, "2025-04-11")["status_confirmed"] == base_f["status_confirmed"] - 1)
        check("new cancellation does not leak into 10 Apr",
              funnel(conn, "2025-04-10")["status_confirmed"] == base_f_0410["status_confirmed"])
        check("show-up rate recomputes (denominator falls by 1)",
              funnel(conn, "2025-04-20")["show_up_rate"] != base_f["show_up_rate"])

        # 3. A new target version applies from its effective date only.
        conn.execute("""insert into targets (effective_at, identified_external_people_goal, registration_goal,
                            unique_external_visitors_goal, marketing_budget_inr, target_version, venue_capacity_per_day)
                        values ('2025-04-01 09:00+05:30', 4000, 3600, 2600, 320000, 'Test plan', 2500)""")
        check("new target version in force from 1 Apr", funnel(conn, "2025-04-01")["registration_goal"] == 3600)
        check("old target version still in force on 31 Mar", funnel(conn, "2025-03-31")["registration_goal"] == 3200)
        check("budget follows the target version", funnel(conn, "2025-04-20")["budget_inr"] == 320000)

        # 4. Campaign status is editable and logged.
        conn.execute("update campaigns set status = 'paused' where campaign_id = 'C03'")
        check("campaign status shows in metrics", campaigns(conn, "2025-04-20")["C03"]["status"] == "paused")

        check("working data now differs from original",
              conn.execute("select data_differs_from_original() d").fetchone()["d"] is True)

        # 5. Reset restores every metric exactly and keeps the task and its link.
        conn.execute("select reset_to_original('test')")
        check("reset restores the funnel exactly", funnel(conn, "2025-04-20") == base_f)
        check("reset restores every campaign exactly", campaigns(conn, "2025-04-20") == base_c)
        check("reset restores 10 Apr exactly", funnel(conn, "2025-04-10") == base_f_0410)
        check("after reset data equals original",
              conn.execute("select data_differs_from_original() d").fetchone()["d"] is False)
        t = conn.execute("select * from tasks where task_id = %s", (task_id,)).fetchone()
        check("task survives reset with its campaign link", t is not None and t["campaign_id"] == "C02")
        last = conn.execute("select action from change_log order by change_id desc limit 1").fetchone()
        check("reset is recorded once in the change log", last["action"] == "reset")

        conn.execute("delete from tasks where task_id = %s", (task_id,))

    print(f"\n{len(FAILS)} failures")
    return 1 if FAILS else 0


if __name__ == "__main__":
    sys.exit(main())
