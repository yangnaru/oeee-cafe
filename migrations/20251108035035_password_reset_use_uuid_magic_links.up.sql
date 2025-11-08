-- Create password reset challenges table with UUID-based magic links
-- This provides better security through:
-- 1. No token collision risk (UUIDs are globally unique)
-- 2. Longer, more secure tokens (128-bit)
-- 3. Clickable email links for better UX

CREATE TABLE password_reset_challenges (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    email text NOT NULL,
    token uuid NOT NULL UNIQUE,
    created_at timestamptz NOT NULL DEFAULT NOW(),
    expires_at timestamptz NOT NULL,
    CONSTRAINT ck_password_reset_challenges_email_emailaddress CHECK (email ~ '^[^@]+@[^@]+$')
);

CREATE INDEX idx_password_reset_challenges_user_id ON password_reset_challenges(user_id);
CREATE INDEX idx_password_reset_challenges_token ON password_reset_challenges(token);
