-- Drop Drawpile session tables
DROP TRIGGER IF EXISTS trigger_drawpile_sessions_updated_at ON drawpile_sessions;
DROP FUNCTION IF EXISTS update_drawpile_session_updated_at();

DROP INDEX IF EXISTS idx_drawpile_session_users_database_user;
DROP INDEX IF EXISTS idx_drawpile_session_users_connected;
DROP INDEX IF EXISTS idx_drawpile_session_users_session;

DROP INDEX IF EXISTS idx_drawpile_messages_received_at;
DROP INDEX IF EXISTS idx_drawpile_messages_session_type;
DROP INDEX IF EXISTS idx_drawpile_messages_session_sequence;

DROP INDEX IF EXISTS idx_drawpile_sessions_owner;
DROP INDEX IF EXISTS idx_drawpile_sessions_active;
DROP INDEX IF EXISTS idx_drawpile_sessions_room_id;

DROP TABLE IF EXISTS drawpile_session_users;
DROP TABLE IF EXISTS drawpile_messages;
DROP TABLE IF EXISTS drawpile_sessions;