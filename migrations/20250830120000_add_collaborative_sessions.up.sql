-- Add collaborative drawing sessions
CREATE TABLE collaborative_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID NOT NULL REFERENCES users(id),
  community_id UUID NOT NULL REFERENCES communities(id),
  max_participants INTEGER NOT NULL,
  title TEXT,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  is_public BOOLEAN NOT NULL, -- Only affects lobby visibility
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  last_activity TIMESTAMP NOT NULL DEFAULT NOW(),
  ended_at TIMESTAMPTZ,
  saved_post_id UUID REFERENCES posts(id)
);

-- Track participants in collaborative sessions
CREATE TABLE collaborative_sessions_participants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES collaborative_sessions(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id),
  joined_at TIMESTAMP NOT NULL DEFAULT NOW(),
  left_at TIMESTAMP,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE(session_id, user_id)
);

-- Make images.replay_filename column nullable for collaborative drawings
-- Collaborative drawings (neo-cucumber tool) don't have replay files
ALTER TABLE images ALTER COLUMN replay_filename DROP NOT NULL;

-- Add 'neo-cucumber' value to the tool enum for collaborative drawing sessions
ALTER TYPE tool ADD VALUE 'neo-cucumber';

-- Add indexes for performance
CREATE INDEX idx_collab_sessions_public_active ON collaborative_sessions(is_public, ended_at) 
  WHERE is_public = TRUE AND ended_at IS NULL;
CREATE INDEX idx_collab_sessions_owner ON collaborative_sessions(owner_id);
CREATE INDEX idx_collab_sessions_activity ON collaborative_sessions(last_activity DESC);
CREATE INDEX idx_collab_participants_session ON collaborative_sessions_participants(session_id);
CREATE INDEX idx_collab_participants_user ON collaborative_sessions_participants(user_id);
CREATE INDEX idx_collab_participants_active ON collaborative_sessions_participants(session_id, is_active) 
  WHERE is_active = TRUE;