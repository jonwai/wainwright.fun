-- Tickets on the home network: the hosted wainwright-tasks, -task-completions, -job-board,
-- -rewards and -reward-redemptions tables as relational tables joined to core.people.
-- Child ids are core.people ids (the hosted child_subdomain values).
CREATE SCHEMA IF NOT EXISTS tickets;

-- Every element of a child list must be a child in core.people.
CREATE FUNCTION tickets.assert_children(ids text[]) RETURNS void LANGUAGE plpgsql AS $$
DECLARE missing text;
BEGIN
  SELECT string_agg(x, ', ') INTO missing FROM unnest(ids) AS x
  WHERE NOT EXISTS (SELECT 1 FROM core.people p WHERE p.id = x AND p.role = 'child');
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'not a child in core.people: %', missing USING ERRCODE = 'foreign_key_violation';
  END IF;
END
$$;

CREATE FUNCTION tickets.check_assigned_to() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM tickets.assert_children(NEW.assigned_to);
  RETURN NEW;
END
$$;

-- Task library. "bonus" is reserved for parent bonus awards; "chores#…" for household chores.
CREATE TABLE tickets.tasks (
  task_id       text PRIMARY KEY CHECK (task_id <> '' AND task_id <> 'bonus' AND task_id !~ '^chores#'),
  title         text NOT NULL,
  description   text,
  ticket_reward integer NOT NULL CHECK (ticket_reward >= 0),
  assigned_to   text[] NOT NULL DEFAULT '{}',
  icon          text,
  emoji         text,
  enabled       boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL,
  updated_at    timestamptz NOT NULL,
  extra         jsonb NOT NULL DEFAULT '{}'   -- attributes the hosted code adds that we do not model
);
CREATE TRIGGER tasks_assigned_to BEFORE INSERT OR UPDATE OF assigned_to ON tickets.tasks
  FOR EACH ROW EXECUTE FUNCTION tickets.check_assigned_to();

-- Job board postings. task_id is not a foreign key: hosted deletes a task without its postings.
CREATE TABLE tickets.board (
  board_id        text PRIMARY KEY,
  task_id         text NOT NULL,
  repeat          text NOT NULL CHECK (repeat IN ('once', 'daily', 'school_day', 'on_demand')),
  ticket_reward   integer NOT NULL CHECK (ticket_reward >= 0),
  assigned_to     text[] NOT NULL DEFAULT '{}',
  posted          boolean NOT NULL DEFAULT true,
  posted_at       timestamptz,
  completion_mode text NOT NULL CHECK (completion_mode IN ('each_child', 'first_done')),
  created_at      timestamptz NOT NULL,
  updated_at      timestamptz NOT NULL,
  extra           jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX board_task_idx ON tickets.board (task_id);
CREATE TRIGGER board_assigned_to BEFORE INSERT OR UPDATE OF assigned_to ON tickets.board
  FOR EACH ROW EXECUTE FUNCTION tickets.check_assigned_to();

-- Ticket awards: the completion log. A child's total is the sum; undo deletes the newest.
-- task_completion is the hosted sort key (`task_id#completed_at#rand`), unique per child.
-- source says who wrote it: the hosted import, the local tickets app, or a household chore.
-- (source, source_ref) makes awards from other apps idempotent.
CREATE TABLE tickets.awards (
  id              bigserial PRIMARY KEY,
  child_id        text NOT NULL,
  child_role      text NOT NULL DEFAULT 'child' CHECK (child_role = 'child'),
  task_completion text NOT NULL,
  task_id         text NOT NULL,
  completed_at    timestamptz NOT NULL,
  completed_by    text NOT NULL CHECK (completed_by IN ('child', 'parent')),
  tickets         integer NOT NULL,
  label           text,
  source          text NOT NULL DEFAULT 'tickets' CHECK (source IN ('hosted', 'tickets', 'household')),
  source_ref      text,
  extra           jsonb NOT NULL DEFAULT '{}',
  FOREIGN KEY (child_id, child_role) REFERENCES core.people (id, role) ON UPDATE CASCADE,
  UNIQUE (child_id, task_completion),
  UNIQUE (source, source_ref),
  CHECK (task_completion LIKE task_id || '#%'),
  CHECK (source = 'tickets' OR source_ref IS NOT NULL)
);

CREATE TABLE tickets.rewards (
  reward_id          text PRIMARY KEY CHECK (reward_id <> ''),
  title              text NOT NULL,
  description        text,
  ticket_cost        integer NOT NULL CHECK (ticket_cost >= 0),
  cost_pence         integer CHECK (cost_pence >= 0),
  icon               text,
  emoji              text,
  limit_type         text CHECK (limit_type IN ('unlimited', 'stock', 'period', 'snack_stock')),
  stock_remaining    integer CHECK (stock_remaining >= 0),
  period             text CHECK (period IN ('week', 'month', 'summer', 'term', 'year')),
  snack_product_slug text,
  enabled            boolean NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL,
  updated_at         timestamptz NOT NULL,
  extra              jsonb NOT NULL DEFAULT '{}'
);

-- Redemptions: pending until a parent marks the prize received. reward_id is not a foreign
-- key: hosted lets a parent delete a reward and keeps its history.
CREATE TABLE tickets.redemptions (
  id            bigserial PRIMARY KEY,
  child_id      text NOT NULL,
  child_role    text NOT NULL DEFAULT 'child' CHECK (child_role = 'child'),
  redemption_id text NOT NULL,
  reward_id     text NOT NULL,
  redeemed_at   timestamptz NOT NULL,
  redeemed_by   text NOT NULL CHECK (redeemed_by IN ('child', 'parent')),
  tickets       integer NOT NULL CHECK (tickets >= 0),
  status        text NOT NULL CHECK (status IN ('pending', 'claimed')),
  claimed_at    timestamptz,
  source        text NOT NULL DEFAULT 'tickets' CHECK (source IN ('hosted', 'tickets')),
  extra         jsonb NOT NULL DEFAULT '{}',
  FOREIGN KEY (child_id, child_role) REFERENCES core.people (id, role) ON UPDATE CASCADE,
  UNIQUE (child_id, redemption_id),
  CHECK (status = 'claimed' OR claimed_at IS NULL)
);

-- Earned, spent and spendable per child (spent counts every redemption, any status).
CREATE VIEW tickets.balances AS
SELECT p.id AS child_id,
       COALESCE((SELECT sum(a.tickets) FROM tickets.awards a WHERE a.child_id = p.id), 0)::integer AS earned,
       COALESCE((SELECT sum(r.tickets) FROM tickets.redemptions r WHERE r.child_id = p.id), 0)::integer AS spent,
       (COALESCE((SELECT sum(a.tickets) FROM tickets.awards a WHERE a.child_id = p.id), 0)
        - COALESCE((SELECT sum(r.tickets) FROM tickets.redemptions r WHERE r.child_id = p.id), 0))::integer AS spendable,
       (SELECT count(*) FROM tickets.redemptions r WHERE r.child_id = p.id AND r.status = 'pending')::integer AS pending
FROM core.people p
WHERE p.role = 'child';

-- One lock for every ticket write (family-sized traffic), so a balance check and the write
-- after it cannot interleave with another app's award.
CREATE FUNCTION tickets.lock() RETURNS void LANGUAGE sql AS $$ SELECT pg_advisory_xact_lock(4207341) $$;

-- Awards tickets from another app in the caller's transaction. Idempotent on
-- (source, source_ref): a repeat returns the existing award's id.
CREATE FUNCTION tickets.award(
  p_child_id text, p_task_id text, p_tickets integer, p_label text,
  p_source text, p_source_ref text, p_at timestamptz DEFAULT now(), p_by text DEFAULT 'child'
) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE award_id bigint;
BEGIN
  IF p_source = 'tickets' OR p_source_ref IS NULL THEN
    RAISE EXCEPTION 'tickets.award needs another app''s source and a source_ref';
  END IF;
  PERFORM tickets.lock();
  SELECT id INTO award_id FROM tickets.awards WHERE source = p_source AND source_ref = p_source_ref;
  IF award_id IS NOT NULL THEN RETURN award_id; END IF;
  INSERT INTO tickets.awards (child_id, task_completion, task_id, completed_at, completed_by, tickets, label, source, source_ref)
  VALUES (
    p_child_id,
    p_task_id || '#' || to_char(p_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') || '#' || substr(md5(p_source || ':' || p_source_ref), 1, 6),
    p_task_id, p_at, p_by, p_tickets, p_label, p_source, p_source_ref
  )
  RETURNING id INTO award_id;
  RETURN award_id;
END
$$;

-- Takes back an award made by tickets.award. True when one was removed.
CREATE FUNCTION tickets.revoke(p_source text, p_source_ref text) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE removed integer;
BEGIN
  PERFORM tickets.lock();
  DELETE FROM tickets.awards WHERE source = p_source AND source_ref = p_source_ref;
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed > 0;
END
$$;
