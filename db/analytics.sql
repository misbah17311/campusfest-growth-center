-- Time series, diagnosis, projection and decision rules.
-- Same conventions as db/metrics.sql: p_asof = end of that day in India time,
-- nothing after the cutoff is used, only external people count as audience.

-- ---------------------------------------------------------------------------
-- Daily cumulative funnel from the first covered day to p_asof.
-- Each row must equal funnel_asof(day) for the same day (tested).
-- ---------------------------------------------------------------------------
create or replace function daily_series_asof(p_asof date)
returns table (day date, identified integer, registered integer, confirmed integer, visitors integer,
               spend_inr bigint, registrations_on_day integer)
language sql stable as $$
    with ev as (select history_start, least(p_asof, history_end) as last_day from event limit 1),
    days as (
        select d::date as day, cutoff(d::date) as cut
        from ev, generate_series(ev.history_start, ev.last_day, interval '1 day') d
    ),
    ext as (select person_id, first_seen_at from people where person_type = 'external'),
    -- events dated by their India-time day, clamped so anything before the first covered day counts on it
    ev_id as (select greatest((first_seen_at at time zone 'Asia/Kolkata')::date, (select history_start from ev)) as day,
                     count(*) as n from ext group by 1),
    reg as (select r.person_id, min(r.registered_at) as first_reg from registrations r join ext using (person_id)
            group by r.person_id),
    ev_reg as (select greatest((first_reg at time zone 'Asia/Kolkata')::date, (select history_start from ev)) as day,
                      count(*) as n from reg group by 1),
    v as (select c.person_id, min(c.occurred_at) as first_ok from checkins c join ext using (person_id)
          where c.result = 'admitted' and c.verification = 'verified' group by c.person_id),
    ev_v as (select greatest((first_ok at time zone 'Asia/Kolkata')::date, (select history_start from ev)) as day,
                    count(*) as n from v group by 1),
    ev_sp as (select greatest(activity_date, (select history_start from ev)) as day, sum(marketing_spend_inr) as n
              from daily_marketing group by 1),
    h as (
        select r.person_id, rh.status, rh.effective_at,
               lead(rh.effective_at) over (partition by rh.registration_id order by rh.effective_at, rh.history_id) as next_at
        from registration_history rh
        join registrations r on r.registration_id = rh.registration_id
        join ext on ext.person_id = r.person_id
    ),
    -- A confirmed status version counts on every day from its India-time start date up to
    -- the day before the next version starts; expand each version into those days once.
    hc_days as (
        select h.person_id, gs::date as day
        from h, generate_series((h.effective_at at time zone 'Asia/Kolkata')::date,
                                coalesce((h.next_at at time zone 'Asia/Kolkata')::date - 1, (select last_day from ev)),
                                interval '1 day') gs
        where h.status = 'confirmed'
    ),
    conf_by_day as (select day, count(distinct person_id) as n from hc_days group by day)
    select d.day,
        (sum(coalesce(i.n, 0)) over w)::int,
        (sum(coalesce(g.n, 0)) over w)::int,
        coalesce(cb.n, 0)::int,
        (sum(coalesce(vv.n, 0)) over w)::int,
        (sum(coalesce(sp.n, 0)) over w)::bigint,
        coalesce(g.n, 0)::int
    from days d
    left join ev_id i on i.day = d.day
    left join ev_reg g on g.day = d.day
    left join ev_v vv on vv.day = d.day
    left join ev_sp sp on sp.day = d.day
    left join conf_by_day cb on cb.day = d.day
    window w as (order by d.day rows between unbounded preceding and current row)
    order by d.day
$$;

-- ---------------------------------------------------------------------------
-- Weekly activity per campaign (weeks start Monday). Anonymous platform counts
-- and people-based counts are kept in separate columns; never add them up.
-- ---------------------------------------------------------------------------
create or replace function weekly_campaign_asof(p_asof date)
returns table (campaign_id text, week_start date, spend_inr bigint, impressions bigint, clicks bigint,
               landing_sessions bigint, form_start_events bigint, identified integer, registrations integer)
language sql stable as $$
    with wk as (
        select c.campaign_id, w::date as week_start
        from campaigns c, event e,
             generate_series(date_trunc('week', e.history_start), date_trunc('week', least(p_asof, e.history_end)),
                             interval '1 week') w
    ),
    dm as (
        select campaign_id, date_trunc('week', activity_date)::date as week_start,
               sum(marketing_spend_inr) as spend, sum(impressions) as impressions, sum(clicks) as clicks,
               sum(landing_page_sessions) as sessions, sum(registration_starts) as starts
        from daily_marketing where activity_date <= p_asof group by 1, 2
    ),
    idn as (
        select first_campaign_id as campaign_id,
               date_trunc('week', (first_seen_at at time zone 'Asia/Kolkata'))::date as week_start, count(*) as n
        from people where person_type = 'external' and first_seen_at < cutoff(p_asof) group by 1, 2
    ),
    rg as (
        select r.campaign_id, date_trunc('week', (r.registered_at at time zone 'Asia/Kolkata'))::date as week_start,
               count(distinct r.person_id) as n
        from registrations r join people p on p.person_id = r.person_id and p.person_type = 'external'
        where r.registered_at < cutoff(p_asof) group by 1, 2
    )
    select wk.campaign_id, wk.week_start,
           coalesce(dm.spend, 0)::bigint, coalesce(dm.impressions, 0)::bigint, coalesce(dm.clicks, 0)::bigint,
           coalesce(dm.sessions, 0)::bigint, coalesce(dm.starts, 0)::bigint,
           coalesce(idn.n, 0)::int, coalesce(rg.n, 0)::int
    from wk
    left join dm using (campaign_id, week_start)
    left join idn using (campaign_id, week_start)
    left join rg using (campaign_id, week_start)
    order by wk.campaign_id, wk.week_start
$$;

-- ---------------------------------------------------------------------------
-- Where people leave the funnel, as of p_asof (external people only).
-- ---------------------------------------------------------------------------
create or replace function funnel_leaks_asof(p_asof date)
returns table (sort_order integer, stage text, leak text, people integer, note text)
language sql stable as $$
    with ext as (select * from people where person_type = 'external' and first_seen_at < cutoff(p_asof)),
    st as (select * from registration_status_asof(p_asof) where is_external),
    pst as (
        select person_id,
               case when bool_or(status = 'confirmed') then 'confirmed'
                    when bool_or(status = 'waitlisted') then 'waitlisted'
                    when bool_or(status = 'interested') then 'interested'
                    when bool_or(status = 'cancelled') then 'cancelled' else 'unknown' end as status
        from st group by person_id
    ),
    starters as (
        select distinct person_id from interactions
        where event_type = 'registration_start' and occurred_at < cutoff(p_asof)
    ),
    v as (select person_id from visitors_asof(p_asof)),
    at_gate as (select distinct person_id from checkins where occurred_at < cutoff(p_asof)),
    nonreg as (select e.person_id from ext e
               where e.first_touch_source = 'campaign' and e.person_id not in (select person_id from st))
    select 1, 'identified → registered', 'started the form, did not finish',
           (select count(*) from nonreg where person_id in (select person_id from starters))::int,
           'Identified people with a registration_start action and no registration'
    union all
    select 2, 'identified → registered', 'never started the form',
           (select count(*) from nonreg where person_id not in (select person_id from starters))::int,
           'Identified through a campaign, no registration and no form start'
    union all
    select 3, 'registered → confirmed', 'still interested (not confirmed)',
           (select count(*) from pst where status = 'interested')::int, 'Latest status interested'
    union all
    select 4, 'registered → confirmed', 'waitlisted',
           (select count(*) from pst where status = 'waitlisted')::int, 'Latest status waitlisted'
    union all
    select 5, 'registered → confirmed', 'cancelled',
           (select count(*) from pst where status = 'cancelled')::int, 'Latest status cancelled'
    union all
    select 6, 'confirmed → visited', 'reached the gate, never admitted',
           case when event_phase(p_asof) = 'before' then null else
           (select count(*) from pst where status = 'confirmed' and person_id in (select person_id from at_gate)
              and person_id not in (select person_id from v))::int end,
           'Only denied or pending/unverified check-in records'
    union all
    select 7, 'confirmed → visited', 'did not come',
           case when event_phase(p_asof) = 'before' then null else
           (select count(*) from pst where status = 'confirmed' and person_id not in (select person_id from at_gate))::int end,
           'Confirmed, no check-in record at all'
    union all
    select 8, 'extra visitors', 'walk-ins without registration',
           (select count(*) from v where person_id not in (select person_id from st))::int,
           'Verified external visitors with no registration (positive)'
    order by 1
$$;

-- Same leaks by campaign (for diagnosis); walk-ins have no campaign.
-- Written with joins and one pass per population (anti-joins, not NOT IN), so
-- it stays fast when embedded in campaign_decisions_asof.
create or replace function campaign_leaks_asof(p_asof date)
returns table (campaign_id text, abandoned_form integer, never_started integer, interested integer,
               waitlisted integer, cancelled integer, gate_lost integer, did_not_come integer)
language sql stable as $$
    with ext as materialized (
        select person_id, first_campaign_id, first_touch_source from people
        where person_type = 'external' and first_seen_at < cutoff(p_asof)
    ),
    st as materialized (select * from registration_status_asof(p_asof) where is_external),
    reg_people as materialized (select distinct person_id from st),
    pc as materialized (
        select st.campaign_id, st.person_id,
               case when bool_or(status = 'confirmed') then 'confirmed'
                    when bool_or(status = 'waitlisted') then 'waitlisted'
                    when bool_or(status = 'interested') then 'interested'
                    when bool_or(status = 'cancelled') then 'cancelled' else 'unknown' end as status
        from st group by st.campaign_id, st.person_id
    ),
    starters as materialized (select distinct person_id from interactions
                              where event_type = 'registration_start' and occurred_at < cutoff(p_asof)),
    v as materialized (select person_id from visitors_asof(p_asof)),
    at_gate as materialized (select distinct person_id from checkins where occurred_at < cutoff(p_asof)),
    nonreg as (
        select e.first_campaign_id as campaign_id, (s.person_id is not null) as started
        from ext e
        left join reg_people rp on rp.person_id = e.person_id
        left join starters s on s.person_id = e.person_id
        where e.first_touch_source = 'campaign' and rp.person_id is null
    ),
    agg_nonreg as (
        select campaign_id, count(*) filter (where started) as abandoned, count(*) filter (where not started) as never
        from nonreg group by campaign_id
    ),
    agg_pc as (
        select pc.campaign_id,
               count(*) filter (where pc.status = 'interested') as interested,
               count(*) filter (where pc.status = 'waitlisted') as waitlisted,
               count(*) filter (where pc.status = 'cancelled') as cancelled,
               count(*) filter (where pc.status = 'confirmed' and g.person_id is not null and v.person_id is null) as gate_lost,
               count(*) filter (where pc.status = 'confirmed' and g.person_id is null) as did_not_come
        from pc
        left join v on v.person_id = pc.person_id
        left join at_gate g on g.person_id = pc.person_id
        group by pc.campaign_id
    ),
    pre as (select event_phase(p_asof) = 'before' as b)
    select c.campaign_id,
           coalesce(n.abandoned, 0)::int, coalesce(n.never, 0)::int,
           coalesce(a.interested, 0)::int, coalesce(a.waitlisted, 0)::int, coalesce(a.cancelled, 0)::int,
           case when (select b from pre) then null else coalesce(a.gate_lost, 0)::int end,
           case when (select b from pre) then null else coalesce(a.did_not_come, 0)::int end
    from campaigns c
    left join agg_nonreg n on n.campaign_id = c.campaign_id
    left join agg_pc a on a.campaign_id = c.campaign_id
    order by c.campaign_id
$$;

-- ---------------------------------------------------------------------------
-- Show-up of confirmed registrants by how far ahead they registered.
-- ---------------------------------------------------------------------------
create or replace function showup_by_lead_time_asof(p_asof date)
returns table (bucket text, sort_order integer, confirmed integer, came integer, show_up_rate numeric)
language sql stable as $$
    with e as (select (event_starts_at at time zone 'Asia/Kolkata')::date as d0 from event limit 1),
    st as (
        select s.person_id, min(s.registered_at) as reg_at
        from registration_status_asof(p_asof) s where s.is_external and s.status = 'confirmed' group by s.person_id
    ),
    b as (
        select st.person_id, (select d0 from e) - (st.reg_at at time zone 'Asia/Kolkata')::date as days_before from st
    ),
    v as (select person_id from visitors_asof(p_asof)),
    lab as (
        select person_id,
               case when days_before <= 7 then '0-7 days' when days_before <= 14 then '8-14 days'
                    when days_before <= 28 then '15-28 days' when days_before <= 42 then '29-42 days'
                    when days_before <= 56 then '43-56 days' else '57+ days' end as bucket,
               case when days_before <= 7 then 1 when days_before <= 14 then 2 when days_before <= 28 then 3
                    when days_before <= 42 then 4 when days_before <= 56 then 5 else 6 end as sort_order
        from b
    )
    select bucket, sort_order, count(*)::int,
           count(*) filter (where person_id in (select person_id from v))::int,
           case when event_phase(p_asof) = 'before' then null
                else round(count(*) filter (where person_id in (select person_id from v))::numeric / count(*), 4) end
    from lab group by bucket, sort_order order by sort_order
$$;

-- ---------------------------------------------------------------------------
-- Data quality: what was removed or excluded, and why.
-- ---------------------------------------------------------------------------
create or replace function data_quality_asof(p_asof date)
returns table (item text, value bigint, note text)
language sql stable as $$
    with latest as (
        select * from import_report
        where run_id = (select run_id from import_report order by run_at desc, report_id desc limit 1)
    ),
    ok as (
        select c.person_id, p.person_type from checkins c join people p using (person_id)
        where c.occurred_at < cutoff(p_asof) and c.result = 'admitted' and c.verification = 'verified'
    ),
    v as (select person_id from visitors_asof(p_asof))
    select 'Import-retry duplicates removed: ' || sheet, duplicate_rows_removed::bigint,
           'Identical rows with the same ID counted once (last import: ' || source_file || ')'
    from latest where duplicate_rows_removed > 0
    union all
    select 'Conflicting duplicate IDs: ' || sheet, conflicting_ids::bigint, coalesce(notes, '')
    from latest where conflicting_ids > 0
    union all
    select 'Admitted non-external people excluded (' || person_type || ')', count(distinct person_id),
           'Internal, staff and test people never count as visitors'
    from ok where person_type <> 'external' group by person_type
    union all
    select 'Externals with only denied/pending check-ins', count(distinct c.person_id),
           'Reached the gate but never had an admitted + verified record'
    from checkins c join people p using (person_id)
    where p.person_type = 'external' and c.occurred_at < cutoff(p_asof) and c.person_id not in (select person_id from v)
    having count(distinct c.person_id) > 0
    union all
    select 'Visitors admitted twice or more (counted once)', count(*), 'Multiple admission records per person'
    from (select person_id from ok where person_type = 'external' group by person_id having count(*) > 1) x
    union all
    select 'Vendor credits (negative spend rows)', count(*), 'Net spend = debits minus credits; total credit INR ' ||
           coalesce(-sum(marketing_spend_inr), 0)::text
    from daily_marketing where activity_date <= p_asof and marketing_spend_inr < 0
$$;

-- ---------------------------------------------------------------------------
-- Projection before the event. It uses only data up to p_asof: the last 14
-- days' registration pace, and a visitors-per-registration ratio that is either
-- an editable assumption or, by default, the ratio implied by the plan in force
-- (visitor goal / registration goal). It never uses the event's own outcomes.
-- ---------------------------------------------------------------------------
create or replace function projection_asof(p_asof date)
returns table (event_phase text, days_to_event integer, registered_now integer, registered_14d_ago integer,
               run_rate_per_day numeric, projected_registrations numeric, registration_goal integer,
               required_rate_per_day numeric, visitors_per_registration numeric, ratio_basis text,
               projected_visitors numeric, visitors_goal integer)
language sql stable as $$
    with e as (select (event_starts_at at time zone 'Asia/Kolkata')::date as d0 from event limit 1),
    t as (select * from target_asof(p_asof)),
    a as (select value from assumptions where key = 'projection_visitors_per_registration'),
    f0 as (select registered_people from funnel_asof(p_asof)),
    f14 as (select registered_people from funnel_asof(p_asof - 14)),
    base as (
        select event_phase(p_asof) as ph,
               greatest((select d0 from e) - p_asof - 1, 0) as days_left,
               (select registered_people from f0) as now_reg,
               (select registered_people from f14) as reg14,
               coalesce((select value from a),
                        (select unique_external_visitors_goal::numeric / nullif(registration_goal, 0) from t)) as ratio,
               case when exists (select 1 from a) then 'assumption (editable)' else 'implied by the plan in force' end as basis
    )
    select b.ph, b.days_left, b.now_reg, b.reg14,
           round((b.now_reg - b.reg14) / 14.0, 2),
           case when b.ph = 'before' then round(b.now_reg + (b.now_reg - b.reg14) / 14.0 * b.days_left, 0) end,
           (select registration_goal from t),
           case when b.ph = 'before' and b.days_left > 0
                then round(greatest((select registration_goal from t) - b.now_reg, 0)::numeric / b.days_left, 2) end,
           round(b.ratio, 4), b.basis,
           case when b.ph = 'before'
                then round((b.now_reg + (b.now_reg - b.reg14) / 14.0 * b.days_left) * b.ratio, 0) end,
           (select unique_external_visitors_goal from t)
    from base b
$$;

-- ---------------------------------------------------------------------------
-- Decision rules: editable thresholds (one row), applied per campaign.
-- Before the event only leading indicators exist (cost per registration,
-- confirmation, form completion, opt-outs). After it, cost per verified
-- visitor, show-up and gate losses decide.
-- ---------------------------------------------------------------------------
create table if not exists decision_rules (
    id                   integer primary key default 1 check (id = 1),
    min_registrations    integer not null default 30,
    scale_cost_ratio     numeric not null default 0.80,  -- cost <= 0.8 x blended -> scale
    stop_cost_ratio      numeric not null default 1.60,  -- cost >= 1.6 x blended -> stop
    min_confirm_rate     numeric not null default 0.88,
    min_form_completion  numeric not null default 0.88,
    max_optout_rate      numeric not null default 0.15,
    min_show_up          numeric not null default 0.75,
    max_gate_loss        numeric not null default 0.05,
    maturity_days        integer not null default 7,     -- judge confirmation / form completion only on cohorts this old
    updated_at           timestamptz not null default now()
);
alter table decision_rules add column if not exists maturity_days integer not null default 7;
insert into decision_rules (id) values (1) on conflict (id) do nothing;
drop trigger if exists log_change on decision_rules;
create trigger log_change after insert or update or delete on decision_rules
    for each row execute function log_change('id');

create or replace function campaign_decisions_asof(p_asof date)
returns table (campaign_id text, campaign_name text, decision text, basis text, cost_metric numeric,
               blended_cost numeric, cost_ratio numeric, reasons text[])
language plpgsql stable as $$
#variable_conflict use_column
declare
    m_json jsonb;
    lk_json jsonb;
begin
    -- The two inputs are computed as separate statements first. Nesting the metric
    -- functions inside this query made Postgres plan them generically and the whole
    -- call took 3-7 s; computed separately they take well under 100 ms each.
    m_json := (select jsonb_agg(to_jsonb(x)) from campaign_metrics_asof(p_asof) x);
    lk_json := (select jsonb_agg(to_jsonb(x)) from campaign_leaks_asof(p_asof) x);
    -- Dynamic SQL so the statement is planned with the actual date and inputs every
    -- call (a statically planned version used generic estimates and took ~3 s).
    return query execute $q$
        with r as (select * from decision_rules where id = 1),
        m as materialized (
            select * from jsonb_to_recordset($2) as j(
                campaign_id text, campaign_name text, registered integer, confirmed integer, visitors integer,
                spend_inr bigint, opted_out integer, nurture_sent integer, show_up_rate numeric,
                cost_per_registration numeric, cost_per_visitor numeric)
        ),
        lk as materialized (select * from jsonb_to_recordset($3) as j(campaign_id text, gate_lost integer)),
        ph as (select event_phase($1) = 'after' as post),
        -- Mature cohorts only: registrations and form starts at least maturity_days old at the cutoff.
        -- In 2025, 95% of confirmations came within 4.1 days of registering and 99% of form starters
        -- who registered did so within 3.1 days, so younger cohorts would look worse than they are.
        mat as (select cutoff($1) - make_interval(days => (select maturity_days from r)) as t),
        st as materialized (select * from registration_status_asof($1) where is_external),
        mconf as (
            select campaign_id, count(*) as n, count(*) filter (where status = 'confirmed') as c
            from st where registered_at < (select t from mat) group by campaign_id
        ),
        reg_people as materialized (select distinct person_id from st),
        mform as (
            select i.campaign_id, count(distinct i.person_id) as n,
                   count(distinct i.person_id) filter (where rp.person_id is not null) as c
            from interactions i
            join people p on p.person_id = i.person_id and p.person_type = 'external'
            left join reg_people rp on rp.person_id = i.person_id
            where i.event_type = 'registration_start' and i.occurred_at < (select t from mat)
            group by i.campaign_id
        ),
        blended as (
            select case when (select post from ph)
                        then sum(spend_inr)::numeric / nullif(sum(visitors), 0)
                        else sum(spend_inr)::numeric / nullif(sum(registered), 0) end as cost
            from m
        ),
        x as (
            select m.*, lk.gate_lost,
                   case when (select post from ph) then m.cost_per_visitor else m.cost_per_registration end as cost,
                   (select cost from blended) as blended_cost,
                   m.opted_out::numeric / nullif(m.nurture_sent, 0) as optout_rate,
                   (select c::numeric / nullif(n, 0) from mconf where mconf.campaign_id = m.campaign_id) as conf_mature,
                   (select c::numeric / nullif(n, 0) from mform where mform.campaign_id = m.campaign_id) as form_mature,
                   lk.gate_lost::numeric / nullif(m.confirmed, 0) as gate_loss
            from m join lk using (campaign_id)
        ),
        y as (
            select x.*, x.cost / nullif(x.blended_cost, 0) as ratio,
                   array_remove(array[
                       case when x.conf_mature < (select min_confirm_rate from r)
                            then 'confirmation rate ' || round(100 * x.conf_mature, 1) || '% (registrations at least ' ||
                                 (select maturity_days from r) || ' days old) is below ' ||
                                 round(100 * (select min_confirm_rate from r)) || '%' end,
                       case when x.form_mature < (select min_form_completion from r)
                            then 'form completion ' || round(100 * x.form_mature, 1) || '% (form starts at least ' ||
                                 (select maturity_days from r) || ' days old) is below ' ||
                                 round(100 * (select min_form_completion from r)) || '%' end,
                       case when x.optout_rate > (select max_optout_rate from r)
                            then 'nurture opt-out rate ' || round(100 * x.optout_rate, 1) || '% is above ' ||
                                 round(100 * (select max_optout_rate from r)) || '%' end,
                       case when (select post from ph) and x.show_up_rate < (select min_show_up from r)
                            then 'show-up ' || round(100 * x.show_up_rate, 1) || '% is below ' ||
                                 round(100 * (select min_show_up from r)) || '%' end,
                       case when (select post from ph) and x.gate_loss > (select max_gate_loss from r)
                            then x.gate_lost || ' confirmed registrants (' || round(100 * x.gate_loss, 1) ||
                                 '%) reached the gate but were never admitted' end
                   ], null) as issues
            from x
        )
        select y.campaign_id, y.campaign_name,
               case when y.registered < (select min_registrations from r) then 'insufficient data'
                    when y.ratio >= (select stop_cost_ratio from r) then 'stop'
                    when cardinality(y.issues) > 0 then 'change'
                    when y.ratio <= (select scale_cost_ratio from r) then 'scale'
                    else 'keep' end,
               case when (select post from ph) then 'cost per verified visitor' else 'cost per registration' end,
               round(y.cost, 2), round(y.blended_cost, 2), round(y.ratio, 3),
               case when y.registered < (select min_registrations from r)
                        then array['only ' || y.registered || ' registrations; need ' || (select min_registrations from r)]
                    else array_prepend(
                        case when (select post from ph) then 'cost per verified visitor INR ' else 'cost per registration INR ' end
                        || round(y.cost) || ' = ' || round(y.ratio, 2) || 'x the blended INR ' || round(y.blended_cost),
                        y.issues) end
        from y order by y.campaign_id
    $q$ using p_asof, m_json, lk_json;
end $$;

-- ---------------------------------------------------------------------------
-- Plan each metric function on its own. Postgres otherwise inlines SQL
-- functions into their callers; nesting them (decisions -> metrics -> status)
-- produced one 500-node query whose planning alone took over 5 seconds. A SET
-- clause stops inlining, and pinning search_path to public also guarantees the
-- functions read the working tables, never the pristine copy in `original`.
-- (Re-applied here because CREATE OR REPLACE resets function settings.)
-- ---------------------------------------------------------------------------
alter function registration_status_asof(date) set search_path = public;
alter function visitors_asof(date) set search_path = public;
alter function funnel_asof(date) set search_path = public;
alter function campaign_metrics_asof(date) set search_path = public;
alter function campaign_leaks_asof(date) set search_path = public;
alter function funnel_leaks_asof(date) set search_path = public;
alter function campaign_decisions_asof(date) set search_path = public;
alter function daily_series_asof(date) set search_path = public;
alter function projection_asof(date) set search_path = public;

-- Every copilot answer, for evaluation and cost tracking (not part of the change log).
create table if not exists copilot_log (
    log_id             bigserial primary key,
    asked_at           timestamptz not null default now(),
    as_of              date,
    question           text not null,
    answer             text,
    tools              jsonb,
    model              text,
    prompt_tokens      integer,
    completion_tokens  integer,
    ms                 integer
);
