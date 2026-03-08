-- theme CHECK 제약 확장: dark/light/system 지원
CREATE TABLE user_preferences_new (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    theme TEXT NOT NULL DEFAULT 'dark' CHECK (theme IN ('dark', 'light', 'system')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO user_preferences_new (user_id, theme, updated_at)
    SELECT user_id, theme, updated_at FROM user_preferences;
DROP TABLE user_preferences;
ALTER TABLE user_preferences_new RENAME TO user_preferences;
