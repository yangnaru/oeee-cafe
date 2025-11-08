-- Make content and content_html columns nullable to support soft-delete
ALTER TABLE comments ALTER COLUMN content DROP NOT NULL;
ALTER TABLE comments ALTER COLUMN content_html DROP NOT NULL;
