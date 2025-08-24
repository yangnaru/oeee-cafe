-- Add display_name column to communities table
ALTER TABLE communities ADD COLUMN display_name varchar(255) NOT NULL DEFAULT '';

-- Set default display_name to community ID for existing rows
UPDATE communities SET display_name = id::text WHERE display_name = '';

-- Add constraints like users table
ALTER TABLE communities 
  ADD CONSTRAINT CK_communities_display_name_MinLength 
  CHECK (LENGTH(display_name) >= 1);

ALTER TABLE communities 
  ADD CONSTRAINT CK_communities_display_name_RegularExpression 
  CHECK (display_name !~ '^\\S.*?\\S$|^\\S$');