"""Load the CampusFest attendee workbook into Postgres.

Two modes:

  init     Create the schemas, tables and SQL functions (idempotent), load the
           workbook into schema `original` (the pristine copy), then copy it
           into the working tables with reset_to_original(). Use --fresh to
           drop everything first (this also deletes tasks; development only).

  migrate  Re-apply tables, triggers and SQL functions without touching any
           data (safe on a live database; keeps tasks and edits).

  working  Replace only the WORKING data with an edited workbook in the same
           format. The pristine copy in `original` is untouched, so "Reset to
           original" still works afterwards. Tasks and bets are kept.

The database URL comes from --db-url or the DATABASE_URL environment variable.
Only the host and database name are ever printed, never credentials.

Examples (local development database):
  .venv/bin/python db/load_workbook.py init --fresh \
      --db-url postgresql://postgres:devpass@127.0.0.1:5433/campusfest
  .venv/bin/python db/load_workbook.py working edited.xlsx --db-url ...
"""
from __future__ import annotations

import argparse
import os
import sys
import uuid
from pathlib import Path
from urllib.parse import urlparse

import pandas as pd
import psycopg

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_WORKBOOK = ROOT / "data" / "original" / "Attendee Dataset.xlsx"
IST = "Asia/Kolkata"

# sheet name -> (table, key column for dedup, columns to load in table order,
#                datetime columns, date columns)
SHEETS = {
    "Event": ("event", "event_name",
              ["event_name", "history_start", "history_end", "event_starts_at", "event_ends_at",
               "timezone", "currency", "fictional"],
              ["event_starts_at", "event_ends_at"], ["history_start", "history_end"]),
    "Targets": ("targets", "effective_at",
                ["effective_at", "identified_external_people_goal", "registration_goal",
                 "unique_external_visitors_goal", "marketing_budget_inr", "target_version"],
                ["effective_at"], []),
    "Campaigns": ("campaigns", "campaign_id",
                  ["campaign_id", "campaign_name", "channel", "target_audience", "objective", "owner_id",
                   "created_at", "planned_start_at", "planned_end_at"],
                  ["created_at", "planned_start_at", "planned_end_at"], []),
    "Daily Marketing": ("daily_marketing", "activity_id",
                        ["activity_id", "campaign_id", "owner_id", "activity_date", "impressions", "clicks",
                         "reported_reach", "landing_page_sessions", "registration_starts",
                         "marketing_spend_inr", "platform"],
                        [], ["activity_date"]),
    "People": ("people", "person_id",
               ["person_id", "person_name", "person_type", "first_seen_at", "first_touch_source",
                "first_campaign_id", "owner_id"],
               ["first_seen_at"], []),
    "Interest and Engagement": ("interactions", "interaction_id",
                                ["interaction_id", "person_id", "campaign_id", "owner_id", "occurred_at",
                                 "event_type", "detail"],
                                ["occurred_at"], []),
    "Registrations": ("registrations", "registration_id",
                      ["registration_id", "person_id", "campaign_id", "owner_id", "registered_at"],
                      ["registered_at"], []),
    "Registration History": ("registration_history", "history_id",
                             ["history_id", "registration_id", "person_id", "campaign_id", "owner_id",
                              "effective_at", "status"],
                             ["effective_at"], []),
    "Check-ins": ("checkins", "event_id",
                  ["event_id", "person_id", "registration_id", "campaign_id", "owner_id", "occurred_at",
                   "result", "verification", "source"],
                  ["occurred_at"], []),
}
# Insert order respects foreign keys.
LOAD_ORDER = ["Event", "Campaigns", "Targets", "Daily Marketing", "People", "Interest and Engagement",
              "Registrations", "Registration History", "Check-ins"]
# Display names repeated on many sheets; checked against the master entity.
NAME_CHECKS = [("person_name", "person_id", "People"), ("campaign_name", "campaign_id", "Campaigns")]


def describe(url: str) -> str:
    u = urlparse(url)
    return f"{u.hostname}:{u.port or 5432}/{u.path.lstrip('/')}"


def to_ist(series: pd.Series) -> pd.Series:
    s = pd.to_datetime(series)
    if s.dt.tz is None:
        return s.dt.tz_localize(IST)
    return s.dt.tz_convert(IST)


def read_workbook(path: Path):
    """Return {sheet: cleaned DataFrame}, a list of report rows, and problems."""
    book = pd.read_excel(path, sheet_name=None)
    missing = [s for s in SHEETS if s not in book]
    if missing:
        raise SystemExit(f"Workbook is missing sheets: {missing}")

    frames, report, problems = {}, [], []
    for sheet, (table, key, cols, dt_cols, date_cols) in SHEETS.items():
        df = book[sheet]
        absent = [c for c in cols if c not in df.columns]
        if absent:
            raise SystemExit(f"Sheet '{sheet}' is missing columns: {absent}")
        rows_read = len(df)

        exact = df.duplicated(keep="first")          # identical rows: import retries
        df = df[~exact]
        conflict_mask = df.duplicated(key, keep=False)  # same ID, different content
        conflict_ids = sorted(df.loc[conflict_mask, key].astype(str).unique())
        notes = []
        if conflict_ids:
            df = df.drop_duplicates(key, keep="first")
            notes.append(f"{len(conflict_ids)} IDs appear with different content; kept the first row "
                         f"for each: {', '.join(conflict_ids[:10])}{' ...' if len(conflict_ids) > 10 else ''}")
            problems.append(f"{sheet}: {notes[-1]}")

        frames[sheet] = df
        report.append(dict(sheet=sheet, rows_read=rows_read, duplicate_rows_removed=int(exact.sum()),
                           conflicting_ids=len(conflict_ids), rows_loaded=len(df), notes="; ".join(notes) or None))

    # Team: every (owner_id, owner_name) pair seen anywhere must agree.
    pairs = pd.concat([f[["owner_id", "owner_name"]] for f in frames.values() if "owner_id" in f.columns])
    pairs = pairs.dropna().drop_duplicates()
    clash = pairs[pairs.duplicated("owner_id", keep=False)]
    if len(clash):
        problems.append(f"owner IDs with more than one name: {sorted(clash.owner_id.unique())}; kept the first")
    frames["__team__"] = pairs.drop_duplicates("owner_id").sort_values("owner_id")

    # Display-name consistency (IDs are authoritative; mismatches are reported, not fatal).
    for name_col, id_col, master in NAME_CHECKS:
        ref = frames[master].set_index(id_col)[name_col]
        for sheet, df in frames.items():
            if sheet in (master, "__team__") or name_col not in df.columns or id_col not in df.columns:
                continue
            d = df[[id_col, name_col]].dropna()
            bad = d[d[name_col] != d[id_col].map(ref)]
            if len(bad):
                problems.append(f"{sheet}: {len(bad)} rows where {name_col} differs from {master} "
                                f"for the same {id_col} (IDs used)")

    # Type conversion.
    for sheet, (table, key, cols, dt_cols, date_cols) in SHEETS.items():
        df = frames[sheet][cols].copy()
        for c in dt_cols:
            df[c] = to_ist(df[c])
        for c in date_cols:
            df[c] = pd.to_datetime(df[c]).dt.date
        frames[sheet] = df.astype(object).where(pd.notna(df), None)
    return frames, report, problems


def run_sql_file(cur, path: Path):
    cur.execute(path.read_text())


def copy_rows(cur, schema: str, table: str, cols: list[str], df: pd.DataFrame):
    with cur.copy(f"copy {schema}.{table} ({', '.join(cols)}) from stdin") as cp:
        for row in df.itertuples(index=False, name=None):
            cp.write_row(row)


def load(conn, schema: str, frames: dict):
    with conn.cursor() as cur:
        cur.execute("select set_config('app.bulk', 'on', true)")
        for t in ["checkins", "registration_history", "registrations", "interactions", "people",
                  "daily_marketing", "targets", "event"]:
            cur.execute(f"delete from {schema}.{t}")
        if schema == "original":
            cur.execute("delete from original.campaigns")
            cur.execute("delete from original.team")
        team = frames["__team__"]
        if schema == "original":
            copy_rows(cur, schema, "team", ["owner_id", "owner_name"], team)
        else:
            for oid, name in team.itertuples(index=False, name=None):
                cur.execute("insert into public.team values (%s, %s) on conflict (owner_id) "
                            "do update set owner_name = excluded.owner_name", (oid, name))
        for sheet in LOAD_ORDER:
            table, key, cols, _, _ = SHEETS[sheet]
            df = frames[sheet]
            if table == "campaigns" and schema == "public":
                cur.execute("delete from public.campaigns c where not (c.campaign_id = any(%s))",
                            (list(df.campaign_id),))
                for row in df.itertuples(index=False, name=None):
                    sets = ", ".join(f"{c} = excluded.{c}" for c in cols[1:])
                    cur.execute(f"insert into public.campaigns ({', '.join(cols)}) values "
                                f"({', '.join(['%s'] * len(cols))}) on conflict (campaign_id) do update set {sets}",
                                row)
                continue
            copy_rows(cur, schema, table, cols, df)
        cur.execute(f"select setval(pg_get_serial_sequence('{schema}.targets', 'version_id'), "
                    f"greatest((select max(version_id) from {schema}.targets), 1))")
        cur.execute("select set_config('app.bulk', 'off', true)")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("mode", choices=["init", "migrate", "working"])
    ap.add_argument("workbook", nargs="?", default=str(DEFAULT_WORKBOOK))
    ap.add_argument("--db-url", default=os.environ.get("DATABASE_URL"))
    ap.add_argument("--fresh", action="store_true", help="init only: drop all schemas first (deletes tasks)")
    args = ap.parse_args()
    if not args.db_url:
        raise SystemExit("Give --db-url or set DATABASE_URL")

    if args.mode == "migrate":
        print(f"Connecting to {describe(args.db_url)}")
        with psycopg.connect(args.db_url) as conn, conn.cursor() as cur:
            cur.execute("set search_path to public")
            for f in ("app_tables.sql", "metrics.sql", "analytics.sql", "seed_bets.sql"):
                run_sql_file(cur, ROOT / "db" / f)
                print(f"  applied db/{f}")
            conn.commit()
        print("Done (migrate).")
        return 0

    path = Path(args.workbook)
    frames, report, problems = read_workbook(path)
    print(f"Read {path.name}")
    for r in report:
        print(f"  {r['sheet']:24s} read {r['rows_read']:6d}  duplicates removed {r['duplicate_rows_removed']:3d}"
              f"  conflicting IDs {r['conflicting_ids']:3d}  loaded {r['rows_loaded']:6d}")
    for p in problems:
        print("  WARNING:", p)

    run_id = uuid.uuid4().hex[:12]
    print(f"Connecting to {describe(args.db_url)}")
    with psycopg.connect(args.db_url) as conn:
        with conn.cursor() as cur:
            if args.mode == "init":
                if args.fresh:
                    cur.execute("drop schema if exists original cascade")
                    cur.execute("drop schema if exists public cascade")
                    cur.execute("create schema public")
                cur.execute("create schema if not exists original")
                for schema in ("original", "public"):
                    cur.execute(f"set search_path to {schema}")
                    run_sql_file(cur, ROOT / "db" / "source_tables.sql")
                cur.execute("set search_path to public")
                run_sql_file(cur, ROOT / "db" / "app_tables.sql")
                run_sql_file(cur, ROOT / "db" / "metrics.sql")
                run_sql_file(cur, ROOT / "db" / "analytics.sql")
                load(conn, "original", frames)
                cur.execute("select reset_to_original('system')")
                # Bets reference team members, so seed them only after reset_to_original
                # has copied the team into public (on a new database it is empty before).
                run_sql_file(cur, ROOT / "db" / "seed_bets.sql")
                target = "original"
            else:
                cur.execute("set search_path to public")
                load(conn, "public", frames)
                cur.execute("insert into change_log (actor, table_name, action, note) values "
                            "('user', '*', 'import', %s)", (f"Working data replaced from {path.name}",))
                target = "public"
            for r in report:
                cur.execute("insert into public.import_report (run_id, target_schema, source_file, sheet, rows_read, "
                            "duplicate_rows_removed, conflicting_ids, rows_loaded, notes) values "
                            "(%s, %s, %s, %s, %s, %s, %s, %s, %s)",
                            (run_id, target, path.name, r["sheet"], r["rows_read"], r["duplicate_rows_removed"],
                             r["conflicting_ids"], r["rows_loaded"], r["notes"]))
        conn.commit()
    print(f"Done ({args.mode}, run {run_id}).")


if __name__ == "__main__":
    sys.exit(main())
