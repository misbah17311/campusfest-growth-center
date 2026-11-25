# CampusFest Growth Center

RISA Labs · Growth APM assignment · **Challenge A: attendee growth** · festival city: **Pune**

- **Live product:** _link added at deployment_
- **Three-slide strategy (PDF):** _link added when final_
- **Author:** Md Misbah Ur Rahman

> **Status:** work in progress. The product, data layer and tests below are complete; the strategy sections (marked _to be completed_) are being finalised.

---

## Contents
1. [In one minute](#1-in-one-minute)
2. [What the product does](#2-what-the-product-does)
3. [How every number is computed](#3-how-every-number-is-computed)
4. [Architecture and why](#4-architecture-and-why)
5. [The AI growth copilot](#5-the-ai-growth-copilot)
6. [Testing and verification](#6-testing-and-verification)
7. [Strategy: target, bets, signals](#7-strategy-target-bets-signals)
8. [Research, sources and assumptions](#8-research-sources-and-assumptions)
9. [Setup](#9-setup)
10. [Tools used, and what was reused, modified and verified](#10-tools-used-and-what-was-reused-modified-and-verified)
11. [Known limitations](#11-known-limitations)

---

## 1. In one minute

- The supplied data is last year's festival (CampusFest 2025). It **hit its awareness goal (3,625 identified people against 3,600) but missed attendance (2,050 verified visitors against 2,200)**. The problem was not reach; it was what happened after people raised their hand.
- **Where people were lost:**
  - 575 of 2,500 confirmed registrants never got a verified admission. 60 of them reached the gate and were denied or left unverified, all from one campaign (Campus Ambassadors).
  - 88 people stayed waitlisted.
  - 275 abandoned the registration form.
  - 55% of spend went to the two channels whose confirmed registrants showed up least: Paid Social 58.6% and Creator Partners 60.3%, against 81–92% for peer and group channels.
- The product is the command centre a festival team would use to run the next campaign:
  - measure the funnel against the plan in force on any day;
  - diagnose where and why people drop out;
  - decide scale, change or stop by pre-committed thresholds;
  - manage tasks and edits;
  - ask an AI analyst that answers only from the live data and turns recommendations into tasks after you confirm.

## 2. What the product does

A global **"as of" date** (any day from 15 Jan to 20 Apr 2025) replays the 2025 campaign as if it were live. Every page and every copilot answer is computed for the end of that day, India time, and never uses anything that happened later.

| Page | What it answers |
|---|---|
| **Overview** | Funnel against the goals in force; spend against budget; cumulative pace; projection to the event (before it happens); what needs attention |
| **Campaigns** | Per-campaign scorecard (spend, CTR, identified, registered, confirmed, visitors, conversion, show-up, cost per registration and per verified visitor, decision); weekly heatmap of registrations, spend or cost per registration |
| **Diagnose** | Each campaign's conversion at each stage against all campaigns combined; where people leave the funnel, overall and by campaign; the gate-loss finding; show-up by how early people registered; data quality (what was excluded and why); what the data cannot tell you |
| **Decide** | Scale/keep/change/stop per campaign from editable, pre-committed thresholds, with the evidence; a budget what-if using the same model as the target; the strategic bets with their KPIs and thresholds |
| **Execute** | Tasks (owner, due date, status, priority, linked campaign or bet, created by a person or the copilot); campaign status, owner and planned budget; plan versions (targets and constraints, dated); daily spend corrections; reset to the original data; the change log; the import report |
| **Copilot** (panel on every page) | Answers questions from live data through tools, shows the steps it took, and proposes tasks or campaign changes as cards you confirm |

**Changes flow everywhere.** Every edit is saved to Postgres and recorded in the change log, with who made it and the before and after values. Every number on every page recomputes from the database on the next request. A banner appears whenever the working data differs from the original workbook, and **Reset** restores it exactly; tasks and bets are kept.

### The insight-to-action workflow (demo)
1. On **Overview** (as of 20 Apr), "Needs attention" flags Paid Social and Creator Partners to stop, and Campus Ambassadors to change because of the gate losses.
2. Ask the copilot: *"Why did we miss the visitor goal?"* It reads the funnel, the leaks and the decisions, and answers with the numbers and the date.
3. Follow up: *"What should we do about Paid Social?"* It recommends, with the evidence and the trade-off, and can run the budget what-if.
4. Follow up: *"Create a task for Arjun to cut it to retargeting by next week."* A **proposed task card** appears, and nothing is saved yet. Click **Confirm**: the task appears on **Execute**, marked "from copilot", with the evidence attached, and the change log records it.
5. Ask something the data cannot answer: *"Which Pune colleges did our visitors come from?"* It says plainly that there is no location or college field, and what data would be needed.

## 3. How every number is computed

All metric logic lives in **SQL functions** (`db/metrics.sql`, `db/analytics.sql`) that take an as-of date. The dashboard and the copilot call the same functions, so they cannot disagree.

**Rules applied (each from the dataset's Read me / field guide, each tested):**

| Rule | Effect on the 2025 data |
|---|---|
| Import-retry duplicates (same ID, identical row) count once | 2 rows removed in Daily Marketing, 4 in Registration History, 20 in Check-ins; no conflicting IDs |
| A **visitor** is an *external* person with an *admitted and verified* check-in, counted once | 2,050 visitors. Counting distinct people in raw check-ins would give 2,150; excluded are 40 internal, staff and test people and 60 externals with only denied or pending records |
| Status = **latest version at or before the end of the selected day** | e.g. 15 Mar: 1,279 confirmed; 20 Apr: 2,500 |
| **Nothing after the cutoff** is used | Before 12 Apr there are no visitors and show-up is undefined (shown as "—", not 0%) |
| The **plan in force** is the latest version starting on or before the date | Launch plan to 14 Mar; revised plan (budget ₹2.4L → ₹3.0L, goals raised) from 15 Mar |
| Spend is **net** | 4 vendor-credit rows (₹6,500) subtract on their posting date |
| Impressions, clicks, reach and sessions are **anonymous events**, never people | Never summed into "people reached" |
| Attribution is the **recorded source** | Each person has exactly one campaign (0 mismatches across 17,690 rows), so multi-touch attribution is impossible, and the copilot says so |

**Decision rules (Decide page).** Each campaign is compared with all campaigns combined:
- **Before the event:** cost per registration, confirmation rate, form completion and nurture opt-out rate.
- **After it:** cost per verified visitor, show-up and gate losses.

Confirmation and form completion are judged **only on cohorts at least 7 days old**: in 2025, 95% of confirmations came within 4.1 days of registering. Without that, every campaign looks bad mid-campaign simply because its newest registrants have not confirmed yet. Applied to the 2025 data **as of 15 March, four weeks before the event**, the rules already say stop Creator Partners and change Paid Social.

**Projection (before the event)** uses only data up to the selected day:
- the last 14 days' registration pace;
- a visitors-per-registration ratio that, by default, is the plan's own (visitor goal ÷ registration goal; 68.75% under the revised plan), or an editable assumption.

It never uses the event's own outcome.

## 4. Architecture and why

```
Browser: five pages + copilot panel (Next.js, React)
      │  server components / server actions / API routes (Vercel)
      ├──────────────────────────────► Fireworks AI (LLM, tool calling)
      ▼
Postgres (Neon)
  ├─ public.*    working copy of the 9 source sheets + team   ◄── edits (change-log trigger)
  ├─ original.*  pristine copy, used by "Reset to original"
  ├─ tasks, initiatives, decision_rules, assumptions, change_log, import_report, copilot_log
  └─ SQL metric functions taking an as-of date  ◄── used by the dashboard AND the copilot
```

| Choice | Why | Alternative rejected |
|---|---|---|
| Next.js 16 on Vercel (Hobby) | One deployment for pages and server code; no sleeping servers | Streamlit: editable tables and confirm-before-create flows are awkward, and free apps sleep |
| Postgres on Neon | The free tier never pauses for inactivity | Supabase free projects pause after a week idle, so a reviewer could find a dead link |
| Metric logic in SQL | One definition for dashboard and copilot; readable and testable | Duplicating logic in TypeScript |
| Change log by database trigger | No code path can forget to log; records the actor (user or copilot) | Logging in application code |
| A small hand-written tool loop on the OpenAI-compatible API | I can read and defend every step; the provider can be swapped | A framework whose tool API changed recently |

## 5. The AI growth copilot

**Grounding.** The model gets no data in its prompt beyond the team and campaign lists. It has 16 tools:

| Group | Tools |
|---|---|
| Read the same SQL functions as the dashboard | `get_overview`, `get_campaign_metrics`, `get_trend`, `get_funnel_leaks`, `get_decisions`, `get_showup_by_lead_time`, `get_plan`, `get_tasks_and_bets`, `get_change_log` |
| Explain the data and its limits | `describe_data`: definitions, rules, the list of questions the data cannot answer, and the schema for custom queries |
| Unfamiliar questions | `run_sql`: one read-only `SELECT` in a read-only transaction, 4-second timeout, 200-row cap, dangerous keywords refused, writes impossible |
| Arithmetic | `calculate`: an exact parser for every derived number, because language models make arithmetic slips |
| Planning | `what_if_budget`: the same model as the target, with its assumptions stated |
| Actions | `propose_task`, `propose_task_update`, `propose_campaign_update`: these never write. They return a card; only the user's **Confirm** applies it, and the server re-validates it. The change log records the actor as "copilot" |

**Behaviour it is instructed to follow:**
- every number comes from a tool, and it says which date the numbers are for;
- it separates evidence from hypotheses and says when correlation is not causation;
- when the data cannot answer, it says so first, explains why, and names the data that would answer it;
- it never claims an action happened.

**Transparency.** Each answer has a "How I got this" list of the data steps it took. Every question, answer, tool trace and token count is stored in `copilot_log`.

**Model choice and evaluation:** _to be completed with the evaluation results (models compared on the same question set, pass rates by category, cost per question)._

## 6. Testing and verification

| Test | What it proves | Result |
|---|---|---|
| `analysis/reconcile.py` | Every metric is computed twice, by the SQL and by an independent pandas implementation reading the workbook directly, at 10 dates including both sides of the plan change and each festival day | **1,980 values, 0 mismatches** |
| `tests/test_sql_consistency.py` | Populations add up across functions (e.g. identified = registered + abandoned form + never started; confirmed = came + lost at gate + did not come; all 96 daily rows equal the funnel for that day) | **36 checks, 0 failures** |
| `tests/test_db_edits.py` | Edits flow only where they should; a change dated 11 Apr does not leak into 10 Apr; reset restores every metric exactly and keeps tasks | **21 checks, 0 failures** |
| `tests/e2e_ui.mjs` | In a real headless browser: create a task, change its status, edit a day's spend (Overview moves by exactly that amount), tighten a threshold (a decision flips), reset, check the change log | **11 checks, 0 failures** |
| `tests/eval_copilot.mjs` | The copilot on a question set written independently of the implementation (see 5) | _to be completed_ |

Two limits of this testing, stated plainly:
- The SQL and pandas implementations were written by the same person. Agreement catches coding mistakes, not a misreading of the rules; the rules are therefore listed with their source above.
- The browser test runs against a local copy of the database, not the live deployment.

## 7. Strategy: target, bets, signals

_To be completed: the target model (base and stretch, every input tagged sourced / derived / assumed), the five ranked bets with their contribution, budget and thresholds, and the leading indicators. The model is `analysis/target_model.py`; its full output is in `analysis/output/target_model.txt`._

## 8. Research, sources and assumptions

_To be completed with the verified source list._ Figures already checked against the primary document:
- **Pune district has 517 colleges, the third most in India** (AISHE 2023-24, Ministry of Education, §2.1.2.1).
- **Pune district had 13,91,822 people aged 18–24** (Census 2011, Table C-13).
- **Median no-show is about 28% at free events and about 17% at paid events**, but within the same event payers show up only 2–4 points more reliably (PheedLoop Event Data Lab reports #05 and #06, 2026).
- **Plain date-and-time text reminders raised attendance by about 7 points from a 58% baseline** (randomised trial; Mathematica/OPRE 2022).

## 9. Setup

Requirements: Node 20+, Python 3.11+, Docker (for a local Postgres) or any Postgres 15+.

```bash
# 1. Database (local, Docker, port 5433)
docker run -d --name risa-pg -e POSTGRES_PASSWORD=devpass -e POSTGRES_DB=campusfest \
  -p 127.0.0.1:5433:5432 -v risa-pgdata:/var/lib/postgresql/data postgres:17

# 2. Load the workbook and check the numbers
python3 -m venv .venv && .venv/bin/pip install -r analysis/requirements.txt
LOCAL=postgresql://postgres:devpass@127.0.0.1:5433/campusfest
.venv/bin/python db/load_workbook.py init --fresh --db-url $LOCAL   # schema, functions, original + working copies
.venv/bin/python analysis/reconcile.py --db-url $LOCAL              # SQL vs pandas: expect 0 mismatches
.venv/bin/python tests/test_sql_consistency.py --db-url $LOCAL
.venv/bin/python tests/test_db_edits.py --db-url $LOCAL

# 3. App
echo "DATABASE_URL=$LOCAL" > .env.development.local
echo "FIREWORKS_API_KEY=..." >> .env.local          # optional: enables the copilot
npm install && npm run dev                           # http://localhost:3000

# 4. Browser test (with the dev server running)
npx playwright install chromium
BASE_URL=http://localhost:3000 DATABASE_URL=$LOCAL node tests/e2e_ui.mjs
```

Schema or function changes on a live database: `db/load_workbook.py migrate` re-applies tables, triggers and functions without touching data. To replace the working data with an edited workbook in the same format: `db/load_workbook.py working edited.xlsx` (the original copy and tasks are kept).

**Deployment:** Vercel (Hobby) with a Neon Postgres database attached through Vercel Storage. Set `FIREWORKS_API_KEY` (and optionally `FIREWORKS_MODEL`) in the project's environment variables, then run `db/load_workbook.py init` once against the Neon connection string.

## 10. Tools used, and what was reused, modified and verified

- **Claude Code** (Anthropic, Claude Opus 5.5 / Fable 5.2) as a pair programmer and research assistant: it wrote most of the code and drafts under my direction. I set the direction, made the decisions recorded here, reviewed the work, and checked the load-bearing numbers against their sources. Research sub-agents gathered Pune and benchmark sources; every figure used in the strategy was re-checked against its primary source, and figures that could not be are labelled.
- **Fireworks AI** serverless models for the copilot (OpenAI-compatible API).
- **Next.js 16** (create-next-app scaffold), **React 19**, **Tailwind CSS 4**, **Recharts 3**, **react-markdown**, **zod**, **node-postgres**, the **openai** SDK (pointed at Fireworks).
- **Python**: pandas, openpyxl, psycopg 3. **Postgres 17** (local Docker) / **Neon** (production). **Playwright** for the browser test.
- **Reused:** the Next.js scaffold and the libraries above. **Written for this project:** schema, loader, every SQL function, the reference implementation, tests, pages, copilot tools and loop, and the target model.

## 11. Known limitations

- **One shared workspace.** There is no login, so reviewers share one copy of the working data. The change log, the "data was edited" banner and **Reset** make this safe, but two people editing at once will see each other's changes.
- **Projections before the event** rest on an assumed visitors-per-registration ratio, because the dataset has no earlier year to learn show-up from. The default is the plan's own ratio, and it can be edited.
- **The budget what-if and the target model extrapolate.** Assuming registrations scale with spend to the power beta is a modelling choice; 2025 shows each channel at only one budget level. The sensitivity to beta is reported, not hidden.
- **The data cannot answer:**
  - location, demographics and colleges;
  - unique reach;
  - causal effects of the nurture emails (no comparison group);
  - why people were denied at the gate;
  - multi-touch attribution.

  The copilot says so.
- **The copilot can still be wrong** (for example, by misreading a question). The tool trace on every answer and the stored logs make that checkable, and the evaluation results are reported with failures included.
