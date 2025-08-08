-- Rename canvas tables to collaborative tables

-- Rename the tables
ALTER TABLE canvas_sessions RENAME TO collaborative_sessions;
ALTER TABLE canvas_messages RENAME TO collaborative_messages;
ALTER TABLE canvas_session_users RENAME TO collaborative_session_users;

-- Update foreign key references
ALTER TABLE collaborative_messages DROP CONSTRAINT canvas_messages_session_id_fkey;
ALTER TABLE collaborative_messages ADD CONSTRAINT collaborative_messages_session_id_fkey 
    FOREIGN KEY (session_id) REFERENCES collaborative_sessions(id) ON DELETE CASCADE;

ALTER TABLE collaborative_session_users DROP CONSTRAINT canvas_session_users_session_id_fkey;
ALTER TABLE collaborative_session_users ADD CONSTRAINT collaborative_session_users_session_id_fkey 
    FOREIGN KEY (session_id) REFERENCES collaborative_sessions(id) ON DELETE CASCADE;

-- Rename indexes
ALTER INDEX idx_canvas_sessions_room_id RENAME TO idx_collaborative_sessions_room_id;
ALTER INDEX idx_canvas_sessions_active RENAME TO idx_collaborative_sessions_active;
ALTER INDEX idx_canvas_sessions_owner RENAME TO idx_collaborative_sessions_owner;

ALTER INDEX idx_canvas_messages_session_sequence RENAME TO idx_collaborative_messages_session_sequence;
ALTER INDEX idx_canvas_messages_session_type RENAME TO idx_collaborative_messages_session_type;
ALTER INDEX idx_canvas_messages_received_at RENAME TO idx_collaborative_messages_received_at;

ALTER INDEX idx_canvas_session_users_session RENAME TO idx_collaborative_session_users_session;
ALTER INDEX idx_canvas_session_users_connected RENAME TO idx_collaborative_session_users_connected;
ALTER INDEX idx_canvas_session_users_database_user RENAME TO idx_collaborative_session_users_database_user;

-- Rename function and trigger
DROP TRIGGER trigger_canvas_sessions_updated_at ON collaborative_sessions;
DROP FUNCTION update_canvas_session_updated_at();

CREATE OR REPLACE FUNCTION update_collaborative_session_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_collaborative_sessions_updated_at
    BEFORE UPDATE ON collaborative_sessions
    FOR EACH ROW
    EXECUTE FUNCTION update_collaborative_session_updated_at();
