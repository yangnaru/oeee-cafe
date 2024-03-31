ALTER TABLE users
    DROP CONSTRAINT CK_users_login_name_RegularExpression;

ALTER TABLE users
    DROP CONSTRAINT CK_users_email_EmailAddress;

ALTER TABLE users
    DROP CONSTRAINT CK_users_display_name_MinLength;

ALTER TABLE users
    DROP CONSTRAINT CK_users_display_name_RegularExpression;
