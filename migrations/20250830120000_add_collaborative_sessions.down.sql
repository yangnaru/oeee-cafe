-- Drop collaborative sessions tables and indexes
DROP INDEX IF EXISTS idx_collab_participants_active;
DROP INDEX IF EXISTS idx_collab_participants_user;
DROP INDEX IF EXISTS idx_collab_participants_session;
DROP INDEX IF EXISTS idx_collab_sessions_activity;
DROP INDEX IF EXISTS idx_collab_sessions_owner;
DROP INDEX IF EXISTS idx_collab_sessions_public_active;

DROP TABLE IF EXISTS collaborative_sessions_participants;
DROP TABLE IF EXISTS collaborative_sessions;

-- Remove neo-cucumber from tool enum
-- Fail if any 'neo-cucumber' values exist
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM images WHERE tool = 'neo-cucumber') THEN
        RAISE EXCEPTION 'Cannot drop neo-cucumber enum value: images with tool = ''neo-cucumber'' still exist';
    END IF;
END $$;

-- Create a new enum type without 'neo-cucumber'
CREATE TYPE tool_new AS ENUM ('neo', 'tegaki', 'cucumber');

-- Update existing values
ALTER TABLE images ALTER COLUMN tool TYPE tool_new USING tool::text::tool_new;

-- Drop old type and rename new type
DROP TYPE tool;
ALTER TYPE tool_new RENAME TO tool;

-- Revert making images.replay_filename nullable
-- Note: This will fail if there are null values in replay_filename
-- First, update any null values to a placeholder
UPDATE images SET replay_filename = 'placeholder.pch' WHERE replay_filename IS NULL;
-- Then make the column NOT NULL again
ALTER TABLE images ALTER COLUMN replay_filename SET NOT NULL;