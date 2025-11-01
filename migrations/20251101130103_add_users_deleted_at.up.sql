-- Add up migration script here
ALTER TABLE users ADD COLUMN deleted_at TIMESTAMPTZ;

-- Create index for filtering deleted users
CREATE INDEX idx_users_deleted_at ON users(deleted_at) WHERE deleted_at IS NOT NULL;
