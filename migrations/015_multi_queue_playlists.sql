-- 1a. playlists 테이블 확장
ALTER TABLE playlists ADD COLUMN source_kind TEXT;
ALTER TABLE playlists ADD COLUMN source_id TEXT;
ALTER TABLE playlists ADD COLUMN source_url TEXT;
ALTER TABLE playlists ADD COLUMN description TEXT;
ALTER TABLE playlists ADD COLUMN thumbnail_url TEXT;
ALTER TABLE playlists ADD COLUMN channel_name TEXT;
ALTER TABLE playlists ADD COLUMN track_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE playlists ADD COLUMN last_synced_at TEXT;

-- 1b. 외부 플레이리스트 중복 방지
CREATE UNIQUE INDEX idx_playlists_source ON playlists(source_kind, source_id)
  WHERE source_kind IS NOT NULL;

-- 1c. 큐 슬롯 테이블
CREATE TABLE queue_slots (
    slot_id INTEGER NOT NULL PRIMARY KEY CHECK(slot_id BETWEEN 0 AND 4),
    playlist_id INTEGER REFERENCES playlists(id) ON DELETE SET NULL,
    is_active INTEGER NOT NULL DEFAULT 0,
    paused_track_id TEXT,
    overflow_offset INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO queue_slots (slot_id, is_active) VALUES (0, 1);

-- 1d. queue_items에 slot_id 추가
CREATE TABLE queue_items_new (
    slot_id INTEGER NOT NULL DEFAULT 0 REFERENCES queue_slots(slot_id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    track_id TEXT NOT NULL,
    added_by TEXT NOT NULL,
    added_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (slot_id, position)
);
INSERT INTO queue_items_new (slot_id, position, track_id, added_by, added_at)
  SELECT 0, position, track_id, added_by, added_at FROM queue_items;
DROP TABLE queue_items;
ALTER TABLE queue_items_new RENAME TO queue_items;

-- 1e. tracks 테이블에 외부 메타데이터 추가
ALTER TABLE tracks ADD COLUMN is_unavailable INTEGER NOT NULL DEFAULT 0;
