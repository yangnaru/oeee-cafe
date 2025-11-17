-- Revert: Rename devices table back to push_tokens
ALTER TABLE devices RENAME TO push_tokens;

-- Revert: Rename indexes back
ALTER INDEX idx_devices_user_id RENAME TO idx_push_tokens_user_id;
ALTER INDEX idx_devices_device_token RENAME TO idx_push_tokens_device_token;
