-- Remove constraints
ALTER TABLE communities DROP CONSTRAINT CK_communities_slug_MinLength;
ALTER TABLE communities DROP CONSTRAINT CK_communities_slug_RegularExpression;

-- Remove slug column
ALTER TABLE communities DROP COLUMN slug;