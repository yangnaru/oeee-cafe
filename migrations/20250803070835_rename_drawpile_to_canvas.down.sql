-- Reverse rename all canvas tables back to drawpile tables

-- Rename function and trigger back
DROP TRIGGER trigger_canvas_sessions_updated_at ON canvas_sessions;
DROP FUNCTION update_canvas_session_updated_at();

CREATE OR REPLACE FUNCTION update_drawpile_session_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Note: This trigger will be recreated on the renamed table after tables are renamed back

-- Rename indexes back
ALTER INDEX idx_canvas_sessions_room_id RENAME TO idx_drawpile_sessions_room_id;
ALTER INDEX idx_canvas_sessions_active RENAME TO idx_drawpile_sessions_active;
ALTER INDEX idx_canvas_sessions_owner RENAME TO idx_drawpile_sessions_owner;

ALTER INDEX idx_canvas_messages_session_sequence RENAME TO idx_drawpile_messages_session_sequence;
ALTER INDEX idx_canvas_messages_session_type RENAME TO idx_drawpile_messages_session_type;
ALTER INDEX idx_canvas_messages_received_at RENAME TO idx_drawpile_messages_received_at;

ALTER INDEX idx_canvas_session_users_session RENAME TO idx_drawpile_session_users_session;
ALTER INDEX idx_canvas_session_users_connected RENAME TO idx_drawpile_session_users_connected;
ALTER INDEX idx_canvas_session_users_database_user RENAME TO idx_drawpile_session_users_database_user;

-- Update foreign key references back
ALTER TABLE canvas_messages DROP CONSTRAINT canvas_messages_session_id_fkey;
ALTER TABLE canvas_messages ADD CONSTRAINT drawpile_messages_session_id_fkey 
    FOREIGN KEY (session_id) REFERENCES drawpile_sessions(id) ON DELETE CASCADE;

ALTER TABLE canvas_session_users DROP CONSTRAINT canvas_session_users_session_id_fkey;
ALTER TABLE canvas_session_users ADD CONSTRAINT drawpile_session_users_session_id_fkey 
    FOREIGN KEY (session_id) REFERENCES drawpile_sessions(id) ON DELETE CASCADE;

-- Rename the tables back
ALTER TABLE canvas_sessions RENAME TO drawpile_sessions;
ALTER TABLE canvas_messages RENAME TO drawpile_messages;
ALTER TABLE canvas_session_users RENAME TO drawpile_session_users;

-- Recreate trigger on renamed table
CREATE TRIGGER trigger_drawpile_sessions_updated_at
    BEFORE UPDATE ON drawpile_sessions
    FOR EACH ROW
    EXECUTE FUNCTION update_drawpile_session_updated_at();
