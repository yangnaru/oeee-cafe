-- Remove parent_comment_id column and index
DROP INDEX IF EXISTS idx_comments_parent_comment_id;

ALTER TABLE comments
DROP COLUMN parent_comment_id;
