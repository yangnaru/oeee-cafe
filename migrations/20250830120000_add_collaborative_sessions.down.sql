-- Drop collaborative sessions tables and indexes
DROP INDEX IF EXISTS idx_collab_participants_active;
DROP INDEX IF EXISTS idx_collab_participants_user;
DROP INDEX IF EXISTS idx_collab_participants_session;
DROP INDEX IF EXISTS idx_collab_sessions_activity;
DROP INDEX IF EXISTS idx_collab_sessions_owner;
DROP INDEX IF EXISTS idx_collab_sessions_public_active;

DROP TABLE IF EXISTS collaborative_sessions_participants;
DROP TABLE IF EXISTS collaborative_sessions;