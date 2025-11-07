-- Create enum type for post deletion reasons
CREATE TYPE post_deletion_reason AS ENUM (
    'user_deleted',      -- User explicitly deleted their post
    'community_cascade', -- Post deleted because community was deleted
    'moderation'         -- Moderator removed post (includes spam)
);

-- Add column as nullable (stays nullable since non-deleted posts don't have a reason)
ALTER TABLE posts ADD COLUMN deletion_reason post_deletion_reason DEFAULT NULL;

-- Backfill: Set all existing soft-deleted posts to 'user_deleted'
UPDATE posts
SET deletion_reason = 'user_deleted'
WHERE deleted_at IS NOT NULL;
