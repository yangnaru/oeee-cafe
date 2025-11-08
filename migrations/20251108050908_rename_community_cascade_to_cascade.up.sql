-- Rename enum value from 'community_cascade' to 'cascade'
ALTER TYPE post_deletion_reason RENAME VALUE 'community_cascade' TO 'cascade';
