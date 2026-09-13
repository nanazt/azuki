use serde::Deserialize;
use sqlx::{SqliteConnection, SqlitePool};

use crate::queries::history::RestoreEntry;
use crate::{DbError, DbResult};

const NOW_PLAYING_CONFIG_KEY: &str = "now_playing";
const LOOP_MODE_CONFIG_KEY: &str = "loop_mode";
const RECOVERY_RECORD_VERSION: u64 = 1;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PersistedPlayback {
    pub track_id: String,
    pub added_by: String,
    pub position_ms: u64,
    pub paused: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecoverySnapshot {
    pub current: Option<PersistedPlayback>,
    pub queue: Vec<(String, String)>,
    pub loop_mode: String,
}

#[derive(Debug)]
pub struct RecoveredPlayback {
    pub entry: RestoreEntry,
    pub position_ms: u64,
    pub paused: bool,
}

#[derive(Debug)]
pub struct LoadedRecovery {
    pub current: Option<RecoveredPlayback>,
    pub queue: Vec<RestoreEntry>,
    pub loop_mode: String,
    pub error: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CurrentPlaybackRecord {
    version: u64,
    track_id: String,
    added_by: String,
    position_ms: u64,
    paused: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct LegacyPlaybackRecord {
    track_id: String,
    added_by: String,
}

struct DecodedPlayback {
    track_id: String,
    added_by: String,
    position_ms: u64,
    paused: bool,
}

fn queue_position(position: usize) -> DbResult<i64> {
    i64::try_from(position)
        .map_err(|_| DbError::InvalidInput("queue length exceeds SQLite integer range"))
}

fn decode_current_playback(json: &str) -> Result<DecodedPlayback, &'static str> {
    let value =
        serde_json::from_str::<serde_json::Value>(json).map_err(|_| "invalid recovery record")?;
    let object = value.as_object().ok_or("invalid recovery record")?;

    if object.contains_key("version") {
        let record = serde_json::from_value::<CurrentPlaybackRecord>(value)
            .map_err(|_| "invalid recovery record")?;
        if record.version != RECOVERY_RECORD_VERSION
            || record.track_id.is_empty()
            || record.added_by.is_empty()
        {
            return Err("invalid recovery record");
        }

        return Ok(DecodedPlayback {
            track_id: record.track_id,
            added_by: record.added_by,
            position_ms: record.position_ms,
            paused: record.paused,
        });
    }

    let record = serde_json::from_value::<LegacyPlaybackRecord>(value)
        .map_err(|_| "invalid recovery record")?;
    if record.track_id.is_empty() || record.added_by.is_empty() {
        return Err("invalid recovery record");
    }

    Ok(DecodedPlayback {
        track_id: record.track_id,
        added_by: record.added_by,
        position_ms: 0,
        paused: true,
    })
}

async fn load_restore_entry(
    connection: &mut SqliteConnection,
    track_id: &str,
    added_by: &str,
) -> Result<Option<RestoreEntry>, sqlx::Error> {
    sqlx::query_as::<_, RestoreEntry>(
        "SELECT t.id AS track_id,
                t.title, t.artist, t.duration_ms,
                t.thumbnail_url,
                t.source_url,
                t.source_type,
                t.file_path,
                t.youtube_id,
                t.volume,
                ?1 AS user_id,
                u.username,
                u.avatar_url
         FROM tracks t
         LEFT JOIN users u ON u.id = ?1
         WHERE t.id = ?2",
    )
    .bind(added_by)
    .bind(track_id)
    .fetch_optional(connection)
    .await
}

pub async fn save_recovery_snapshot(
    pool: &SqlitePool,
    snapshot: &RecoverySnapshot,
) -> DbResult<()> {
    let current_json = snapshot.current.as_ref().map(|current| {
        serde_json::json!({
            "version": RECOVERY_RECORD_VERSION,
            "track_id": &current.track_id,
            "added_by": &current.added_by,
            "position_ms": current.position_ms,
            "paused": current.paused,
        })
        .to_string()
    });

    let mut tx = pool.begin().await?;

    match current_json {
        Some(json) => {
            sqlx::query(
                "INSERT INTO app_config (key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            )
            .bind(NOW_PLAYING_CONFIG_KEY)
            .bind(json)
            .execute(&mut *tx)
            .await?;
        }
        None => {
            sqlx::query("DELETE FROM app_config WHERE key = ?1")
                .bind(NOW_PLAYING_CONFIG_KEY)
                .execute(&mut *tx)
                .await?;
        }
    }

    sqlx::query(
        "INSERT INTO app_config (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .bind(LOOP_MODE_CONFIG_KEY)
    .bind(&snapshot.loop_mode)
    .execute(&mut *tx)
    .await?;

    let stored_items = sqlx::query_as::<_, (i64, String, Option<String>)>(
        "SELECT position, track_id, added_by
         FROM queue_items
         WHERE slot_id = 0
         ORDER BY position ASC",
    )
    .fetch_all(&mut *tx)
    .await?;

    let mut queue_changed = stored_items.len() != snapshot.queue.len();
    if !queue_changed {
        for (position, ((stored_position, track_id, added_by), (next_track_id, next_added_by))) in
            stored_items.iter().zip(&snapshot.queue).enumerate()
        {
            if *stored_position != queue_position(position)?
                || track_id != next_track_id
                || added_by.as_deref() != Some(next_added_by)
            {
                queue_changed = true;
                break;
            }
        }
    }

    if queue_changed {
        sqlx::query("DELETE FROM queue_items WHERE slot_id = 0")
            .execute(&mut *tx)
            .await?;

        for (position, (track_id, added_by)) in snapshot.queue.iter().enumerate() {
            sqlx::query(
                "INSERT INTO queue_items (slot_id, position, track_id, added_by) VALUES (0, ?1, ?2, ?3)",
            )
            .bind(queue_position(position)?)
            .bind(track_id)
            .bind(added_by)
            .execute(&mut *tx)
            .await?;
        }
    }

    tx.commit().await?;
    Ok(())
}

pub async fn load_recovery_snapshot(pool: &SqlitePool) -> DbResult<LoadedRecovery> {
    let mut tx = pool.begin().await?;

    let current_json =
        sqlx::query_scalar::<_, String>("SELECT value FROM app_config WHERE key = ?1")
            .bind(NOW_PLAYING_CONFIG_KEY)
            .fetch_optional(&mut *tx)
            .await?;
    let loop_mode = sqlx::query_scalar::<_, String>("SELECT value FROM app_config WHERE key = ?1")
        .bind(LOOP_MODE_CONFIG_KEY)
        .fetch_optional(&mut *tx)
        .await?
        .unwrap_or_else(|| "off".to_string());
    let queue = sqlx::query_as::<_, RestoreEntry>(
        "SELECT q.track_id,
                t.title, t.artist, t.duration_ms,
                t.thumbnail_url,
                t.source_url,
                t.source_type,
                t.file_path,
                t.youtube_id,
                t.volume,
                q.added_by AS user_id,
                u.username,
                u.avatar_url
         FROM queue_items q
         JOIN tracks t ON t.id = q.track_id
         LEFT JOIN users u ON u.id = q.added_by
         WHERE q.slot_id = 0
         ORDER BY q.position ASC",
    )
    .fetch_all(&mut *tx)
    .await?;

    let (current, error) = match current_json {
        None => (None, None),
        Some(json) => match decode_current_playback(&json) {
            Err(error) => (None, Some(error.to_string())),
            Ok(record) => {
                match load_restore_entry(&mut tx, &record.track_id, &record.added_by).await? {
                    None => (None, Some("recovery track unavailable".to_string())),
                    Some(entry) => {
                        let duration_ms = u64::try_from(entry.duration_ms).unwrap_or_default();
                        (
                            Some(RecoveredPlayback {
                                entry,
                                position_ms: record.position_ms.min(duration_ms),
                                paused: record.paused,
                            }),
                            None,
                        )
                    }
                }
            }
        },
    };

    tx.commit().await?;
    Ok(LoadedRecovery {
        current,
        queue,
        loop_mode,
        error,
    })
}

#[cfg(test)]
mod tests {
    use sqlx::SqlitePool;
    use sqlx::sqlite::SqlitePoolOptions;

    use super::{
        LoadedRecovery, PersistedPlayback, RecoverySnapshot, load_recovery_snapshot,
        save_recovery_snapshot,
    };

    async fn pool_with_tracks() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        crate::run_migrations(&pool).await.unwrap();

        for (id, title, duration_ms) in [
            ("track-a", "Track A", 1_000_i64),
            ("track-b", "Track B", 2_000_i64),
        ] {
            sqlx::query(
                "INSERT INTO tracks (id, title, duration_ms, source_url, source_type)
                 VALUES (?1, ?2, ?3, 'https://example.test/source', 'test')",
            )
            .bind(id)
            .bind(title)
            .bind(duration_ms)
            .execute(&pool)
            .await
            .unwrap();
        }

        pool
    }

    fn snapshot(
        current: Option<(&str, &str, u64, bool)>,
        queue: &[(&str, &str)],
        loop_mode: &str,
    ) -> RecoverySnapshot {
        RecoverySnapshot {
            current: current.map(
                |(track_id, added_by, position_ms, paused)| PersistedPlayback {
                    track_id: track_id.to_string(),
                    added_by: added_by.to_string(),
                    position_ms,
                    paused,
                },
            ),
            queue: queue
                .iter()
                .map(|(track_id, added_by)| ((*track_id).to_string(), (*added_by).to_string()))
                .collect(),
            loop_mode: loop_mode.to_string(),
        }
    }

    fn queue_ids(loaded: &LoadedRecovery) -> Vec<&str> {
        loaded
            .queue
            .iter()
            .map(|entry| entry.track_id.as_str())
            .collect()
    }

    #[tokio::test]
    async fn legacy_current_restores_paused_at_zero() {
        let pool = pool_with_tracks().await;
        save_recovery_snapshot(&pool, &snapshot(None, &[("track-b", "user-b")], "all"))
            .await
            .unwrap();
        sqlx::query("INSERT OR REPLACE INTO app_config (key, value) VALUES ('now_playing', ?1)")
            .bind(r#"{"track_id":"track-a","added_by":"user-a"}"#)
            .execute(&pool)
            .await
            .unwrap();

        let loaded = load_recovery_snapshot(&pool).await.unwrap();

        let current = loaded.current.as_ref().unwrap();
        assert_eq!(current.entry.track_id, "track-a");
        assert_eq!(current.position_ms, 0);
        assert!(current.paused);
        assert_eq!(queue_ids(&loaded), vec!["track-b"]);
        assert_eq!(loaded.loop_mode, "all");
        assert_eq!(loaded.error, None);
    }

    #[tokio::test]
    async fn new_record_restores_position_intent_and_repeated_loop_entries() {
        let pool = pool_with_tracks().await;
        save_recovery_snapshot(
            &pool,
            &snapshot(
                Some(("track-b", "user-current", 3_000, false)),
                &[
                    ("track-a", "user-first"),
                    ("track-b", "user-second"),
                    ("track-a", "user-third"),
                ],
                "all",
            ),
        )
        .await
        .unwrap();

        let loaded = load_recovery_snapshot(&pool).await.unwrap();
        let current = loaded.current.as_ref().unwrap();
        assert_eq!(current.entry.track_id, "track-b");
        assert_eq!(current.position_ms, 2_000);
        assert!(!current.paused);
        assert_eq!(queue_ids(&loaded), vec!["track-a", "track-b", "track-a"]);
        assert_eq!(loaded.queue[2].user_id, "user-third");
        assert_eq!(loaded.loop_mode, "all");
        assert_eq!(loaded.error, None);
    }

    #[tokio::test]
    async fn unchanged_queue_is_not_rewritten_during_a_position_checkpoint() {
        let pool = pool_with_tracks().await;
        let initial = snapshot(
            Some(("track-a", "user-a", 100, false)),
            &[("track-a", "user-a"), ("track-b", "user-b")],
            "off",
        );
        save_recovery_snapshot(&pool, &initial).await.unwrap();
        sqlx::query(
            "CREATE TRIGGER reject_recovery_queue_delete
             BEFORE DELETE ON queue_items
             BEGIN
                 SELECT RAISE(ABORT, 'queue rewrite rejected');
             END",
        )
        .execute(&pool)
        .await
        .unwrap();

        save_recovery_snapshot(
            &pool,
            &snapshot(
                Some(("track-a", "user-a", 200, false)),
                &[("track-a", "user-a"), ("track-b", "user-b")],
                "off",
            ),
        )
        .await
        .unwrap();

        let loaded = load_recovery_snapshot(&pool).await.unwrap();
        assert_eq!(loaded.current.as_ref().unwrap().position_ms, 200);
        assert_eq!(queue_ids(&loaded), vec!["track-a", "track-b"]);
    }

    #[tokio::test]
    async fn malformed_current_preserves_valid_queue_without_auto_playback() {
        let pool = pool_with_tracks().await;
        save_recovery_snapshot(
            &pool,
            &snapshot(
                Some(("track-a", "user-a", 500, false)),
                &[("track-b", "user-b")],
                "one",
            ),
        )
        .await
        .unwrap();
        sqlx::query("UPDATE app_config SET value = ?1 WHERE key = 'now_playing'")
            .bind(
                r#"{"version":1,"track_id":"track-a","added_by":"user-a","position_ms":500,"paused":"false"}"#,
            )
            .execute(&pool)
            .await
            .unwrap();

        let loaded = load_recovery_snapshot(&pool).await.unwrap();

        assert!(loaded.current.is_none());
        assert_eq!(queue_ids(&loaded), vec!["track-b"]);
        assert_eq!(loaded.loop_mode, "one");
        assert_eq!(loaded.error.as_deref(), Some("invalid recovery record"));
    }

    #[tokio::test]
    async fn failed_snapshot_write_rolls_back_current_queue_and_loop_mode() {
        let pool = pool_with_tracks().await;
        let old = snapshot(
            Some(("track-a", "user-a", 100, true)),
            &[("track-a", "user-a")],
            "off",
        );
        save_recovery_snapshot(&pool, &old).await.unwrap();
        sqlx::query(
            "CREATE TRIGGER reject_recovery_queue_insert
             BEFORE INSERT ON queue_items
             WHEN NEW.track_id = 'track-b'
             BEGIN
                 SELECT RAISE(ABORT, 'reject recovery queue insert');
             END",
        )
        .execute(&pool)
        .await
        .unwrap();

        let result = save_recovery_snapshot(
            &pool,
            &snapshot(
                Some(("track-b", "user-b", 900, false)),
                &[("track-b", "user-b")],
                "all",
            ),
        )
        .await;

        assert!(result.is_err());
        let loaded = load_recovery_snapshot(&pool).await.unwrap();
        let current = loaded.current.as_ref().unwrap();
        assert_eq!(current.entry.track_id, "track-a");
        assert_eq!(current.position_ms, 100);
        assert!(current.paused);
        assert_eq!(queue_ids(&loaded), vec!["track-a"]);
        assert_eq!(loaded.loop_mode, "off");
    }
}
