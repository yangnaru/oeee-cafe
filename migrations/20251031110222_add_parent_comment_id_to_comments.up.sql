-- Add parent_comment_id to enable comment threading
ALTER TABLE comments
ADD COLUMN parent_comment_id uuid DEFAULT NULL REFERENCES comments(id) ON DELETE CASCADE;

-- Add index for efficient queries
CREATE INDEX idx_comments_parent_comment_id ON comments(parent_comment_id);
