-- Revert content and content_html columns to NOT NULL
-- Note: This will fail if there are any NULL values in these columns
ALTER TABLE comments ALTER COLUMN content SET NOT NULL;
ALTER TABLE comments ALTER COLUMN content_html SET NOT NULL;
