CREATE TABLE links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  url TEXT NOT NULL,
  description TEXT NOT NULL,
  index int NOT NULL,
  created_at timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL
);

ALTER TABLE links ADD CONSTRAINT CK_links_url_Url CHECK (url ~ 'https?://.*');
