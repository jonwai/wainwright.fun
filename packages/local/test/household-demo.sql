-- Tables Household owns on main. Tickets reads them and never writes them.
-- kind, term_time and chore_allowed_claimers match the pending Household PR and
-- are optional: the reader still works after they are removed.
DROP SCHEMA IF EXISTS household CASCADE;
CREATE SCHEMA household;

CREATE TABLE household.rooms (
  id text PRIMARY KEY,
  name text NOT NULL,
  floor integer NOT NULL,
  area_m2 double precision NOT NULL,
  carpeted boolean NOT NULL DEFAULT false,
  enabled boolean NOT NULL DEFAULT true
);

CREATE TABLE household.fixtures (
  id text PRIMARY KEY,
  room_id text NOT NULL REFERENCES household.rooms (id),
  name text NOT NULL,
  enabled boolean NOT NULL DEFAULT true
);

CREATE TABLE household.windows (
  id text PRIMARY KEY,
  room_id text NOT NULL REFERENCES household.rooms (id),
  name text NOT NULL,
  enabled boolean NOT NULL DEFAULT true
);

CREATE TABLE household.switches (
  id text PRIMARY KEY,
  room_id text NOT NULL REFERENCES household.rooms (id),
  name text NOT NULL,
  battery_dead boolean NOT NULL DEFAULT false,
  enabled boolean NOT NULL DEFAULT true
);

CREATE TABLE household.chores (
  id text PRIMARY KEY,
  target_type text NOT NULL CHECK (target_type IN ('room', 'fixture', 'window', 'switch')),
  room_id text REFERENCES household.rooms (id),
  fixture_id text REFERENCES household.fixtures (id),
  window_id text REFERENCES household.windows (id),
  switch_id text REFERENCES household.switches (id),
  job text,
  title text NOT NULL,
  base_tickets integer NOT NULL CHECK (base_tickets >= 0),
  reset_days integer NOT NULL CHECK (reset_days > 0),
  enabled boolean NOT NULL DEFAULT true,
  kind text,
  term_time boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true
);

CREATE TABLE household.chore_claims (
  id bigserial PRIMARY KEY,
  chore_id text NOT NULL REFERENCES household.chores (id),
  child_id text NOT NULL,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'claimed'
);

CREATE TABLE household.chore_completions (
  id bigserial PRIMARY KEY,
  chore_id text NOT NULL REFERENCES household.chores (id),
  child_id text NOT NULL,
  completed_at timestamptz NOT NULL DEFAULT now(),
  tickets integer,
  source_ref text UNIQUE
);

CREATE TABLE household.chore_allowed_claimers (
  chore_id text NOT NULL REFERENCES household.chores (id),
  child_id text NOT NULL,
  PRIMARY KEY (chore_id, child_id)
);
