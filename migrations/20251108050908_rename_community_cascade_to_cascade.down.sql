-- Rename enum value from 'cascade' back to 'community_cascade'
ALTER TYPE post_deletion_reason RENAME VALUE 'cascade' TO 'community_cascade';
