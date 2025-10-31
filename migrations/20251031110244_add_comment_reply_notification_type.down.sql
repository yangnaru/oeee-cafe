-- Note: PostgreSQL doesn't support removing enum values directly
-- We need to recreate the enum type without 'comment_reply'

-- First, restore the original constraint
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notification_reference_check;

ALTER TABLE notifications ADD CONSTRAINT notification_reference_check CHECK (
    (notification_type = 'comment' AND post_id IS NOT NULL AND comment_id IS NOT NULL) OR
    (notification_type = 'reaction' AND post_id IS NOT NULL AND reaction_iri IS NOT NULL) OR
    (notification_type = 'follow' AND post_id IS NULL AND comment_id IS NULL AND reaction_iri IS NULL AND guestbook_entry_id IS NULL) OR
    (notification_type = 'guestbook_entry' AND guestbook_entry_id IS NOT NULL) OR
    (notification_type = 'guestbook_reply' AND guestbook_entry_id IS NOT NULL) OR
    (notification_type = 'mention' AND post_id IS NOT NULL AND comment_id IS NOT NULL) OR
    (notification_type = 'post_reply' AND post_id IS NOT NULL)
);

-- Delete any notifications of type 'comment_reply' before attempting to drop the enum value
DELETE FROM notifications WHERE notification_type = 'comment_reply';

-- Note: The enum value 'comment_reply' will remain in the database
-- Removing enum values requires recreating the entire type, which is complex and risky
-- This is a limitation of PostgreSQL enum types
