-- Add public column to collaborative_sessions table
ALTER TABLE collaborative_sessions 
ADD COLUMN is_public BOOLEAN NOT NULL DEFAULT FALSE;

-- Create index for public sessions
CREATE INDEX idx_collaborative_sessions_public ON collaborative_sessions(is_public) WHERE is_public = TRUE;

-- Update existing sessions without owner to be public
UPDATE collaborative_sessions 
SET is_public = TRUE 
WHERE owner_user_id IS NULL;