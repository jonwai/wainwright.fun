-- Homework sites for Home Assistant, and each child's daily internet allowance.
-- Profiles and DNS payloads are unchanged: the iPads already have their DNS, and HA
-- decides which of these hostnames are reachable. A full kids re-import from hosted
-- writes homework back to false, because hosted website items do not have the flag.
-- allowance_seconds is left alone when a write omits it (hosted children do not have it).
ALTER TABLE kids.websites
  ADD COLUMN homework boolean NOT NULL DEFAULT false;

ALTER TABLE kids.child_settings
  ADD COLUMN allowance_seconds integer NOT NULL DEFAULT 3600
  CHECK (allowance_seconds >= 0 AND allowance_seconds <= 86400);
