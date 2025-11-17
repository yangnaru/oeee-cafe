-- Rename push_tokens table to devices
ALTER TABLE push_tokens RENAME TO devices;

-- Rename indexes
ALTER INDEX idx_push_tokens_user_id RENAME TO idx_devices_user_id;
ALTER INDEX idx_push_tokens_device_token RENAME TO idx_devices_device_token;
