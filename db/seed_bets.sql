-- The five strategic bets for the next CampusFest (Pune, festival 6-7 March 2027),
-- as ranked in the strategy. Expected visitors = each bet's contribution in the base
-- case of analysis/target_model.py, applied in rank order so the parts add up.
-- Thresholds are the leading indicators and scale/change/stop rules from slide 3.
-- Idempotent: upserts these five rows by name, so re-running updates them in place
-- (initiative ids, and the tasks linked to them, are kept).

create unique index if not exists initiatives_name on initiatives (name);

insert into initiatives (rank, name, hypothesis, owner_id, budget_inr, start_date, end_date, primary_kpi,
                         scale_rule, change_rule, stop_rule, expected_visitors, status, campaign_ids)
values
(1, 'College & club partnerships with group registration',
 'Groups that register together come together: College Partnerships had the best show-up in 2025 (91.7% of confirmed registrants) at INR 81 per visitor. Scale from clubs at the largest Pune colleges with group passes and a club leaderboard.',
 'T03', 82500, '2026-12-01', '2027-03-05', 'Partner clubs signed; cost per registration (C04)',
 '>= 25 clubs signed by week 3 and cost per registration <= INR 80: release the reserve share',
 '10-25 clubs or INR 80-120 per registration: change the club incentive (group pass size, leaderboard prize)',
 '< 10 clubs by week 3 or > INR 150 per registration: move the budget to referrals',
 379, 'planned', '{C04}'),
(2, 'Referral rewards paid only when the friend attends',
 'Student Referrals was the cheapest channel per verified visitor in 2025 (INR 69) with 85.9% show-up. Paying the reward on the friend''s verified check-in, not on sign-up, aligns the incentive with attendance.',
 'T06', 57500, '2027-01-11', '2027-03-05', 'Invites sent per registrant; invite-to-registration rate',
 '>= 0.5 invites per registrant and >= 20% of invites register by week 2: raise the reward cap',
 'Invites >= 0.5 per registrant but < 10% register: change the reward or the message',
 '< 0.2 invites per registrant by week 3: stop and return the budget to partnerships',
 322, 'planned', '{C05}'),
(3, 'Show-up and gate programme',
 '575 of 2,500 confirmed registrants never got a verified admission in 2025; 60 of them reached the gate (all Campus Ambassadors registrants) and 88 people stayed waitlisted. Date-and-time reminders raised attendance by about 7 points in a randomised trial; reconfirmation, automatic waitlist release and a faster gate attack the rest.',
 'T05', 15000, '2027-02-20', '2027-03-07', '72-hour reconfirmation rate vs a 10% no-reminder holdout; dry-run gate throughput',
 'Reconfirmation >= 85% and >= 3 points above the holdout: send reminders to everyone',
 'Reconfirmation < 75%: add a call or SMS for non-responders; dry-run throughput < 450 admissions/hour: add lanes and scanners',
 'Any reminder channel with opt-outs > 5%: stop that channel',
 132, 'planned', '{}'),
(4, 'Paid Social for retargeting only',
 'Paid Social cost INR 274 per verified visitor in 2025 with 58.6% show-up, and its cost per registration rose from INR 113 (Feb) to 199 (Mar). Keep it only to retarget form abandoners and page visitors; the INR 53,000 freed funds bets 1 and 2.',
 'T04', 40000, '2027-01-11', '2027-03-05', 'Retargeting cost per registration; confirmation rate on mature cohorts',
 '<= INR 100 per registration: add INR 10,000 from the reserve',
 'INR 100-160 per registration: narrow the audiences, new creative',
 '> INR 160 per registration for 2 weeks or confirmation < 85%: move the rest to referrals',
 -87, 'planned', '{C02}'),
(5, 'Campus ambassadors paid per verified attendee',
 'Ambassador registrants reached the gate at the highest rate of any channel (94% of confirmed), but 12.5% were denied or left unverified at the scanner. Pay ambassadors per verified attendee and check their registrations before the event.',
 'T03', 55000, '2026-12-15', '2027-03-05', 'Cost per registration (C01); share of ambassador registrations that pass the pre-event check',
 '<= INR 90 per registration and >= 99% pass the check: recruit ambassadors at more large colleges',
 '< 97% pass the check: fix the registration form and retrain ambassadors before more spend',
 '> INR 150 per registration: stop recruiting new ambassadors',
 90, 'planned', '{C01}')
on conflict (name) do update set
    rank = excluded.rank, hypothesis = excluded.hypothesis, owner_id = excluded.owner_id, budget_inr = excluded.budget_inr,
    start_date = excluded.start_date, end_date = excluded.end_date, primary_kpi = excluded.primary_kpi,
    scale_rule = excluded.scale_rule, change_rule = excluded.change_rule, stop_rule = excluded.stop_rule,
    expected_visitors = excluded.expected_visitors, campaign_ids = excluded.campaign_ids;
