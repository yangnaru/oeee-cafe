-- Add soft-delete columns to comments table
ALTER TABLE comments ADD COLUMN deleted_at TIMESTAMPTZ DEFAULT NULL;
ALTER TABLE comments ADD COLUMN deletion_reason comment_deletion_reason DEFAULT NULL;

-- Add index for performance when filtering out deleted comments
CREATE INDEX idx_comments_deleted_at ON comments(deleted_at) WHERE deleted_at IS NOT NULL;
