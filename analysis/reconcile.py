"""Compare the SQL metrics (database) with the pandas reference (workbook).

Usage:
  .venv/bin/python analysis/reconcile.py --db-url postgresql://...   [--workbook PATH]

Exits with status 1 if any value differs. Ratios are compared with a tolerance
of half a unit in the last digit the SQL rounds to (Postgres and Python round
halves differently); counts and rupee totals must match exactly.
"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

import psycopg
from psycopg.rows import dict_row

sys.path.insert(0, str(Path(__file__).resolve().parent))
import reference_metrics as ref  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
DATES = ["2025-01-14", "2025-01-20", "2025-02-15", "2025-03-14", "2025-03-15",
         "2025-04-01", "2025-04-11", "2025-04-12", "2025-04-13", "2025-04-20"]
RATIO_TOL = {"show_up_rate": 5e-5, "ctr": 5e-5, "identified_to_registered": 5e-5,
             "starter_to_registered": 5e-5, "registered_to_confirmed": 5e-5,
             "cost_per_registration": 5e-3, "cost_per_visitor": 5e-3}


def same(key, a, b) -> bool:
    if a is None or b is None:
        return a is None and b is None
    if key in RATIO_TOL:
        return abs(float(a) - float(b)) <= RATIO_TOL[key]
    if isinstance(a, (int, float)) or isinstance(b, (int, float)):
        return float(a) == float(b)
    return a == b


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db-url", default=os.environ.get("DATABASE_URL"))
    ap.add_argument("--workbook", default=str(ROOT / "data" / "original" / "Attendee Dataset.xlsx"))
    args = ap.parse_args()

    d = ref.load(args.workbook)
    checked = mismatches = 0
    with psycopg.connect(args.db_url, row_factory=dict_row) as conn:
        for day in DATES:
            sql = conn.execute("select * from funnel_asof(%s)", (day,)).fetchone()
            py = ref.funnel(d, day)
            for k, v in py.items():
                checked += 1
                if not same(k, sql[k], v):
                    mismatches += 1
                    print(f"MISMATCH funnel {day} {k}: sql={sql[k]} python={v}")
            sql_c = {r["campaign_id"]: r for r in conn.execute("select * from campaign_metrics_asof(%s)", (day,))}
            py_c = ref.campaign_metrics(d, day)
            for cid, row in py_c.items():
                for k, v in row.items():
                    checked += 1
                    if not same(k, sql_c[cid][k], v):
                        mismatches += 1
                        print(f"MISMATCH campaign {day} {cid} {k}: sql={sql_c[cid][k]} python={v}")
            print(f"{day}: phase={py['event_phase']:6s} identified={py['identified_external']:5d} "
                  f"registered={py['registered_people']:5d} confirmed={py['status_confirmed']:5d} "
                  f"visitors={py['visitors']:5d} spend={py['spend_inr']:7d}")
    print(f"\nCompared {checked} values at {len(DATES)} dates: {mismatches} mismatches.")
    return 1 if mismatches else 0


if __name__ == "__main__":
    sys.exit(main())
