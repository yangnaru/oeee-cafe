-- Site-wide user role. Mirrors the community_member_role pattern so moderators
-- can be granted a subset of admin powers later without another migration.
CREATE TYPE user_role AS ENUM ('user', 'moderator', 'admin');

ALTER TABLE users ADD COLUMN role user_role NOT NULL DEFAULT 'user';

-- Admin listings scan by role; everyone else is 'user' so a partial index keeps
-- it tiny.
CREATE INDEX idx_users_role ON users(role) WHERE role <> 'user';
