-- Add index on post_id for efficient deletion of notifications when posts are deleted
CREATE INDEX idx_notifications_post_id ON notifications(post_id);
