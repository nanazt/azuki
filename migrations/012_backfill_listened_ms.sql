-- Backfill existing rows with track duration so stats remain accurate.
-- New rows start with NULL (0 in stats) until finish_play() sets the real value.
UPDATE play_history SET listened_ms = (
    SELECT duration_ms FROM tracks WHERE tracks.id = play_history.track_id
) WHERE listened_ms IS NULL;
