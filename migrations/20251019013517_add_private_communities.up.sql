-- Create visibility enum type
CREATE TYPE community_visibility AS ENUM ('public', 'unlisted', 'private');

-- Add visibility column to communities
ALTER TABLE communities ADD COLUMN visibility community_visibility;

-- Migrate existing data: is_private=false -> public, is_private=true -> unlisted
UPDATE communities SET visibility = 'public' WHERE is_private = false;
UPDATE communities SET visibility = 'unlisted' WHERE is_private = true;

-- Make visibility column NOT NULL
ALTER TABLE communities ALTER COLUMN visibility SET NOT NULL;

-- Drop old is_private column
ALTER TABLE communities DROP COLUMN is_private;

-- Create community member role enum
CREATE TYPE community_member_role AS ENUM ('owner', 'moderator', 'member');

-- Create community_members table
CREATE TABLE community_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id uuid NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role community_member_role NOT NULL DEFAULT 'member',
  joined_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  invited_by uuid REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE(community_id, user_id)
);

-- Create indexes for community_members
CREATE INDEX idx_community_members_community_id ON community_members(community_id);
CREATE INDEX idx_community_members_user_id ON community_members(user_id);

-- Create community_invitations table
CREATE TYPE community_invitation_status AS ENUM ('pending', 'accepted', 'rejected');

CREATE TABLE community_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id uuid NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  inviter_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invitee_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status community_invitation_status NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(community_id, invitee_id, status)
);

-- Create indexes for community_invitations
CREATE INDEX idx_community_invitations_invitee_id ON community_invitations(invitee_id);
CREATE INDEX idx_community_invitations_community_id ON community_invitations(community_id);
CREATE INDEX idx_community_invitations_status ON community_invitations(status);

-- Populate community_members with all current community owners
INSERT INTO community_members (community_id, user_id, role)
SELECT id, owner_id, 'owner'
FROM communities;
