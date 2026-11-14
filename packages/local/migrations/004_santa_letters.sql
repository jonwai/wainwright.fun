-- Letters to Santa from the home-network launcher. Each send is its own row.
-- The launcher and admin.wainwright.fun show the latest row per child.
CREATE TABLE kids.santa_letters (
  id           bigserial PRIMARY KEY,
  child_id     text NOT NULL REFERENCES core.people (id) ON UPDATE CASCADE,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  answers      jsonb NOT NULL CHECK (jsonb_typeof(answers) = 'object'),
  own_line     text,
  drawing_png  bytea,
  letter_text  text NOT NULL,
  client_ip    inet
);

CREATE INDEX santa_letters_child_submitted_idx
  ON kids.santa_letters (child_id, submitted_at DESC, id DESC);
