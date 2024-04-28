ALTER TABLE posts ALTER COLUMN is_sensitive SET NOT NULL;
ALTER TABLE posts DROP COLUMN deleted_at;
ALTER TABLE images DROP COLUMN deleted_at;
