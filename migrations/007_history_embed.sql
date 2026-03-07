ALTER TABLE play_history ADD COLUMN message_id TEXT;
ALTER TABLE play_history ADD COLUMN volume INTEGER NOT NULL DEFAULT 5;

INSERT OR IGNORE INTO app_config (key, value) VALUES ('history_channel_id', '');
INSERT OR IGNORE INTO app_config (key, value) VALUES ('web_base_url', '');
