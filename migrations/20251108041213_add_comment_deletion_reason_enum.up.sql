-- Create enum type for comment deletion reasons
CREATE TYPE comment_deletion_reason AS ENUM (
    'user_deleted',      -- User explicitly deleted their comment
    'moderation',        -- Moderator removed comment (includes spam)
    'cascade'            -- Comment deleted because post or parent was deleted
);
