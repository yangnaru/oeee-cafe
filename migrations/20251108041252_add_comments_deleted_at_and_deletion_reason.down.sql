-- Drop index
DROP INDEX idx_comments_deleted_at;

-- Drop columns
ALTER TABLE comments DROP COLUMN deletion_reason;
ALTER TABLE comments DROP COLUMN deleted_at;
