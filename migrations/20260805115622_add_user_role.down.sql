DROP INDEX IF EXISTS idx_users_role;

ALTER TABLE users DROP COLUMN role;

DROP TYPE user_role;
