ALTER TABLE images ADD COLUMN deleted_at timestamptz DEFAULT NULL;
ALTER TABLE posts ADD COLUMN deleted_at timestamptz DEFAULT NULL;
ALTER TABLE posts ALTER COLUMN is_sensitive DROP NOT NULL;
