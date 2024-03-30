CREATE TABLE banners (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  image_id uuid NOT NULL REFERENCES images (id),
  author_id uuid NOT NULL REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE users ADD COLUMN banner_id uuid REFERENCES banners (id) NULL;
