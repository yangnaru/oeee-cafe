CREATE TABLE email_verification_challenges (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    email text NOT NULL,
    token char(6) NOT NULL,
    created_at timestamptz NOT NULL DEFAULT NOW(),
    expires_at timestamptz NOT NULL,
    CONSTRAINT ck_email_verification_challenges_email_emailaddress CHECK (email ~ '^[^@]+@[^@]+$')
);

CREATE UNIQUE INDEX idx_users_email ON users(email);
