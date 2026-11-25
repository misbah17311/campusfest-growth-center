-- Tables that mirror the source workbook (one per data sheet), plus `team`,
-- which is derived from the owner IDs and names that appear in the sheets.
--
-- This file is run twice by db/load_workbook.py: once with search_path set to
-- `original` (the pristine copy used by "Reset to original") and once with
-- search_path set to `public` (the working copy the app edits).
--
-- Conventions
--   * Every source timestamp is IST (+05:30); stored as timestamptz.
--   * Source IDs are the primary keys. Import-retry duplicates (same ID,
--     identical row) are removed by the loader before insert, so each ID is
--     stored once; the loader's import report records how many were removed.
--   * Display names (person_name, campaign_name, owner_name) are stored once,
--     on the entity they describe, and joined where needed. The source
--     repeats them on every row; IDs are the stable keys (source Read me).
--   * CHECK constraints encode the value lists in the source field guide, so
--     an edited workbook with an unknown status is rejected with a clear error.

create table if not exists event (
    event_name       text primary key,
    history_start    date not null,
    history_end      date not null,
    event_starts_at  timestamptz not null,
    event_ends_at    timestamptz not null,
    timezone         text not null,
    currency         text not null,
    fictional        boolean not null
);

create table if not exists team (
    owner_id    text primary key,
    owner_name  text not null
);

-- Each row is one full version of the plan; the version in force on a date is
-- the latest one whose effective_at is at or before the end of that day.
create table if not exists targets (
    version_id                       serial primary key,
    effective_at                     timestamptz not null unique,
    identified_external_people_goal  integer not null check (identified_external_people_goal >= 0),
    registration_goal                integer not null check (registration_goal >= 0),
    unique_external_visitors_goal    integer not null check (unique_external_visitors_goal >= 0),
    marketing_budget_inr             integer not null check (marketing_budget_inr >= 0),
    target_version                   text not null,
    -- Added by us (not in the source): optional venue limit, so capacity can
    -- be tested as a constraint. Null in the original data.
    venue_capacity_per_day           integer check (venue_capacity_per_day > 0)
);

create table if not exists campaigns (
    campaign_id       text primary key,
    campaign_name     text not null,
    channel           text not null,
    target_audience   text,
    objective         text,
    owner_id          text references team(owner_id) on update cascade on delete set null,
    created_at        timestamptz not null,
    planned_start_at  timestamptz,
    planned_end_at    timestamptz,
    -- Added by us (not in the source): execution status and an optional
    -- per-campaign budget allocation. Defaults keep the original data valid.
    status              text not null default 'active' check (status in ('active', 'paused', 'stopped')),
    planned_budget_inr  integer check (planned_budget_inr >= 0)
);

-- Anonymous daily platform counts (NOT people) and net spend per campaign/day.
create table if not exists daily_marketing (
    activity_id            text primary key,
    campaign_id            text not null references campaigns(campaign_id) on update cascade,
    owner_id               text references team(owner_id) on update cascade on delete set null,
    activity_date          date not null,
    impressions            integer not null check (impressions >= 0),
    clicks                 integer not null check (clicks >= 0),
    reported_reach         integer not null check (reported_reach >= 0),
    landing_page_sessions  integer not null check (landing_page_sessions >= 0),
    registration_starts    integer not null check (registration_starts >= 0),
    marketing_spend_inr    integer not null,  -- negative = vendor credit
    platform               text
);
create index if not exists daily_marketing_campaign_date on daily_marketing (campaign_id, activity_date);

create table if not exists people (
    person_id           text primary key,
    person_name         text not null,
    person_type         text not null check (person_type in ('external', 'internal', 'staff', 'test')),
    first_seen_at       timestamptz not null,
    first_touch_source  text not null check (first_touch_source in ('campaign', 'internal_registration', 'walk_in', 'event_access')),
    first_campaign_id   text references campaigns(campaign_id) on update cascade on delete set null,
    owner_id            text references team(owner_id) on update cascade on delete set null
);

create table if not exists interactions (
    interaction_id  text primary key,
    person_id       text not null references people(person_id) on update cascade,
    campaign_id     text references campaigns(campaign_id) on update cascade on delete set null,
    owner_id        text references team(owner_id) on update cascade on delete set null,
    occurred_at     timestamptz not null,
    event_type      text not null check (event_type in (
                        'page_visit', 'brochure_download', 'registration_start', 'event_question_submitted',
                        'nurture_email_sent', 'nurture_email_opened', 'nurture_email_clicked', 'opted_out')),
    detail          text
);
create index if not exists interactions_person on interactions (person_id);
create index if not exists interactions_campaign_type on interactions (campaign_id, event_type);

create table if not exists registrations (
    registration_id  text primary key,
    person_id        text not null references people(person_id) on update cascade,
    campaign_id      text references campaigns(campaign_id) on update cascade on delete set null,
    owner_id         text references team(owner_id) on update cascade on delete set null,
    registered_at    timestamptz not null
);
create index if not exists registrations_person on registrations (person_id);

-- Full-state status versions; use the latest version at or before a date.
create table if not exists registration_history (
    history_id       text primary key,
    registration_id  text not null references registrations(registration_id) on update cascade on delete cascade,
    person_id        text not null references people(person_id) on update cascade,
    campaign_id      text references campaigns(campaign_id) on update cascade on delete set null,
    owner_id         text references team(owner_id) on update cascade on delete set null,
    effective_at     timestamptz not null,
    status           text not null check (status in ('interested', 'confirmed', 'cancelled', 'waitlisted'))
);
create index if not exists registration_history_reg_time on registration_history (registration_id, effective_at desc);

-- Admission observations. Only external + admitted + verified counts as attendance.
create table if not exists checkins (
    event_id         text primary key,
    person_id        text not null references people(person_id) on update cascade,
    registration_id  text references registrations(registration_id) on update cascade on delete set null,
    campaign_id      text references campaigns(campaign_id) on update cascade on delete set null,
    owner_id         text references team(owner_id) on update cascade on delete set null,
    occurred_at      timestamptz not null,
    result           text not null check (result in ('admitted', 'denied', 'pending')),
    verification     text not null check (verification in ('verified', 'unverified')),
    source           text not null check (source in ('scanner', 'manual'))
);
create index if not exists checkins_person on checkins (person_id);
