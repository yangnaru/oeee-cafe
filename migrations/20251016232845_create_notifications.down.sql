-- Drop indexes
DROP INDEX IF EXISTS idx_notifications_recipient_created;
DROP INDEX IF EXISTS idx_notifications_created_at;
DROP INDEX IF EXISTS idx_notifications_recipient_unread;
DROP INDEX IF EXISTS idx_notifications_recipient_id;

-- Drop table
DROP TABLE IF EXISTS notifications;

-- Drop enum type
DROP TYPE IF EXISTS notification_type;
