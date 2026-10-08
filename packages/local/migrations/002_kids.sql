-- The iPad launcher and profile config (wainwright.fun apex and admin) on the home network: the
-- hosted wainwright-children/-apps/-websites/-themes/-restrictions tables, relational.
-- Children ARE core.people (id = the hosted subdomain; name, date of birth, colour and avatar live
-- there and nowhere else). Only what is iPad-specific about a child is kept here.
-- Device tokens and pairing codes are not modelled: devices are recognised by IP (core.devices).
CREATE SCHEMA kids;

CREATE TABLE kids.child_settings (
  child_id              text PRIMARY KEY,
  child_role            text NOT NULL DEFAULT 'child' CHECK (child_role = 'child'),
  locked                boolean NOT NULL DEFAULT true,
  restriction_overrides jsonb CHECK (restriction_overrides IS NULL OR jsonb_typeof(restriction_overrides) = 'object'),
  blocked_apps          text[],
  extra                 jsonb NOT NULL DEFAULT '{}',
  FOREIGN KEY (child_id, child_role) REFERENCES core.people (id, role) ON UPDATE CASCADE ON DELETE CASCADE
);

CREATE TABLE kids.apps (
  bundle_id     text PRIMARY KEY CHECK (bundle_id <> ''),
  name          text NOT NULL,
  type          text NOT NULL CHECK (type IN ('app', 'system')),
  app_store_url text,
  category      text,
  icon          text,
  show_on_site  boolean,
  min_age       integer NOT NULL DEFAULT 0 CHECK (min_age >= 0),
  enabled       boolean NOT NULL DEFAULT true,
  extra         jsonb NOT NULL DEFAULT '{}'
);

CREATE TABLE kids.websites (
  url        text PRIMARY KEY CHECK (url <> ''),
  name       text NOT NULL,
  icon       text,
  category   text,
  min_age    integer NOT NULL DEFAULT 0 CHECK (min_age >= 0),
  enabled    boolean NOT NULL DEFAULT true,
  -- A child's own website (hosted child_subdomain); NULL = shared, gated by min_age.
  child_id   text,
  child_role text CHECK ((child_id IS NULL) = (child_role IS NULL) AND (child_role IS NULL OR child_role = 'child')),
  extra      jsonb NOT NULL DEFAULT '{}',
  FOREIGN KEY (child_id, child_role) REFERENCES core.people (id, role) ON UPDATE CASCADE
);
CREATE FUNCTION kids.website_child_role() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.child_role := CASE WHEN NEW.child_id IS NULL THEN NULL ELSE 'child' END;
  RETURN NEW;
END $$;
CREATE TRIGGER websites_child_role BEFORE INSERT OR UPDATE ON kids.websites FOR EACH ROW EXECUTE FUNCTION kids.website_child_role();

CREATE TABLE kids.themes (
  from_age              integer PRIMARY KEY CHECK (from_age >= 0),
  theme                 text NOT NULL,
  subtitle              text NOT NULL DEFAULT '',
  restriction_overrides jsonb CHECK (restriction_overrides IS NULL OR jsonb_typeof(restriction_overrides) = 'object'),
  extra                 jsonb NOT NULL DEFAULT '{}'
);

CREATE TABLE kids.restrictions (
  key         text PRIMARY KEY CHECK (key <> ''),
  value       jsonb NOT NULL,
  type        text NOT NULL,
  overridable boolean,
  extra       jsonb NOT NULL DEFAULT '{}'
);

-- Every profile handed out (who, which device, what exactly), for checking what an iPad installed.
CREATE TABLE kids.profile_downloads (
  id          bigserial PRIMARY KEY,
  child_id    text NOT NULL,
  child_role  text NOT NULL DEFAULT 'child' CHECK (child_role = 'child'),
  ip          inet,
  viewer_id   text,
  sha256      text NOT NULL,
  bytes       integer NOT NULL,
  signed      boolean NOT NULL,
  at          timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (child_id, child_role) REFERENCES core.people (id, role) ON UPDATE CASCADE
);
