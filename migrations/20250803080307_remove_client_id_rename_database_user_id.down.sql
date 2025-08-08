-- Reverse the changes: add back client_id column and rename user_id back to database_user_id

-- Drop the new constraint
ALTER TABLE collaborative_session_users DROP CONSTRAINT collaborative_session_users_session_id_protocol_user_id_key;

-- Drop the new index
DROP INDEX IF EXISTS idx_collaborative_session_users_user_id;

-- Rename user_id back to database_user_id
ALTER TABLE collaborative_session_users RENAME COLUMN user_id TO database_user_id;

-- Rename protocol_user_id back to user_id  
ALTER TABLE collaborative_session_users RENAME COLUMN protocol_user_id TO user_id;

-- Add back the client_id column
ALTER TABLE collaborative_session_users ADD COLUMN client_id VARCHAR(255) NOT NULL DEFAULT '';

-- Restore the original unique constraints
ALTER TABLE collaborative_session_users ADD CONSTRAINT drawpile_session_users_session_id_user_id_key UNIQUE(session_id, user_id);
ALTER TABLE collaborative_session_users ADD CONSTRAINT drawpile_session_users_session_id_client_id_key UNIQUE(session_id, client_id);

-- Restore the original index
CREATE INDEX idx_collaborative_session_users_database_user ON collaborative_session_users(database_user_id);