use sqlx::SqlitePool;

use crate::models::QueueSlot;
use crate::{DbError, DbResult};
use crate::queries::history::RestoreEntry;

pub async fn save_queue(
    pool: &SqlitePool,
    slot_id: i64,
    items: &[(String, String)], // (track_id, added_by)
) -> DbResult<()> {
    let mut tx = pool.begin().await?;

    sqlx::query("DELETE FROM queue_items WHERE slot_id = ?1")
        .bind(slot_id)
        .execute(&mut *tx)
        .await?;

    for (position, (track_id, added_by)) in items.iter().enumerate() {
        sqlx::query(
            "INSERT INTO queue_items (slot_id, position, track_id, added_by) VALUES (?1, ?2, ?3, ?4)",
        )
        .bind(slot_id)
        .bind(position as i64)
        .bind(track_id)
        .bind(added_by)
        .execute(&mut *tx)
        .await?;
    }

    tx.commit().await?;
    Ok(())
}

pub async fn load_queue(pool: &SqlitePool, slot_id: i64) -> DbResult<Vec<RestoreEntry>> {
    sqlx::query_as::<_, RestoreEntry>(
        "SELECT q.track_id,
                t.title, t.artist, t.duration_ms,
                t.thumbnail_url,
                t.source_url,
                t.source_type,
                t.youtube_id,
                t.volume,
                q.added_by AS user_id,
                u.username,
                u.avatar_url
         FROM queue_items q
         JOIN tracks t ON t.id = q.track_id
         LEFT JOIN users u ON u.id = q.added_by
         WHERE q.slot_id = ?1
         ORDER BY q.position ASC",
    )
    .bind(slot_id)
    .fetch_all(pool)
    .await
    .map_err(DbError::from)
}

pub async fn save_loop_mode(pool: &SqlitePool, mode: &str) -> DbResult<()> {
    sqlx::query(
        "INSERT OR REPLACE INTO app_config (key, value) VALUES ('loop_mode', ?1)",
    )
    .bind(mode)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn load_loop_mode(pool: &SqlitePool) -> DbResult<String> {
    let row = sqlx::query_scalar::<_, String>(
        "SELECT value FROM app_config WHERE key = 'loop_mode'",
    )
    .fetch_optional(pool)
    .await?;
    Ok(row.unwrap_or_else(|| "off".to_string()))
}

pub async fn save_now_playing(
    pool: &SqlitePool,
    track_id: &str,
    added_by: &str,
) -> DbResult<()> {
    let json = serde_json::json!({
        "track_id": track_id,
        "added_by": added_by,
    })
    .to_string();
    sqlx::query("INSERT OR REPLACE INTO app_config (key, value) VALUES ('now_playing', ?1)")
        .bind(&json)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn clear_now_playing(pool: &SqlitePool) -> DbResult<()> {
    sqlx::query("DELETE FROM app_config WHERE key = 'now_playing'")
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn load_now_playing(pool: &SqlitePool) -> DbResult<Option<RestoreEntry>> {
    let row = sqlx::query_scalar::<_, String>(
        "SELECT value FROM app_config WHERE key = 'now_playing'",
    )
    .fetch_optional(pool)
    .await?;

    let Some(json_str) = row else {
        return Ok(None);
    };

    let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&json_str) else {
        return Ok(None);
    };

    let (Some(track_id), Some(added_by)) = (
        parsed["track_id"].as_str(),
        parsed["added_by"].as_str(),
    ) else {
        return Ok(None);
    };

    let entry = sqlx::query_as::<_, RestoreEntry>(
        "SELECT t.id AS track_id,
                t.title, t.artist, t.duration_ms,
                t.thumbnail_url,
                t.source_url,
                t.source_type,
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
    .fetch_optional(pool)
    .await?;

    Ok(entry)
}

pub async fn get_queue_slots(pool: &SqlitePool) -> DbResult<Vec<QueueSlot>> {
    sqlx::query_as::<_, QueueSlot>(
        "SELECT slot_id, playlist_id, is_active, paused_track_id, overflow_offset, created_at
         FROM queue_slots
         ORDER BY slot_id ASC",
    )
    .fetch_all(pool)
    .await
    .map_err(DbError::from)
}

pub async fn create_queue_slot(pool: &SqlitePool, playlist_id: i64) -> DbResult<QueueSlot> {
    // Find next free slot in range 1-4
    let used: Vec<i64> = sqlx::query_scalar("SELECT slot_id FROM queue_slots WHERE slot_id BETWEEN 1 AND 4 ORDER BY slot_id ASC")
        .fetch_all(pool)
        .await?;

    let next_slot = (1i64..=4)
        .find(|s| !used.contains(s))
        .ok_or(DbError::NotFound)?; // all slots 1-4 occupied

    sqlx::query_as::<_, QueueSlot>(
        "INSERT INTO queue_slots (slot_id, playlist_id, is_active)
         VALUES (?1, ?2, 0)
         RETURNING slot_id, playlist_id, is_active, paused_track_id, overflow_offset, created_at",
    )
    .bind(next_slot)
    .bind(playlist_id)
    .fetch_one(pool)
    .await
    .map_err(DbError::from)
}

pub async fn delete_queue_slot(pool: &SqlitePool, slot_id: i64) -> DbResult<()> {
    if slot_id == 0 {
        return Err(DbError::NotFound); // slot 0 (default) cannot be deleted
    }
    let result = sqlx::query("DELETE FROM queue_slots WHERE slot_id = ?1")
        .bind(slot_id)
        .execute(pool)
        .await?;
    if result.rows_affected() == 0 {
        return Err(DbError::NotFound);
    }
    Ok(())
}

pub async fn set_active_slot(pool: &SqlitePool, slot_id: i64) -> DbResult<()> {
    let mut tx = pool.begin().await?;

    sqlx::query("UPDATE queue_slots SET is_active = 0")
        .execute(&mut *tx)
        .await?;

    let result = sqlx::query("UPDATE queue_slots SET is_active = 1 WHERE slot_id = ?1")
        .bind(slot_id)
        .execute(&mut *tx)
        .await?;

    if result.rows_affected() == 0 {
        return Err(DbError::NotFound);
    }

    tx.commit().await?;
    Ok(())
}

pub async fn save_paused_track(
    pool: &SqlitePool,
    slot_id: i64,
    track_id: Option<&str>,
) -> DbResult<()> {
    let result = sqlx::query(
        "UPDATE queue_slots SET paused_track_id = ?1 WHERE slot_id = ?2",
    )
    .bind(track_id)
    .bind(slot_id)
    .execute(pool)
    .await?;
    if result.rows_affected() == 0 {
        return Err(DbError::NotFound);
    }
    Ok(())
}

pub async fn count_playlist_slots(pool: &SqlitePool) -> DbResult<i64> {
    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM queue_slots WHERE slot_id BETWEEN 1 AND 4",
    )
    .fetch_one(pool)
    .await?;
    Ok(count)
}
