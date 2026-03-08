use sqlx::SqlitePool;

use crate::models::Track;
use crate::{DbError, DbResult};

pub async fn toggle_favorite(
    pool: &SqlitePool,
    user_id: &str,
    track_id: &str,
) -> DbResult<bool> {
    let exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM favorites WHERE user_id = ?1 AND track_id = ?2)",
    )
    .bind(user_id)
    .bind(track_id)
    .fetch_one(pool)
    .await?;

    if exists {
        sqlx::query("DELETE FROM favorites WHERE user_id = ?1 AND track_id = ?2")
            .bind(user_id)
            .bind(track_id)
            .execute(pool)
            .await?;
        Ok(false)
    } else {
        sqlx::query("INSERT INTO favorites (user_id, track_id) VALUES (?1, ?2)")
            .bind(user_id)
            .bind(track_id)
            .execute(pool)
            .await?;
        Ok(true)
    }
}

pub async fn is_favorited(
    pool: &SqlitePool,
    user_id: &str,
    track_id: &str,
) -> DbResult<bool> {
    let exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM favorites WHERE user_id = ?1 AND track_id = ?2)",
    )
    .bind(user_id)
    .bind(track_id)
    .fetch_one(pool)
    .await?;
    Ok(exists)
}

pub async fn get_favorite_track_ids(
    pool: &SqlitePool,
    user_id: &str,
) -> DbResult<Vec<String>> {
    let ids: Vec<(String,)> = sqlx::query_as(
        "SELECT track_id FROM favorites WHERE user_id = ?1",
    )
    .bind(user_id)
    .fetch_all(pool)
    .await?;
    Ok(ids.into_iter().map(|(id,)| id).collect())
}

pub async fn get_favorites(
    pool: &SqlitePool,
    user_id: &str,
    limit: i64,
    before_created_at: Option<&str>,
) -> DbResult<Vec<Track>> {
    let sql = if before_created_at.is_some() {
        "SELECT t.id, t.title, t.artist, t.duration_ms, t.thumbnail_url,
                t.source_url, t.source_type, t.file_path, t.youtube_id, t.volume, t.created_at
         FROM favorites f
         JOIN tracks t ON t.id = f.track_id
         WHERE f.user_id = ?1 AND f.created_at < ?3
         ORDER BY f.created_at DESC
         LIMIT ?2"
    } else {
        "SELECT t.id, t.title, t.artist, t.duration_ms, t.thumbnail_url,
                t.source_url, t.source_type, t.file_path, t.youtube_id, t.volume, t.created_at
         FROM favorites f
         JOIN tracks t ON t.id = f.track_id
         WHERE f.user_id = ?1
         ORDER BY f.created_at DESC
         LIMIT ?2"
    };
    let mut query = sqlx::query_as::<_, Track>(sql)
        .bind(user_id)
        .bind(limit);
    if let Some(ca) = before_created_at {
        query = query.bind(ca);
    }
    query.fetch_all(pool).await.map_err(DbError::from)
}
