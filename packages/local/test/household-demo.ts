import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";

const dir = path.dirname(fileURLToPath(import.meta.url));

/** Household main shape, including the optional PR #3 columns the reader detects. */
export async function installHouseholdSchema(db: pg.Pool | pg.PoolClient): Promise<void> {
  await db.query(await readFile(path.join(dir, "household-demo.sql"), "utf8"));
}

export async function seedHousehold(db: pg.Pool | pg.PoolClient): Promise<void> {
  await installHouseholdSchema(db);
  await db.query(`
    INSERT INTO household.rooms (id, name, floor, area_m2, carpeted) VALUES
      ('kitchen', 'Kitchen', 0, 8.2, false),
      ('bathroom', 'Bathroom', 1, 5.7, false),
      ('lounge', 'Lounge', 1, 14.3, true);

    INSERT INTO household.fixtures (id, room_id, name) VALUES
      ('oven-kitchen', 'kitchen', 'Oven'),
      ('bin-kitchen', 'kitchen', 'Bin'),
      ('sink-bathroom', 'bathroom', 'Sink'),
      ('toilet-bathroom', 'bathroom', 'Toilet');

    INSERT INTO household.windows (id, room_id, name) VALUES
      ('window-kitchen', 'kitchen', 'Kitchen window');

    INSERT INTO household.switches (id, room_id, name, battery_dead) VALUES
      ('switch-lounge', 'lounge', 'Lounge switch', false);

    INSERT INTO household.chores (id, target_type, room_id, fixture_id, window_id, switch_id, job, title, base_tickets, reset_days, enabled, kind, term_time) VALUES
      ('hoover-bathroom', 'room', 'bathroom', NULL, NULL, NULL, 'vacuum', 'Hoover the bathroom', 4, 7, true, NULL, false),
      ('clean-oven', 'fixture', 'kitchen', 'oven-kitchen', NULL, NULL, 'clean', 'Clean the oven', 5, 14, true, NULL, false),
      ('empty-bin', 'fixture', 'kitchen', 'bin-kitchen', NULL, NULL, 'empty', 'Empty the kitchen bin', 2, 3, true, NULL, false),
      ('wipe-sink', 'fixture', 'bathroom', 'sink-bathroom', NULL, NULL, 'wipe', 'Wipe the sink', 2, 7, true, NULL, false),
      ('tidy-playroom', 'room', 'lounge', NULL, NULL, NULL, 'tidy', 'Tidy the playroom', 3, 7, true, NULL, false),
      ('pack-bag', 'room', 'kitchen', NULL, NULL, NULL, 'pack', 'Pack the school bag', 1, 1, true, 'routine', true),
      ('clean-window', 'window', 'kitchen', NULL, 'window-kitchen', NULL, 'clean', 'Clean the kitchen window', 2, 14, true, NULL, false),
      ('change-battery', 'switch', 'lounge', NULL, NULL, 'switch-lounge', 'batteries', 'Change the switch battery', 1, 30, true, NULL, false),
      ('retired-chore', 'room', 'kitchen', NULL, NULL, NULL, 'dust', 'Dust the skirting', 1, 7, false, NULL, false);

    INSERT INTO household.chore_allowed_claimers (chore_id, child_id) VALUES ('wipe-sink', 'hannah');

    INSERT INTO household.chore_claims (chore_id, child_id, status, claimed_at) VALUES
      ('empty-bin', 'lydia', 'claimed', now() - interval '20 minutes'),
      ('tidy-playroom', 'zoe', 'held', now() - interval '5 minutes');

    INSERT INTO household.chore_completions (chore_id, child_id, completed_at, tickets, source_ref) VALUES
      ('clean-oven', 'zoe', now() - interval '1 hour', 5, 'seed:clean-oven');

    INSERT INTO tickets.tasks (task_id, title, description, ticket_reward, assigned_to, emoji, enabled, created_at, updated_at)
    VALUES ('tidy-room', 'Tidy your room', 'Put your toys away', 2, '{}', '🧸', true, now(), now())
    ON CONFLICT (task_id) DO NOTHING;
  `);
  await db.query(
    `UPDATE core.term_dates SET opens = CURRENT_DATE - 30, closes = CURRENT_DATE + 30,
       half_term_start = CURRENT_DATE + 10, half_term_end = CURRENT_DATE + 14`,
  );
  await db.query(
    `SELECT tickets.award('zoe', 'chores#clean-oven', 5, 'Clean the oven', 'household', 'seed:clean-oven', now() - interval '1 hour')`,
  );
}

/** The same chores with none of the PR #3 columns or tables present. */
export async function seedHouseholdMinimal(db: pg.Pool | pg.PoolClient): Promise<void> {
  await db.query(`
    DROP SCHEMA IF EXISTS household CASCADE;
    CREATE SCHEMA household;
    CREATE TABLE household.rooms (
      id text PRIMARY KEY, name text NOT NULL, floor integer NOT NULL, area_m2 double precision NOT NULL, enabled boolean NOT NULL DEFAULT true
    );
    CREATE TABLE household.fixtures (
      id text PRIMARY KEY, room_id text NOT NULL, name text NOT NULL, enabled boolean NOT NULL DEFAULT true
    );
    CREATE TABLE household.chores (
      id text PRIMARY KEY,
      target_type text NOT NULL,
      room_id text,
      fixture_id text,
      window_id text,
      switch_id text,
      job text,
      title text NOT NULL,
      base_tickets integer NOT NULL,
      reset_days integer NOT NULL,
      enabled boolean NOT NULL DEFAULT true
    );
    CREATE TABLE household.chore_claims (
      id bigserial PRIMARY KEY,
      chore_id text NOT NULL,
      child_id text NOT NULL,
      claimed_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE household.chore_completions (
      id bigserial PRIMARY KEY,
      chore_id text NOT NULL,
      child_id text NOT NULL,
      completed_at timestamptz NOT NULL DEFAULT now()
    );
    INSERT INTO household.rooms VALUES ('bathroom', 'Bathroom', 1, 5.7, true);
    INSERT INTO household.fixtures VALUES ('toilet-bathroom', 'bathroom', 'Toilet', true);
    INSERT INTO household.chores (id, target_type, room_id, fixture_id, job, title, base_tickets, reset_days)
    VALUES
      ('hoover-bathroom', 'room', 'bathroom', NULL, 'vacuum', 'Hoover the bathroom', 4, 7),
      ('brush-toilet', 'fixture', NULL, 'toilet-bathroom', 'brush', 'Brush the toilet', 2, 3);
  `);
}
