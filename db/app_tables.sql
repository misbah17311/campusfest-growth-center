-- Tables the Growth Center adds on top of the source data (public schema only),
-- the change-log trigger, and the reset function.

-- ---------------------------------------------------------------------------
-- Change log: every insert/update/delete on an editable table is recorded by a
-- trigger, so no code path can forget to log. The actor ('user', 'copilot',
-- 'system') is read from the transaction setting app.actor. Bulk operations
-- (reset, import) set app.bulk = 'on' and write one summary row instead of
-- thousands of row-level entries.
-- ---------------------------------------------------------------------------
create table if not exists change_log (
    change_id   bigserial primary key,
    changed_at  timestamptz not null default now(),
    actor       text not null,
    table_name  text not null,
    row_id      text,
    action      text not null check (action in ('insert', 'update', 'delete', 'reset', 'import')),
    before      jsonb,
    after       jsonb,
    note        text
);
create index if not exists change_log_time on change_log (changed_at desc);

create or replace function log_change() returns trigger
language plpgsql as $$
declare
    v_actor text := coalesce(nullif(current_setting('app.actor', true), ''), 'user');
    v_pk    text := tg_argv[0];
begin
    if current_setting('app.bulk', true) = 'on' then
        return null;
    end if;
    if tg_op = 'DELETE' then
        insert into change_log (actor, table_name, row_id, action, before, after)
        values (v_actor, tg_table_name, to_jsonb(old) ->> v_pk, 'delete', to_jsonb(old), null);
    elsif tg_op = 'UPDATE' then
        if to_jsonb(old) is distinct from to_jsonb(new) then
            insert into change_log (actor, table_name, row_id, action, before, after)
            values (v_actor, tg_table_name, to_jsonb(new) ->> v_pk, 'update', to_jsonb(old), to_jsonb(new));
        end if;
    else
        insert into change_log (actor, table_name, row_id, action, before, after)
        values (v_actor, tg_table_name, to_jsonb(new) ->> v_pk, 'insert', null, to_jsonb(new));
    end if;
    return null;
end $$;

-- ---------------------------------------------------------------------------
-- Import report: one row per sheet per import run.
-- ---------------------------------------------------------------------------
create table if not exists import_report (
    report_id               bigserial primary key,
    run_id                  text not null,
    run_at                  timestamptz not null default now(),
    target_schema           text not null,
    source_file             text not null,
    sheet                   text not null,
    rows_read               integer not null,
    duplicate_rows_removed  integer not null,
    conflicting_ids         integer not null,
    rows_loaded             integer not null,
    notes                   text
);

-- ---------------------------------------------------------------------------
-- Execution: the five strategic bets and the tasks that carry them out.
-- ---------------------------------------------------------------------------
create table if not exists initiatives (
    initiative_id       serial primary key,
    rank                integer,
    name                text not null,
    hypothesis          text,
    owner_id            text references team(owner_id) on update cascade on delete set null,
    budget_inr          integer check (budget_inr >= 0),
    start_date          date,
    end_date            date,
    primary_kpi         text,
    scale_rule          text,
    change_rule         text,
    stop_rule           text,
    expected_visitors   integer,
    status              text not null default 'planned'
                        check (status in ('planned', 'testing', 'scaling', 'paused', 'stopped', 'done')),
    campaign_ids        text[] not null default '{}'
);

create table if not exists tasks (
    task_id        serial primary key,
    title          text not null check (length(title) between 1 and 200),
    description    text,
    owner_id       text references team(owner_id) on update cascade on delete set null,
    due_date       date,
    status         text not null default 'todo' check (status in ('todo', 'in_progress', 'blocked', 'done')),
    priority       text not null default 'medium' check (priority in ('high', 'medium', 'low')),
    campaign_id    text references campaigns(campaign_id) on update cascade on delete set null,
    initiative_id  integer references initiatives(initiative_id) on delete set null,
    source         text not null default 'manual' check (source in ('manual', 'copilot')),
    -- What the person or copilot was looking at when the task was created:
    -- the as-of date and the numbers behind the recommendation.
    evidence       jsonb,
    created_at     timestamptz not null default now(),
    updated_at     timestamptz not null default now()
);

-- Editable model parameters (e.g. the show-up rate used for projections before
-- the event). Each is tagged with where its value comes from.
create table if not exists assumptions (
    key    text primary key,
    label  text not null,
    value  numeric not null,
    unit   text,
    basis  text not null check (basis in ('sourced', 'derived', 'assumed')),
    note   text
);

-- ---------------------------------------------------------------------------
-- Attach the change-log trigger to every table the app lets people edit.
-- ---------------------------------------------------------------------------
do $$
declare
    t record;
begin
    for t in select * from (values
        ('targets', 'version_id'), ('team', 'owner_id'), ('campaigns', 'campaign_id'),
        ('daily_marketing', 'activity_id'), ('people', 'person_id'), ('interactions', 'interaction_id'),
        ('registrations', 'registration_id'), ('registration_history', 'history_id'),
        ('checkins', 'event_id'), ('tasks', 'task_id'), ('initiatives', 'initiative_id'),
        ('assumptions', 'key')
    ) as v(tbl, pk) loop
        execute format('drop trigger if exists log_change on public.%I', t.tbl);
        execute format(
            'create trigger log_change after insert or update or delete on public.%I '
            'for each row execute function log_change(%L)', t.tbl, t.pk);
    end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Reset the working data to the pristine copy in schema `original`.
-- Tasks, bets and assumptions are kept. Campaigns and team members are
-- upserted rather than deleted, so tasks linked to them keep their links.
-- ---------------------------------------------------------------------------
create or replace function reset_to_original(p_actor text default 'user') returns void
language plpgsql as $$
begin
    perform set_config('app.bulk', 'on', true);

    delete from public.checkins;
    delete from public.registration_history;
    delete from public.registrations;
    delete from public.interactions;
    delete from public.people;
    delete from public.daily_marketing;
    delete from public.targets;
    delete from public.event;
    delete from public.campaigns c where not exists (select 1 from original.campaigns o where o.campaign_id = c.campaign_id);

    insert into public.team select * from original.team
        on conflict (owner_id) do update set owner_name = excluded.owner_name;
    delete from public.team t
        where not exists (select 1 from original.team o where o.owner_id = t.owner_id)
          and not exists (select 1 from public.tasks k where k.owner_id = t.owner_id)
          and not exists (select 1 from public.initiatives i where i.owner_id = t.owner_id);

    insert into public.campaigns select * from original.campaigns
        on conflict (campaign_id) do update set
            campaign_name = excluded.campaign_name, channel = excluded.channel,
            target_audience = excluded.target_audience, objective = excluded.objective,
            owner_id = excluded.owner_id, created_at = excluded.created_at,
            planned_start_at = excluded.planned_start_at, planned_end_at = excluded.planned_end_at,
            status = excluded.status, planned_budget_inr = excluded.planned_budget_inr;

    insert into public.event select * from original.event;
    insert into public.targets select * from original.targets;
    perform setval(pg_get_serial_sequence('public.targets', 'version_id'),
                   greatest((select max(version_id) from public.targets), 1));
    insert into public.people select * from original.people;
    insert into public.registrations select * from original.registrations;
    insert into public.registration_history select * from original.registration_history;
    insert into public.interactions select * from original.interactions;
    insert into public.daily_marketing select * from original.daily_marketing;
    insert into public.checkins select * from original.checkins;

    perform set_config('app.bulk', 'off', true);
    insert into public.change_log (actor, table_name, row_id, action, note)
    values (p_actor, '*', null, 'reset', 'Working data reset to the original workbook');
end $$;

-- True when the working data differs from the original (drives the banner).
create or replace function data_differs_from_original() returns boolean
language sql stable as $$
    select exists (select * from public.targets except select * from original.targets)
        or exists (select * from original.targets except select * from public.targets)
        or exists (select * from public.campaigns except select * from original.campaigns)
        or exists (select * from original.campaigns except select * from public.campaigns)
        or exists (select * from public.daily_marketing except select * from original.daily_marketing)
        or exists (select * from original.daily_marketing except select * from public.daily_marketing)
        or exists (select * from public.people except select * from original.people)
        or exists (select * from original.people except select * from public.people)
        or exists (select * from public.registrations except select * from original.registrations)
        or exists (select * from original.registrations except select * from public.registrations)
        or exists (select * from public.registration_history except select * from original.registration_history)
        or exists (select * from original.registration_history except select * from public.registration_history)
        or exists (select * from public.checkins except select * from original.checkins)
        or exists (select * from original.checkins except select * from public.checkins)
        or exists (select * from public.interactions except select * from original.interactions)
        or exists (select * from original.interactions except select * from public.interactions)
$$;
