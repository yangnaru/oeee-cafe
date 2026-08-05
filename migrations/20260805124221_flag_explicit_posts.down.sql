DROP INDEX IF EXISTS idx_posts_is_explicit;

ALTER TABLE posts DROP COLUMN explicit_flagged_by;
ALTER TABLE posts DROP COLUMN explicit_flagged_at;
ALTER TABLE posts DROP COLUMN is_explicit;
