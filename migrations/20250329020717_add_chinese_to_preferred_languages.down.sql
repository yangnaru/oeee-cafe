-- Create a new enum type without 'zh'
CREATE TYPE preferred_language_new AS ENUM ('ko', 'ja', 'en');

-- Update existing values (if any 'zh' exists, convert to default 'en')
ALTER TABLE users 
    ALTER COLUMN preferred_language TYPE preferred_language_new 
    USING (CASE WHEN preferred_language::text = 'zh' 
                            THEN 'en'::preferred_language_new 
                            ELSE preferred_language::text::preferred_language_new 
                 END);

-- Drop old type and rename new type
DROP TYPE preferred_language;
ALTER TYPE preferred_language_new RENAME TO preferred_language;