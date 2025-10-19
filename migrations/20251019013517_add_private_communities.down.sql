-- Drop community_invitations table
DROP TABLE IF EXISTS community_invitations;

-- Drop community_invitation_status enum
DROP TYPE IF EXISTS community_invitation_status;

-- Drop community_members table
DROP TABLE IF EXISTS community_members;

-- Drop community_member_role enum
DROP TYPE IF EXISTS community_member_role;

-- Re-add is_private column
ALTER TABLE communities ADD COLUMN is_private boolean;

-- Migrate data back: public/unlisted -> false, private -> true
UPDATE communities SET is_private = false WHERE visibility IN ('public', 'unlisted');
UPDATE communities SET is_private = true WHERE visibility = 'private';

-- Make is_private NOT NULL
ALTER TABLE communities ALTER COLUMN is_private SET NOT NULL;

-- Drop visibility column
ALTER TABLE communities DROP COLUMN visibility;

-- Drop visibility enum type
DROP TYPE IF EXISTS community_visibility;
