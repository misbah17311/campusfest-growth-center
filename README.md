# CampusFest Growth Center

RISA Labs · Growth APM assignment · **Challenge A: attendee growth** · festival city: **Pune**

- **Live product:** https://campusfest-growth-center-theta.vercel.app (no login; open the copilot from the button at the bottom right)
- **Three-slide strategy (PDF):** [`slides/CampusFest_Growth_Strategy_Misbah_Ur_Rahman.pdf`](slides/CampusFest_Growth_Strategy_Misbah_Ur_Rahman.pdf)
- **Author:** Md Misbah Ur Rahman

> **Status:** complete. The live site reads a Neon copy of the original workbook, verified against the pandas reference (2,050 values, 0 mismatches).

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

Confirmation and form completion are judged **only on cohorts at least 7 days old**: in 2025, 95% of confirmations came within 4.1 days of registering. Without that, every campaign looks bad mid-campaign simply because its newest registrants have not confirmed yet. Applied to the 2025 data **as of 15 March, four weeks before the event**, the rules say stop Creator Partners; change Paid Social and Student Referrals; keep College Partnerships; scale Ambassadors, Organic and Community. The first two calls were right (those channels ended at ₹274–337 per visitor). The rest show the rules' blind spot: before the event they cannot see show-up, so they only kept Partnerships (91.7% show-up in the end) and scaled Ambassadors (all 60 gate losses). The 2027 plan therefore divides pre-event cost by each channel's 2025 show-up (see 7).

**Projection (before the event)** uses only data up to the selected day:
- the last 14 days' registration pace;
- a visitors-per-registration ratio that, by default, is the plan's own (visitor goal ÷ registration goal; 68.75% under the revised plan), or an editable assumption.

It never uses the event's own outcome. Backtest against the actual 2,800 registrations: the projection was 2,775 on 1 Mar (−1%), 2,368 on 15 Mar (−15%) and 2,882 on 1 Apr (+3%). Single readings are noisy, so the playbook acts only on two readings in a row.

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

**Cost control.** In production the chat endpoint allows 30 questions per 10 minutes per visitor; a full answer costs about $0.0035 (see below).

**Model choice and evaluation.** The question set (`tests/copilot_questions.json`: 64 questions, 81 turns with follow-ups) was written by a separate AI agent that was given the brief and the dataset but never saw the code. It covers facts, comparisons, as-of dates, diagnosis, recommendations, execution, questions the data cannot answer, multi-turn conversations and answers after the data has been edited. For 38 items the expected numbers are computed independently from the workbook (`tests/expected_answers.py`) and checked automatically (`tests/grade_copilot.py`). The other 26 need judgement, and I read every answer.

| | DeepSeek V4.1 Flash (shipped) | GLM 5.3 |
|---|---|---|
| Automatic checks | **38/38** on the final run (36/38 on its first run) | 36/38 (run before the tool fixes below) |
| Errors | 0 | 0 |
| Latency per turn, median / p90 | 9.3 s / 23 s | 9.7 s / 32 s |
| Cost of the full 81-turn run | **$0.29** (72% of input tokens served from cache) | about $2.39 (no cache hits reported) |
| Fireworks price per 1M tokens: input / cached / output | $0.30 / $0.006 / $1.20 | $1.40 / $0.26 / $4.40 |

The two models were equally accurate, so the cheaper one ships (`FIREWORKS_MODEL` switches it). Failures were fixed in the tools, not by tuning answers to the questions:
- F08 (reach) and C08 (a campaign's daily spend) failed on GLM because the tools lacked reported reach and per-campaign daily rows. Both were added, and every tool result now states its scope (which campaigns it covers).
- F07 counted people "never admitted" when asked for people "denied". The leaks tool now separates them (50 denied, 20 of them later admitted; 30 more left pending).
- CD04 omitted the remaining budget once and passed on the rerun without a change: run-to-run variation.
- Earlier runs also exposed empty replies, invalid tool arguments and an unknown owner being assigned silently; the loop and the instructions now handle each.

**Judgement items (final run, read by hand):**
- **Cannot answer (8/8 correct):** each says so in the first sentence, names the missing field and offers the closest question the data can answer.
- **Execution (4/4):** every action is a card awaiting Confirm; it flags that "the social media intern" is not on the team and that no referral task exists, and revises a proposal on follow-up.
- **Diagnosis (8) and recommendations (6):** grounded and dated, with assumptions labelled. Slips: D01 could not explain 125 of the 825 people who never registered (they were walk-ins; the leaks tool now returns that reconciliation, and a rerun of D01 states 825 = 425 + 275 + 125); U07 offered to compare arrivals with a venue capacity that is not set; R06 said the play was attendance, not acquisition, then also proposed a budget move one day before day 2.

## 6. Testing and verification

| Test | What it proves | Result |
|---|---|---|
| `analysis/reconcile.py` | Every metric is computed twice, by the SQL and by an independent pandas implementation reading the workbook directly, at 10 dates including both sides of the plan change and each festival day | **2,050 values, 0 mismatches** |
| `tests/test_sql_consistency.py` | Populations add up across functions (e.g. identified = registered + abandoned form + never started; confirmed = came + lost at gate + did not come; all 96 daily rows equal the funnel for that day) | **36 checks, 0 failures** |
| `tests/test_db_edits.py` | Edits flow only where they should; a change dated 11 Apr does not leak into 10 Apr; reset restores every metric exactly and keeps tasks | **21 checks, 0 failures** |
| `tests/e2e_ui.mjs` | In a real headless browser: create a task, change its status, edit a day's spend (Overview moves by exactly that amount), tighten a threshold (a decision flips), reset, check the change log | **11 checks, 0 failures** |
| `tests/eval_copilot.mjs` + `tests/grade_copilot.py` | The copilot on 64 questions written independently of the implementation (see 5) | **38/38 automatic checks; 26 judgement items read by hand, slips listed in 5** |

Two limits of this testing, stated plainly:
- The SQL and pandas implementations were written by the same person. Agreement catches coding mistakes, not a misreading of the rules; the rules are therefore listed with their source above.
- The browser test runs against a local copy of the database, not the live deployment.

## 7. Strategy: target, bets, signals

The three slides are in [`slides/`](slides/) (PDF plus the HTML they are rendered from). In short:

### Target (slide 1)
**Aim for 3,619 verified visitors (+77% on the 2025 edition); commit to 2,906**, on the same ₹3.0 lakh budget (rounded on the slide to 3,620 and 2,900). The festival is CampusFest 2027 in Pune on Sat–Sun 6–7 March.

**The biggest assumption:** the supplied 2025 data does not name a city. The plan treats its channel costs, conversion and show-up as a fair starting point for Pune in March 2027. The week-3 lines on slide 3 exist to test that early.

The model is `analysis/target_model.py`; its full output is in `analysis/output/target_model.txt`.
- **Start:** each channel's 2025 funnel, all derived from the data: registrations per rupee, confirmation rate, waitlist share, form abandonment, and no-show split into "did not come" and "lost at the gate".
- **Re-budget:** registrations scale as `(new spend ÷ 2025 spend)^β`, with β below 1 for diminishing returns.
- **Win back 2025's people:** a new channel with no 2025 history. Its audience is derived: 2,564 people who came or confirmed in 2025, minus the 61 who opted out. Registrations = audience × share still reachable × incremental registration rate (net of people who would have come through another channel anyway). Confirmation and show-up are the 2025 peer-and-group average.
- **Fix the leaks:** recover form abandoners, auto-release the waitlist, add reminders and reconfirmation, fix the gate.
- **Reach end of the funnel:** the people to identify and the impressions behind them, at each channel's 2025 ratios.
- **Built-in check:** with 2025 spend and every lever off, the model reproduces 2,050 visitors and 3,625 identified people exactly.

| | 2025 | Base | Stretch |
|---|---|---|---|
| Impressions (anonymous events) | 10.29 lakh | 10.57 lakh | 11.45 lakh |
| Identified people | 3,625 | 5,169 | 5,900 |
| Registered people | 2,800 | 3,520 | 4,118 |
| Confirmed | 2,500 | 3,248 | 3,852 |
| Confirmed who came (show-up) | 1,925 (77.0%) | 2,781 (85.6%) | 3,444 (89.4%) |
| + Walk-ins (no registration) | 125 | 125 | 175 |
| **Verified visitors** | **2,050** | **2,906** | **3,619** |
| ₹ per verified visitor | 134 | 103 | 83 |

About the same reach buys 43% more identified people, because the money moves from ads to people we can name. ₹ per verified visitor counts all visitors, walk-ins included; per campaign-sourced visitor, 2025 cost ₹142, the "blended" cost the Decide page compares campaigns with.

| Input | Base | Stretch | Tag and evidence |
|---|---|---|---|
| β, paid reach / peer and group channels | 0.5 / 0.7 | 0.6 / 0.9 | Assumed. Paid Social cost per registration rose ₹113 → ₹199 from Feb to Mar 2025, while Ambassadors (₹106 → 66), College Partnerships (₹114 → 53) and Referrals (₹177 → 46) got cheaper (derived; monthly ratios are rough because spend and registrations are not aligned in time) |
| Cut in "did not come" from reminders and reconfirmation | 10% | 25% | Assumed. Plain date-and-time reminders raised attendance by about 7 points from 58% in a randomised trial (OPRE Report 2022-49), roughly a 17% cut in no-shows |
| Gate losses recovered | 50% | 90% | Assumed. 60 named people from one channel, one scanner flow (derived) |
| Waitlist released / form abandoners recovered | 50% / 20% | 90% / 40% | Assumed. 88 waitlisted, 275 abandoned forms (derived) |
| 2025 people still reachable / won back by the message | 40% / 10% | 50% / 20% | Assumed, with no evidence: two years on, many have graduated or left. Hence Low confidence and a 20% holdout read after 7 days |

**How the gain builds up:**

| Step | Base | Stretch |
|---|---|---|
| 2025 actual | 2,050 | 2,050 |
| Move money to peer and group channels | +615 | +949 |
| Win back 2025's people | +84 | +209 |
| Recover form abandoners | +36 | +79 |
| Auto-release the waitlist | +37 | +76 |
| Reminders and reconfirmation | +48 | +133 |
| Gate fix | +37 | +72 |
| Walk-ins | 0 | +50 |
| **Total** | **2,906** | **3,619** |

**Stress tests on the base** (in `target_model.txt`):

| Test | Visitors |
|---|---|
| Base as planned | 2,906 |
| Peer-channel β 0.5 instead of 0.7 | 2,588 |
| In channels whose spend grows, show-up regresses halfway to the 2025 average (newly reached people are less committed) | 2,777 |
| The ₹25k reserve is never released | 2,722 |
| All three together | **2,370** |

Even the combined case beats 2025's 2,050 and its 2,200 goal. The full peer-β range 0.4 to 1.0 gives about 2,450 to 3,510. β is the assumption the plan tests first (week-3 lines on bets 2 and 3). The commitment is the base case; the stress tests show how far it can fall.

**The reserve.** Partnerships (₹82.5k) and referrals (₹57.5k) each hold back ₹12.5k until week 4. Each gets its share only if its scale line holds; a share not earned goes to the next bet past its scale line. The base case assumes the reserve is released.

**Checks:**
- **Market:** 3,619 is 0.4% of Pune district's urban 18–24 population of 8.7 lakh (Census 2011).
- **Comparables:** 3,619 visitors is about 4,900 entries over two days, since 35% came on both days in 2025. Pune college fests claim 6,000–40,000 "footfall", but those figures are self-reported and cumulative.
- **Capacity:** the gate binds, not the ground. The busiest hour needs about 440 admissions an hour against 251 in 2025, so gate throughput must rise about 1.8×. The busier day brings about 2,500 people; for comparison, police cleared an event of an estimated 8,000–10,000 at the SSPMS College ground in Shivajinagar in August 2026. No venue is booked yet; police permission is applied for first (NH7 Weekender 2024 was cancelled when it was refused).

### Bets (slide 2)
**Ranking:** score = extra verified visitors per ₹1,000 of new money × confidence in the evidence (High 1.0, Medium-high 0.8, Medium 0.6, Low 0.4). Each bet is scored on its own, on top of 2025, so the ranking does not depend on the order bets are applied in. A near-tie (referrals 5.02, ambassadors 4.99) goes to the faster test. Team time is a constraint rather than a score term: the same four owners run everything. Contributions are then applied in rank order, so they add up to the total (base / stretch):

| # | Bet | Visitors (alone) | New money | Confidence | Score | Visitors in rank order | Budget (2025 → plan) | Owner |
|---|---|---|---|---|---|---|---|---|
| 1 | Show-up and gate programme: reminders, 72-hour reconfirmation, waitlist release, a pre-event check of ambassador registrations, more lanes | +115 | ₹15,000 | High | 7.6 | +115 / +246 | ₹15k (new) | Nisha Rao |
| 2 | College and club partnerships with group registration | +379 | ₹51,500 | Medium-high | 5.9 | +386 / +567 | ₹31k → ₹82.5k | Meera Iyer |
| 3 | Referral rewards paid only when the friend attends | +322 | ₹38,500 | Medium | 5.0 | +332 / +502 | ₹19k → ₹57.5k | Dev Malhotra |
| 4 | Campus ambassadors paid per verified attendee, only for registrations that pass bet 1's check | +81 | ₹13,000 | Medium-high | 5.0 | +89 / +127 | ₹42k → ₹55k | Meera Iyer |
| 5 | Win back 2025's people: a personal invite (early access, a fast lane at the gate) to the 2,564 who came or confirmed, with a 20% holdout | +84 | ₹10,000 | Low | 3.4 | +86 / +220 | ₹10k (new) | Arjun Verma |
| | Paid for by: Paid Social to retargeting only (form abandoners, page visitors), which also carries form-abandoner recovery | | | | | −120 / −110 | ₹93k → ₹30k | Arjun Verma |
| | Paid for by: Creators to tracked performance codes | | | | | −118 / −152 | ₹59k → ₹10k | |
| | Organic, listings and Community grow modestly (organic search is capped by demand, so extra rupees buy little even though the model's β would say otherwise) | | | | | +86 / +120 | ₹30k → ₹40k | |
| | Walk-ins | | | | | 0 / +50 | | |

The win-back budget pays for WhatsApp marketing messages (₹0.86 each plus GST under Meta's India rates) to about 2,000 people (the 80% not held out), three messages each, plus email.

**Rejected or deprioritised:**
- **Creator Partners as run:** ₹337 per verified visitor and 60% show-up.
- **Paid tickets or deposits:** within the same event, payers show up only 2–4 points more reliably (PheedLoop Event Data Lab #06, 195 events).
- **A big-name headliner:** a large share of the budget for an unmeasured effect.
- **More cold paid reach:** it was already saturating during the 2025 campaign.

The five bets, with their KPIs and thresholds, are stored in the product (Decide → Strategic bets; `db/seed_bets.sql`).

### Signals (slide 3)
- Every bet has a critical variable, an early signal in weeks 1–3, and scale / change / stop lines with no gaps between them.
- Cost lines are relative: cost per registration ÷ the all-campaign blended cost in the same period, so expensive early weeks do not trip them. Bets stop at 1.3×, tighter than the campaign default of 1.6×, because they carry extra money.
- Rates are judged only on cohorts at least 7 days old, and holdouts are kept where possible.
- **2027 attendance forecast:** confirmed registrants per channel × that channel's 2025 show-up. **2027 pre-event decisions:** cost per registration ÷ the channel's 2025 show-up (cost per expected visitor), so a cheap channel whose people do not come is not scaled. The 2025 replay has no earlier year, so the product uses the plan's ratio and plain cost per registration (see 11).
- Replaying 2025 **as of 15 March**: the rules' full verdict and what it missed are in 3. Every projection from 15 March on was below the 3,200 goal (2,368 on 15 Mar, 2,882 on 1 Apr; actual 2,800).

## 8. Research, sources and assumptions

Every figure used in the strategy was checked against its primary document. Copies of the downloadable ones are kept outside the repository (`research/sources/`).

| Figure | Source | Checked |
|---|---|---|
| Pune district has 517 colleges, the 3rd most in India (after Bengaluru Urban 1,148 and Jaipur 742; Hyderabad 465) | [AISHE 2023-24 final report](https://cdnbbsr.s3waas.gov.in/s392049debbe566ca5782a3045cf300a3c/uploads/2026/07/202607131602421770.pdf), §2.1.2.1 (Ministry of Education) | PDF, p. 36 |
| Pune district: 13,91,822 people aged 18–24, of whom 8,71,194 urban | [Census 2011, Table C-13](https://censusindia.gov.in/nada/index.php/catalog/1457) (Maharashtra), DDW-2700C-13 | Summed from the single-year rows |
| Mean max temperature (Shivajinagar): 32.5°C Feb, 35.6°C Mar, 38.1°C Apr | IMD, [*Climatology of Pashan*](https://imdpune.gov.in/library/Climatology%20of%20Pashan_ebook.pdf), CRS Technical Report 2/2021, Table 3 (1999–2018 means) | PDF, printed p. 17 |
| SPPU summer exams for UG humanities programmes start 23 Mar 2027 | [SPPU examination schedules](https://exam.unipune.ac.in/Pages/SchedulesTimetables.html), AY 2026-27 (tentative) | Circular PDF. Private and autonomous universities (MIT-WPU, Symbiosis, COEP) set their own calendars: to confirm before fixing the date |
| Median no-show about 28% at free events and 17% at paid events; within the same event, payers attend only 2–4 points more | PheedLoop Event Data Lab [#05](https://pheedloop.com/blog/event-data-lab-report-5) and [#06](https://pheedloop.com/blog/event-data-lab-report-06) (2026) | Pages read; vendor data, conference-heavy |
| Plain date-and-time text reminders raised first-session attendance by about 7 points from 58% | [OPRE Report 2022-49 (Mathematica)](https://www.mathematica.org/publications/text-message-reminders-and-their-impact-on-attendance-at-healthy-marriage-and-relationship-education), randomised evaluation | Page read; US free workshops, not a festival, hence used only for the base case's smaller 10% cut |
| Pune is an X-class (tier 1) city | DoE OM 2/5/2017-E.II(B), [HRA annexure](https://finance.py.gov.in/sites/default/files/hra23aug18.pdf) | Annexure scan |
| Institution sizes (e.g. MIT-WPU 22,540) | Each institution's NIRF data submission (e.g. [MIT-WPU 2026](https://mitwpu.edu.in/uploads/images/Overall-2026-NIRF-Report.pdf)) | Institution-reported; used only as an order of magnitude |
| Pune Metro: Lines 1–2 plus Line 3 (Hinjewadi–Shivajinagar, opened 4 Nov 2026), meeting at District Court, Shivajinagar; 30% student pass | [Maha Metro](https://www.punemetrorail.org/); [Railway Journal](https://www.railjournal.com/regions/asia/pune-metro-line-3-opens-for-passenger-services/) | Pages read |
| WhatsApp business messages in India: utility ₹0.115, marketing ₹0.8631 each (plus GST) | [Free Press Journal, citing Meta's rate card](https://www.freepressjournal.in/tech/how-much-does-india-have-to-pay-for-whatsapp-messages-from-october-1) | Secondary |
| NH7 Weekender 2024 (Pune) was cancelled after police refused permission | [Free Press Journal](https://www.freepressjournal.in/pune/nh7-weekender-music-fest-cancelled-in-pune-after-police-deny-permission) | Several reports agree (Dec 2024) |
| SSPMS College ground, Shivajinagar: police cleared an event of an estimated 8,000–10,000 people, with 30 conditions (Aug 2026) | [ThePrint](https://theprint.in/india/police-grant-nod-for-rahul-gandhis-chhatron-ki-gunj-event-in-pune-with-30-conditions/3019870/) | Press report; an order of magnitude, not a booked venue |
| Pune fest "footfall" (MindSpark 32,000+, Ignisense 17,000+ over three days, etc.) | Organisers' claims, e.g. [Punekar News](https://www.punekarnews.in/?p=246897), [Ignisense deck](https://siib.ac.in/wp-content/uploads/2025/01/Official-Sponsorship-Proposal-Ignisense-2025.pdf) | Self-reported; used only as a ceiling |

**Assumptions** (tagged A on the slides, stress-tested in 7): returns to spend (β); the cut in no-shows from reminders; the shares of gate losses, waitlist and form abandoners recovered; walk-ins; and that the 2025 data is a fair starting point for Pune in March 2027.

**Not found** (and therefore not used as evidence):
- an official count of college students in Pune city;
- any Indian college-fest registration-to-attendance rate;
- a credible campus-ambassador conversion benchmark;
- an official crowd-density norm. NDMA's 2014 guide says "there are no established norms".

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

**Copilot shows "Connection error" when running locally on WSL?** Some WSL networks take longer than Node's default 250 ms per address attempt to connect, so `fetch` gives up. Start the dev server with `NODE_OPTIONS=--network-family-autoselection-attempt-timeout=1000 npm run dev`. (Not needed on Vercel.)

Schema or function changes on a live database: `db/load_workbook.py migrate` re-applies tables, triggers and functions without touching data. To replace the working data with an edited workbook in the same format: `db/load_workbook.py working edited.xlsx` (the original copy and tasks are kept).

**Deployment:** Vercel (Hobby) with a Neon Postgres database attached through Vercel Storage. Set `FIREWORKS_API_KEY` (and optionally `FIREWORKS_MODEL`) in the project's environment variables, then run `db/load_workbook.py init` once against the Neon connection string.

## 10. Tools used, and what was reused, modified and verified

- **Claude Code** (Anthropic, Claude Opus 5.5 / Fable 5.2) as a pair programmer and research assistant: it wrote most of the code and drafts under my direction. I set the direction, made the decisions recorded here, reviewed the work, and checked the load-bearing numbers against their sources. Research sub-agents gathered Pune and benchmark sources; every figure used in the strategy was re-checked against its primary source, and figures that could not be are labelled.
- **Fireworks AI** serverless models for the copilot (OpenAI-compatible API).
- **Next.js 16** (create-next-app scaffold), **React 19**, **Tailwind CSS 4**, **Recharts 3**, **react-markdown**, **zod**, **node-postgres**, the **openai** SDK (pointed at Fireworks).
- **Python**: pandas, openpyxl, psycopg 3. **Postgres 17** (local Docker) / **Neon** (production). **Playwright** for the browser test.
- **Plans used:** Vercel Hobby (free); Neon free tier through Vercel Storage; Fireworks pay-as-you-go serverless inference (about $0.0035 per copilot answer); Claude Code.
- **Reused:** the Next.js scaffold and the libraries above. **Written for this project:** schema, loader, every SQL function, the reference implementation, tests, pages, copilot tools and loop, and the target model.

## 11. Known limitations

- **One shared workspace.** There is no login, so reviewers share one copy of the working data. The change log, the "data was edited" banner and **Reset** make this safe, but two people editing at once will see each other's changes.
- **Projections before the event** rest on an assumed visitors-per-registration ratio, because the dataset has no earlier year to learn show-up from. The default is the plan's own ratio, and it can be edited.
- **The 2027 rules are described, not built.** The replay has no earlier year, so its pre-event decisions use plain cost per registration and its projection uses the plan's ratio. The 2027 versions (cost per expected visitor, a per-channel show-up forecast) need last year's show-up per channel.
- **Bets are tracked as text.** Each bet's KPIs and scale / change / stop lines are stored on the bets board, but the product does not compute bet KPIs such as clubs signed or invites per registrant: the 2025 data has no such fields.
- **Win-back is a 2027 channel only.** It has no 2025 data, so it appears in the target model and on the bets board but not as a campaign in the replay.
- **The 2027 plan is not loaded as a plan version.** The product replays 2025, and a 2027 version would never be in force on a 2025 date. Venue capacity per day is an optional plan field and is empty, since no venue is booked.
- **Campaign status changes are not dated in replay time.** Pausing a campaign is logged with the real time, and the replay shows the current status on every as-of date.
- **The budget what-if and the target model extrapolate.** Assuming registrations scale with spend to the power beta is a modelling choice; 2025 shows each channel at only one budget level. The stress tests are reported, not hidden.
- **The data cannot answer:**
  - location, demographics and colleges;
  - unique reach;
  - causal effects of the nurture emails (no comparison group);
  - why people were denied at the gate;
  - multi-touch attribution.

  The copilot says so.
- **The copilot can still be wrong** (for example, by misreading a question). The tool trace on every answer and the stored logs make that checkable, and the evaluation results are reported with failures included.
