-- One reply from Santa for each letter. The words themselves are inserted into this
-- table after deploy; they are not stored in this repository.
-- The child's launcher includes a reply only once now() is at or after reveal_at.
CREATE TABLE kids.santa_replies (
  id         bigserial PRIMARY KEY,
  letter_id  bigint NOT NULL UNIQUE REFERENCES kids.santa_letters (id) ON UPDATE CASCADE,
  child_id   text NOT NULL REFERENCES core.people (id) ON UPDATE CASCADE,
  reply_text text NOT NULL,
  reveal_at  timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
