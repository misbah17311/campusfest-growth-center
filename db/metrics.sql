-- Metric definitions shared by the dashboard and the copilot.
--
-- Every function takes p_asof: a calendar date meaning "the end of that day in
-- India time". Nothing that happened after that moment may appear (source
-- Read me: "No later outcome should appear in an earlier snapshot").
--
-- Rules applied everywhere (from the source Read me and field guide):
--   R1  Import-retry duplicates are removed at load time (one row per ID).
--   R2  A visitor is an EXTERNAL person with an ADMITTED + VERIFIED check-in,
--       counted once per person however many admissions they have.
--   R3  A registration's status is its LATEST history version at or before
--       the cutoff, never a sum of versions.
--   R4  "Registered" counts distinct external PEOPLE with a registration.
--   R5  Spend is net (negative rows are vendor credits).
--   R6  Impressions, clicks, reach, sessions and form starts are anonymous
--       event counts, not people.
--   R7  Campaign attribution is the recorded source: registration.campaign_id
--       for registrants, people.first_campaign_id for identified people. A
--       visitor is attributed through the registration on their first
--       verified admission; visitors without a registration are walk-ins
--       (unattributed).

-- End of the selected day, India time, as an instant.
create or replace function cutoff(p_asof date) returns timestamptz
language sql stable as $$
    select (p_asof + 1)::timestamp at time zone 'Asia/Kolkata'
$$;

-- The target version in force at the end of p_asof (null before the first).
create or replace function target_asof(p_asof date)
returns setof targets
language sql stable as $$
    select * from targets
    where effective_at < cutoff(p_asof)
    order by effective_at desc, version_id desc
    limit 1
$$;

-- Latest status of every registration that exists at the cutoff (R3).
create or replace function registration_status_asof(p_asof date)
returns table (registration_id text, person_id text, campaign_id text, registered_at timestamptz,
               status text, status_since timestamptz, is_external boolean)
language sql stable as $$
    select r.registration_id, r.person_id, r.campaign_id, r.registered_at,
           coalesce(h.status, 'unknown') as status, h.effective_at as status_since,
           p.person_type = 'external' as is_external
    from registrations r
    join people p on p.person_id = r.person_id
    left join lateral (
        select rh.status, rh.effective_at
        from registration_history rh
        where rh.registration_id = r.registration_id
          and rh.effective_at < cutoff(p_asof)
        order by rh.effective_at desc, rh.history_id desc
        limit 1
    ) h on true
    where r.registered_at < cutoff(p_asof)
$$;

-- One row per verified external visitor (R2, R7).
create or replace function visitors_asof(p_asof date)
returns table (person_id text, first_admitted_at timestamptz, registration_id text, campaign_id text,
               days_attended integer, admitted_day1 boolean, admitted_day2 boolean)
language sql stable as $$
    with ok as (
        select c.*
        from checkins c
        join people p on p.person_id = c.person_id
        where c.occurred_at < cutoff(p_asof)
          and c.result = 'admitted' and c.verification = 'verified'
          and p.person_type = 'external'
    ),
    firsts as (
        select distinct on (person_id) person_id, occurred_at, registration_id
        from ok order by person_id, occurred_at, event_id
    ),
    days as (
        select person_id,
               count(distinct (occurred_at at time zone 'Asia/Kolkata')::date) as days_attended,
               bool_or((occurred_at at time zone 'Asia/Kolkata')::date =
                       (select (event_starts_at at time zone 'Asia/Kolkata')::date from event limit 1)) as d1,
               bool_or((occurred_at at time zone 'Asia/Kolkata')::date =
                       (select (event_starts_at at time zone 'Asia/Kolkata')::date + 1 from event limit 1)) as d2
        from ok group by person_id
    )
    select f.person_id, f.occurred_at, f.registration_id, r.campaign_id,
           d.days_attended::int, d.d1, d.d2
    from firsts f
    join days d using (person_id)
    left join registrations r on r.registration_id = f.registration_id
$$;

-- Where the event stands relative to p_asof.
create or replace function event_phase(p_asof date) returns text
language sql stable as $$
    select case
        when cutoff(p_asof) <= e.event_starts_at then 'before'
        when cutoff(p_asof) <= e.event_ends_at then 'during'
        else 'after' end
    from event e limit 1
$$;

-- Headline funnel against the targets in force.
create or replace function funnel_asof(p_asof date)
returns table (
    as_of date, event_phase text, target_version text,
    identified_external integer, identified_goal integer,
    registered_people integer, registration_goal integer,
    status_interested integer, status_confirmed integer, status_waitlisted integer,
    status_cancelled integer, status_unknown integer,
    visitors integer, visitors_goal integer, visitors_registered integer, visitors_walk_in integer,
    confirmed_who_attended integer, show_up_rate numeric,
    spend_inr bigint, budget_inr integer,
    impressions bigint, clicks bigint, landing_sessions bigint, form_start_events bigint
)
language sql stable as $$
    with t as (select * from target_asof(p_asof)),
    st as (select * from registration_status_asof(p_asof) where is_external),
    -- person-level status: a person counts as confirmed if any of their
    -- registrations is confirmed (R4); otherwise their most advanced status.
    pst as (
        select person_id,
               case when bool_or(status = 'confirmed') then 'confirmed'
                    when bool_or(status = 'waitlisted') then 'waitlisted'
                    when bool_or(status = 'interested') then 'interested'
                    when bool_or(status = 'cancelled') then 'cancelled'
                    else 'unknown' end as status
        from st group by person_id
    ),
    v as (select * from visitors_asof(p_asof)),
    dm as (select * from daily_marketing where activity_date <= p_asof)
    select
        p_asof,
        event_phase(p_asof),
        (select target_version from t),
        (select count(*) from people where person_type = 'external' and first_seen_at < cutoff(p_asof))::int,
        (select identified_external_people_goal from t),
        (select count(*) from pst)::int,
        (select registration_goal from t),
        (select count(*) from pst where status = 'interested')::int,
        (select count(*) from pst where status = 'confirmed')::int,
        (select count(*) from pst where status = 'waitlisted')::int,
        (select count(*) from pst where status = 'cancelled')::int,
        (select count(*) from pst where status = 'unknown')::int,
        (select count(*) from v)::int,
        (select unique_external_visitors_goal from t),
        (select count(*) from v where person_id in (select person_id from st))::int,
        (select count(*) from v where person_id not in (select person_id from st))::int,
        (select count(*) from pst where status = 'confirmed' and person_id in (select person_id from v))::int,
        case when event_phase(p_asof) = 'before' then null
             else round((select count(*) from pst where status = 'confirmed'
                                                  and person_id in (select person_id from v))::numeric
                        / nullif((select count(*) from pst where status = 'confirmed'), 0), 4) end,
        (select coalesce(sum(marketing_spend_inr), 0) from dm)::bigint,
        (select marketing_budget_inr from t),
        (select coalesce(sum(impressions), 0) from dm)::bigint,
        (select coalesce(sum(clicks), 0) from dm)::bigint,
        (select coalesce(sum(landing_page_sessions), 0) from dm)::bigint,
        (select coalesce(sum(registration_starts), 0) from dm)::bigint
$$;

-- Per-campaign funnel and efficiency.
drop function if exists campaign_metrics_asof(date) cascade;
create or replace function campaign_metrics_asof(p_asof date)
returns table (
    campaign_id text, campaign_name text, channel text, owner_id text, owner_name text, status text,
    planned_budget_inr integer,
    spend_inr bigint, impressions bigint, clicks bigint, reported_reach bigint, landing_sessions bigint, form_start_events bigint,
    identified integer, form_starters integer, registered integer,
    confirmed integer, cancelled integer, waitlisted integer, interested integer,
    visitors integer, confirmed_who_attended integer,
    nurture_sent integer, nurture_opened integer, nurture_clicked integer, opted_out integer,
    ctr numeric, identified_to_registered numeric, starter_to_registered numeric,
    registered_to_confirmed numeric, show_up_rate numeric,
    cost_per_registration numeric, cost_per_visitor numeric
)
language sql stable as $$
    -- One pass per population with joins (no per-row IN lookups), so this stays
    -- fast when embedded in other functions.
    with ext as materialized (
        select person_id, first_campaign_id from people
        where person_type = 'external' and first_seen_at < cutoff(p_asof)
    ),
    st as materialized (select * from registration_status_asof(p_asof) where is_external),
    -- one row per (campaign, person) with the person's most advanced status in that campaign
    pc as materialized (
        select campaign_id, person_id,
               case when bool_or(status = 'confirmed') then 'confirmed'
                    when bool_or(status = 'waitlisted') then 'waitlisted'
                    when bool_or(status = 'interested') then 'interested'
                    when bool_or(status = 'cancelled') then 'cancelled'
                    else 'unknown' end as status
        from st group by campaign_id, person_id
    ),
    v as materialized (select * from visitors_asof(p_asof)),
    ia as (
        select i.campaign_id,
               count(distinct i.person_id) filter (where i.event_type = 'registration_start') as form_starters,
               count(distinct i.person_id) filter (where i.event_type = 'nurture_email_sent') as nurture_sent,
               count(distinct i.person_id) filter (where i.event_type = 'nurture_email_opened') as nurture_opened,
               count(distinct i.person_id) filter (where i.event_type = 'nurture_email_clicked') as nurture_clicked,
               count(distinct i.person_id) filter (where i.event_type = 'opted_out') as opted_out
        from interactions i
        join people p on p.person_id = i.person_id and p.person_type = 'external'
        where i.occurred_at < cutoff(p_asof)
        group by i.campaign_id
    ),
    dm as (
        select campaign_id, sum(marketing_spend_inr) as spend, sum(impressions) as impressions,
               sum(clicks) as clicks, sum(reported_reach) as reach, sum(landing_page_sessions) as sessions,
               sum(registration_starts) as starts
        from daily_marketing where activity_date <= p_asof group by campaign_id
    ),
    idn as (select first_campaign_id as campaign_id, count(*) as n from ext group by first_campaign_id),
    agg_pc as (
        select pc.campaign_id,
               count(*) as registered,
               count(*) filter (where pc.status = 'confirmed') as confirmed,
               count(*) filter (where pc.status = 'cancelled') as cancelled,
               count(*) filter (where pc.status = 'waitlisted') as waitlisted,
               count(*) filter (where pc.status = 'interested') as interested,
               count(*) filter (where pc.status = 'confirmed' and vv.person_id is not null) as confirmed_who_attended
        from pc left join v vv on vv.person_id = pc.person_id
        group by pc.campaign_id
    ),
    agg_v as (select campaign_id, count(*) as n from v group by campaign_id),
    base as (
        select c.campaign_id, c.campaign_name, c.channel, c.owner_id, tm.owner_name, c.status, c.planned_budget_inr,
               coalesce(dm.spend, 0)::bigint as spend_inr,
               coalesce(dm.impressions, 0)::bigint as impressions,
               coalesce(dm.clicks, 0)::bigint as clicks,
               coalesce(dm.reach, 0)::bigint as reported_reach,
               coalesce(dm.sessions, 0)::bigint as landing_sessions,
               coalesce(dm.starts, 0)::bigint as form_start_events,
               coalesce(idn.n, 0)::int as identified,
               coalesce(ia.form_starters, 0)::int as form_starters,
               coalesce(a.registered, 0)::int as registered,
               coalesce(a.confirmed, 0)::int as confirmed,
               coalesce(a.cancelled, 0)::int as cancelled,
               coalesce(a.waitlisted, 0)::int as waitlisted,
               coalesce(a.interested, 0)::int as interested,
               coalesce(av.n, 0)::int as visitors,
               coalesce(a.confirmed_who_attended, 0)::int as confirmed_who_attended,
               coalesce(ia.nurture_sent, 0)::int as nurture_sent,
               coalesce(ia.nurture_opened, 0)::int as nurture_opened,
               coalesce(ia.nurture_clicked, 0)::int as nurture_clicked,
               coalesce(ia.opted_out, 0)::int as opted_out
        from campaigns c
        left join team tm on tm.owner_id = c.owner_id
        left join dm on dm.campaign_id = c.campaign_id
        left join idn on idn.campaign_id = c.campaign_id
        left join ia on ia.campaign_id = c.campaign_id
        left join agg_pc a on a.campaign_id = c.campaign_id
        left join agg_v av on av.campaign_id = c.campaign_id
    )
    select b.*,
           round(b.clicks::numeric / nullif(b.impressions, 0), 4),
           round(b.registered::numeric / nullif(b.identified, 0), 4),
           round(b.registered::numeric / nullif(b.form_starters, 0), 4),
           round(b.confirmed::numeric / nullif(b.registered, 0), 4),
           case when event_phase(p_asof) = 'before' then null
                else round(b.confirmed_who_attended::numeric / nullif(b.confirmed, 0), 4) end,
           round(b.spend_inr::numeric / nullif(b.registered, 0), 2),
           case when event_phase(p_asof) = 'before' then null
                else round(b.spend_inr::numeric / nullif(b.visitors, 0), 2) end
    from base b
    order by b.campaign_id
$$;
