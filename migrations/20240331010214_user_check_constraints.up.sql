ALTER TABLE users
  ADD CONSTRAINT CK_users_login_name_RegularExpression CHECK (login_name ~ '^[a-zA-Z0-9_-]{1,50}$');

ALTER TABLE users
  ADD CONSTRAINT CK_users_email_EmailAddress CHECK (email ~ '^[^@]+@[^@]+$');

ALTER TABLE users
  ADD CONSTRAINT CK_users_display_name_MinLength CHECK (LENGTH(display_name) >= 1);

ALTER TABLE users
  ADD CONSTRAINT CK_users_display_name_RegularExpression CHECK (display_name ~ '^\\S.*?\\S$|^\\S$');
