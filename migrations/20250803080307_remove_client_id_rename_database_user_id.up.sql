-- Remove client_id column and rename database_user_id to user_id in collaborative_session_users table

-- First, drop the unique constraint on (session_id, client_id)
ALTER TABLE collaborative_session_users DROP CONSTRAINT drawpile_session_users_session_id_client_id_key;

-- Drop the client_id column
ALTER TABLE collaborative_session_users DROP COLUMN client_id;

-- Drop the index on database_user_id
DROP INDEX IF EXISTS idx_collaborative_session_users_database_user;

-- Rename database_user_id to user_id (but this conflicts with existing user_id for drawpile protocol)
-- First rename the existing user_id column to protocol_user_id
ALTER TABLE collaborative_session_users RENAME COLUMN user_id TO protocol_user_id;

-- Now rename database_user_id to user_id
ALTER TABLE collaborative_session_users RENAME COLUMN database_user_id TO user_id;

-- Create new index for user_id
CREATE INDEX idx_collaborative_session_users_user_id ON collaborative_session_users(user_id);

-- Update the unique constraint to use protocol_user_id instead
ALTER TABLE collaborative_session_users ADD CONSTRAINT collaborative_session_users_session_id_protocol_user_id_key UNIQUE(session_id, protocol_user_id);