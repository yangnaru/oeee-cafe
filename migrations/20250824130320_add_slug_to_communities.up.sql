-- Add slug column to communities table
ALTER TABLE communities ADD COLUMN slug varchar(255) NOT NULL DEFAULT '';

-- Set default slug to community ID for existing rows
UPDATE communities SET slug = id::text WHERE slug = '';

-- Add constraint for URL-safe slug with length limit
ALTER TABLE communities 
  ADD CONSTRAINT CK_communities_slug_RegularExpression 
  CHECK (slug ~ '^[a-zA-Z0-9_-]{1,50}$');