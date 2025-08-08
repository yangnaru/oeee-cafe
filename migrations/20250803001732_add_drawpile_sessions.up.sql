-- Add Drawpile session and canvas state tables
CREATE TABLE drawpile_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    room_id VARCHAR(255) NOT NULL UNIQUE,
    title VARCHAR(255),
    description TEXT,
    max_users INTEGER DEFAULT 20,
    canvas_width INTEGER NOT NULL DEFAULT 800,
    canvas_height INTEGER NOT NULL DEFAULT 600,
    background_color BIGINT DEFAULT 4294967295, -- ARGB format (0xFFFFFFFF)
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    owner_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE
);

-- Store individual drawing messages/commands for session replay
CREATE TABLE drawpile_messages (
    id BIGSERIAL PRIMARY KEY,
    session_id UUID NOT NULL REFERENCES drawpile_sessions(id) ON DELETE CASCADE,
    sequence_number BIGINT NOT NULL, -- Order of messages in session
    message_type SMALLINT NOT NULL, -- Drawpile message type (64-127 for commands, etc.)
    user_id SMALLINT NOT NULL, -- Drawpile user ID (not database user)
    user_name VARCHAR(255), -- Store user name for replay
    message_data BYTEA NOT NULL, -- Raw message payload
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    
    UNIQUE(session_id, sequence_number)
);

-- Store current active users in sessions
CREATE TABLE drawpile_session_users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID NOT NULL REFERENCES drawpile_sessions(id) ON DELETE CASCADE,
    user_id SMALLINT NOT NULL, -- Drawpile protocol user ID
    client_id VARCHAR(255) NOT NULL, -- WebSocket client identifier
    user_name VARCHAR(255) NOT NULL,
    database_user_id UUID REFERENCES users(id) ON DELETE SET NULL, -- Link to actual user account if authenticated
    joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_activity TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    is_connected BOOLEAN NOT NULL DEFAULT TRUE,
    
    UNIQUE(session_id, user_id),
    UNIQUE(session_id, client_id)
);

-- Create indexes for performance
CREATE INDEX idx_drawpile_sessions_room_id ON drawpile_sessions(room_id);
CREATE INDEX idx_drawpile_sessions_active ON drawpile_sessions(is_active) WHERE is_active = TRUE;
CREATE INDEX idx_drawpile_sessions_owner ON drawpile_sessions(owner_user_id);

CREATE INDEX idx_drawpile_messages_session_sequence ON drawpile_messages(session_id, sequence_number);
CREATE INDEX idx_drawpile_messages_session_type ON drawpile_messages(session_id, message_type);
CREATE INDEX idx_drawpile_messages_received_at ON drawpile_messages(received_at);

CREATE INDEX idx_drawpile_session_users_session ON drawpile_session_users(session_id);
CREATE INDEX idx_drawpile_session_users_connected ON drawpile_session_users(session_id, is_connected) WHERE is_connected = TRUE;
CREATE INDEX idx_drawpile_session_users_database_user ON drawpile_session_users(database_user_id);

-- Add trigger to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_drawpile_session_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_drawpile_sessions_updated_at
    BEFORE UPDATE ON drawpile_sessions
    FOR EACH ROW
    EXECUTE FUNCTION update_drawpile_session_updated_at();