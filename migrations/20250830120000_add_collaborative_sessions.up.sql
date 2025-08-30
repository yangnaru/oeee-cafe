-- Add collaborative drawing sessions
CREATE TABLE collaborative_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID NOT NULL REFERENCES users(id),
  community_id UUID NOT NULL REFERENCES communities(id),
  title TEXT,
  description TEXT,
  width INTEGER NOT NULL DEFAULT 500,
  height INTEGER NOT NULL DEFAULT 500,
  is_public BOOLEAN NOT NULL DEFAULT TRUE, -- Only affects lobby visibility
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  last_activity TIMESTAMP NOT NULL DEFAULT NOW(),
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
  contribution_count INTEGER DEFAULT 0,
  UNIQUE(session_id, user_id)
);

-- Add indexes for performance
CREATE INDEX idx_collab_sessions_public_active ON collaborative_sessions(is_public, is_active) 
  WHERE is_public = TRUE AND is_active = TRUE;
CREATE INDEX idx_collab_sessions_owner ON collaborative_sessions(owner_id);
CREATE INDEX idx_collab_sessions_activity ON collaborative_sessions(last_activity DESC);
CREATE INDEX idx_collab_participants_session ON collaborative_sessions_participants(session_id);
CREATE INDEX idx_collab_participants_user ON collaborative_sessions_participants(user_id);
CREATE INDEX idx_collab_participants_active ON collaborative_sessions_participants(session_id, is_active) 
  WHERE is_active = TRUE;