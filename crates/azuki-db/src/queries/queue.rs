use sqlx::SqlitePool;

use crate::{DbError, DbResult};
use crate::queries::history::RestoreEntry;

pub async fn save_queue(
    pool: &SqlitePool,
    items: &[(String, String)], // (track_id, added_by)
) -> DbResult<()> {
    let mut tx = pool.begin().await?;

    sqlx::query("DELETE FROM queue_items")
        .execute(&mut *tx)
        .await?;

    for (position, (track_id, added_by)) in items.iter().enumerate() {
        sqlx::query(
            "INSERT INTO queue_items (position, track_id, added_by) VALUES (?1, ?2, ?3)",
        )
        .bind(position as i64)
        .bind(track_id)
        .bind(added_by)
        .execute(&mut *tx)
        .await?;
    }

    tx.commit().await?;
    Ok(())
}

pub async fn load_queue(pool: &SqlitePool) -> DbResult<Vec<RestoreEntry>> {
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
         ORDER BY q.position ASC",
    )
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
