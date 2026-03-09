-- Remove multi-queue and playlist tables
-- Rebuild queue_items without slot_id FK (015 added slot_id + FK to queue_slots)
CREATE TABLE queue_items_new (
  slot_id INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL,
  track_id TEXT NOT NULL,
  added_by TEXT,
  PRIMARY KEY (slot_id, position)
);
INSERT INTO queue_items_new SELECT slot_id, position, track_id, added_by FROM queue_items;
DROP TABLE queue_items;
ALTER TABLE queue_items_new RENAME TO queue_items;

DROP TABLE IF EXISTS queue_slots;
DROP TABLE IF EXISTS playlist_tracks;
DROP TABLE IF EXISTS playlists;
