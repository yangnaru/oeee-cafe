-- Remove constraints
ALTER TABLE communities DROP CONSTRAINT CK_communities_display_name_MinLength;
ALTER TABLE communities DROP CONSTRAINT CK_communities_display_name_RegularExpression;

-- Remove display_name column
ALTER TABLE communities DROP COLUMN display_name;