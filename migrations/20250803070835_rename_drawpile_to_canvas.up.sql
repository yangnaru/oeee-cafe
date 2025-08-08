-- Rename all drawpile tables to canvas tables

-- Rename the tables
ALTER TABLE drawpile_sessions RENAME TO canvas_sessions;
ALTER TABLE drawpile_messages RENAME TO canvas_messages;
ALTER TABLE drawpile_session_users RENAME TO canvas_session_users;

-- Update foreign key references
ALTER TABLE canvas_messages DROP CONSTRAINT drawpile_messages_session_id_fkey;
ALTER TABLE canvas_messages ADD CONSTRAINT canvas_messages_session_id_fkey 
    FOREIGN KEY (session_id) REFERENCES canvas_sessions(id) ON DELETE CASCADE;

ALTER TABLE canvas_session_users DROP CONSTRAINT drawpile_session_users_session_id_fkey;
ALTER TABLE canvas_session_users ADD CONSTRAINT canvas_session_users_session_id_fkey 
    FOREIGN KEY (session_id) REFERENCES canvas_sessions(id) ON DELETE CASCADE;

-- Rename indexes
ALTER INDEX idx_drawpile_sessions_room_id RENAME TO idx_canvas_sessions_room_id;
ALTER INDEX idx_drawpile_sessions_active RENAME TO idx_canvas_sessions_active;
ALTER INDEX idx_drawpile_sessions_owner RENAME TO idx_canvas_sessions_owner;

ALTER INDEX idx_drawpile_messages_session_sequence RENAME TO idx_canvas_messages_session_sequence;
ALTER INDEX idx_drawpile_messages_session_type RENAME TO idx_canvas_messages_session_type;
ALTER INDEX idx_drawpile_messages_received_at RENAME TO idx_canvas_messages_received_at;

ALTER INDEX idx_drawpile_session_users_session RENAME TO idx_canvas_session_users_session;
ALTER INDEX idx_drawpile_session_users_connected RENAME TO idx_canvas_session_users_connected;
ALTER INDEX idx_drawpile_session_users_database_user RENAME TO idx_canvas_session_users_database_user;

-- Rename function and trigger
DROP TRIGGER trigger_drawpile_sessions_updated_at ON canvas_sessions;
DROP FUNCTION update_drawpile_session_updated_at();

CREATE OR REPLACE FUNCTION update_canvas_session_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_canvas_sessions_updated_at
    BEFORE UPDATE ON canvas_sessions
    FOR EACH ROW
    EXECUTE FUNCTION update_canvas_session_updated_at();
