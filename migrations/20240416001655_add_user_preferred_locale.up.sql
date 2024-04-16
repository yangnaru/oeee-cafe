CREATE TYPE preferred_language AS ENUM('ko', 'ja', 'en');
ALTER TABLE users ADD COLUMN preferred_language preferred_language DEFAULT NULL;
