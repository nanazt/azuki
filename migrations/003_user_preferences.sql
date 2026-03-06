CREATE TABLE IF NOT EXISTS user_preferences (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    default_volume INTEGER NOT NULL DEFAULT 5 CHECK (default_volume >= 0 AND default_volume <= 100),
    default_loop_mode TEXT NOT NULL DEFAULT 'off' CHECK (default_loop_mode IN ('off', 'one', 'all')),
    theme TEXT NOT NULL DEFAULT 'dark' CHECK (theme IN ('dark')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
