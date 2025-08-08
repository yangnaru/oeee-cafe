-- Remove public column from collaborative_sessions table
DROP INDEX IF EXISTS idx_collaborative_sessions_public;
ALTER TABLE collaborative_sessions DROP COLUMN is_public;