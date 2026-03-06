-- tracks 테이블에 곡별 볼륨 추가 (정수 0-100, 기본 5)
ALTER TABLE tracks ADD COLUMN volume INTEGER NOT NULL DEFAULT 5
    CHECK (volume >= 0 AND volume <= 100);

-- 기존 app_config 테이블에 봇 기본 볼륨 추가
INSERT OR IGNORE INTO app_config (key, value) VALUES ('default_volume', '5');

-- user_preferences: default_volume, default_loop_mode 제거 (theme만 유지)
CREATE TABLE user_preferences_new (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    theme TEXT NOT NULL DEFAULT 'dark' CHECK (theme IN ('dark')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO user_preferences_new (user_id, theme, updated_at)
    SELECT user_id, theme, updated_at FROM user_preferences;
DROP TABLE user_preferences;
ALTER TABLE user_preferences_new RENAME TO user_preferences;
