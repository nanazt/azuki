CREATE TABLE queue_items (
    position INTEGER NOT NULL PRIMARY KEY,
    track_id TEXT NOT NULL REFERENCES tracks(id),
    added_by TEXT NOT NULL,
    added_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO app_config (key, value) VALUES ('loop_mode', 'off');
