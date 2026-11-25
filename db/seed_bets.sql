-- The five strategic bets for the next CampusFest (Pune, festival 6-7 March 2027),
-- as ranked in the strategy: score = extra verified visitors per INR 1,000 of new money
-- x confidence in the evidence (each bet measured alone; analysis/target_model.py).
-- Expected visitors = each bet's contribution in the base case, applied in rank order
-- so the parts add up. Thresholds are the leading indicators and scale/change/stop
-- rules from slide 3. Cost lines are relative: cost per registration / the all-campaign
-- blended cost in the same period ("0.8x"). Bets stop at 1.3x, tighter than the 1.6x
-- campaign default, because they carry extra money.
-- Idempotent: upserts these five rows by name (initiative ids, and the tasks linked to
-- them, are kept) and removes bets that are no longer part of the plan.

create unique index if not exists initiatives_name on initiatives (name);

-- Paid Social retargeting was a bet in an earlier draft; it is now a funding move.
delete from initiatives where name = 'Paid Social for retargeting only';

insert into initiatives (rank, name, hypothesis, owner_id, budget_inr, start_date, end_date, primary_kpi,
                         scale_rule, change_rule, stop_rule, expected_visitors, status, campaign_ids)
values
(1, 'Show-up and gate programme',
 '575 of 2,500 confirmed registrants never got a verified admission in 2025; 60 of them reached the gate (all Campus Ambassadors registrants) and 88 people stayed waitlisted. Date-and-time reminders raised attendance by about 7 points in a randomised trial; reconfirmation, automatic waitlist release, a pre-event check of ambassador registrations and a faster gate attack the rest. Highest score: most visitors per rupee, best evidence.',
 'T05', 15000, '2027-02-01', '2027-03-07', '72-hour reconfirmation rate vs a 10% no-reminder holdout; dry-run gate throughput',
 'Reconfirmation >= 85% and >= 3 points above the holdout: send reminders to everyone',
 'Reconfirmation < 85% or < 3 points above the holdout: add a call or SMS for non-responders; dry-run throughput < 450 admissions/hour: add lanes and scanners',
 'Any reminder channel with opt-outs > 5%: stop that channel',
 115, 'planned', '{}'),
(2, 'College & club partnerships with group registration',
 'Groups that register together come together: College Partnerships had the best show-up in 2025 (91.7% of confirmed registrants) at INR 81 per visitor. Scale from clubs at the largest Pune colleges with group passes and a club leaderboard.',
 'T03', 82500, '2026-12-01', '2027-03-05', 'Partner clubs signed; cost per registration (C04)',
 '>= 25 clubs signed by week 3 and cost per registration <= 0.8x blended: release its INR 12,500 reserve share at week 4',
 '10-25 clubs or 0.8-1.3x blended: change the club incentive (group pass size, leaderboard prize)',
 '< 10 clubs by week 3 or > 1.3x blended: move the budget to referrals',
 386, 'planned', '{C04}'),
(3, 'Referral rewards paid only when the friend attends',
 'Student Referrals was the cheapest channel per verified visitor in 2025 (INR 69) with 85.9% show-up. Paying the reward on the friend''s verified check-in, not on sign-up, aligns the incentive with attendance.',
 'T06', 57500, '2027-01-11', '2027-03-05', 'Invites sent per registrant; invite-to-registration rate',
 '>= 0.5 invites per registrant and >= 20% of invites register by week 2: raise the reward cap; release its INR 12,500 reserve share at week 4',
 '0.2-0.5 invites per registrant, or < 20% of invites register: change the reward or the message',
 '< 0.2 invites per registrant by week 3: stop and return the budget to partnerships',
 332, 'planned', '{C05}'),
(4, 'Campus ambassadors paid per verified attendee',
 'Ambassador registrants reached the gate at the highest rate of any channel (94% of confirmed), but 12.5% were denied or left unverified at the scanner. Pay ambassadors per verified attendee, only for registrations that pass the pre-event check run by bet 1.',
 'T03', 55000, '2026-12-15', '2027-03-05', 'Cost per registration (C01); share of ambassador registrations that pass the pre-event check',
 '<= 0.8x blended and >= 99% pass the check: recruit ambassadors at more large colleges',
 '0.8-1.3x blended or < 99% pass the check: fix the registration form and retrain ambassadors before more spend',
 '> 1.3x blended: stop recruiting new ambassadors',
 89, 'planned', '{C01}'),
(5, 'Win back 2025''s people',
 'The people CampusFest already knows best: 2,564 who came or confirmed in 2025 (61 opt-outs excluded) get a personal invite in week 1 with early access and a fast lane at the gate. A 20% holdout measures what the message really adds. Low confidence: no 2025 evidence on return rates, so it is the cheapest and fastest test (INR 10,000, read after 7 days).',
 'T04', 10000, '2027-01-11', '2027-03-05', 'Registration within 7 days, messaged list vs 20% holdout; opt-outs',
 '>= 4 points above the holdout: message the holdout too and add a bring-a-friend link',
 '2-4 points above the holdout: change the offer or the message',
 '< 2 points above the holdout, or opt-outs > 5%: stop and move the money to referrals',
 86, 'planned', '{}')
on conflict (name) do update set
    rank = excluded.rank, hypothesis = excluded.hypothesis, owner_id = excluded.owner_id, budget_inr = excluded.budget_inr,
    start_date = excluded.start_date, end_date = excluded.end_date, primary_kpi = excluded.primary_kpi,
    scale_rule = excluded.scale_rule, change_rule = excluded.change_rule, stop_rule = excluded.stop_rule,
    expected_visitors = excluded.expected_visitors, campaign_ids = excluded.campaign_ids;
