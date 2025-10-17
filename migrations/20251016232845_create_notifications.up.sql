-- Create notification_type enum with all notification types
CREATE TYPE notification_type AS ENUM (
    'comment',
    'reaction',
    'follow',
    'guestbook_entry',
    'guestbook_reply',
    'mention',
    'post_reply'
);

-- Create notifications table
CREATE TABLE notifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    recipient_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    actor_id UUID NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
    notification_type notification_type NOT NULL,

    -- Polymorphic references to different resource types
    post_id UUID REFERENCES posts(id) ON DELETE CASCADE,
    comment_id UUID REFERENCES comments(id) ON DELETE CASCADE,
    reaction_iri TEXT REFERENCES reactions(iri) ON DELETE CASCADE,
    guestbook_entry_id UUID REFERENCES guestbook_entries(id) ON DELETE CASCADE,

    read_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- Ensure at least one reference is set based on notification type
    CONSTRAINT notification_reference_check CHECK (
        (notification_type = 'comment' AND post_id IS NOT NULL AND comment_id IS NOT NULL) OR
        (notification_type = 'reaction' AND post_id IS NOT NULL AND reaction_iri IS NOT NULL) OR
        (notification_type = 'follow' AND post_id IS NULL AND comment_id IS NULL AND reaction_iri IS NULL AND guestbook_entry_id IS NULL) OR
        (notification_type = 'guestbook_entry' AND guestbook_entry_id IS NOT NULL) OR
        (notification_type = 'guestbook_reply' AND guestbook_entry_id IS NOT NULL) OR
        (notification_type = 'mention' AND post_id IS NOT NULL AND comment_id IS NOT NULL) OR
        (notification_type = 'post_reply' AND post_id IS NOT NULL)
    )
);

-- Indexes for efficient queries
CREATE INDEX idx_notifications_recipient_id ON notifications(recipient_id);
CREATE INDEX idx_notifications_recipient_unread ON notifications(recipient_id) WHERE read_at IS NULL;
CREATE INDEX idx_notifications_created_at ON notifications(created_at DESC);

-- Composite index for common query patterns
CREATE INDEX idx_notifications_recipient_created ON notifications(recipient_id, created_at DESC);
