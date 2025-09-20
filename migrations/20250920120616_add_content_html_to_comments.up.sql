-- Add content_html column to comments table to store HTML content from ActivityPub
ALTER TABLE comments ADD COLUMN content_html TEXT;