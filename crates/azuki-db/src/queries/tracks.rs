use sqlx::SqlitePool;

use crate::models::Track;
use crate::{DbError, DbResult};

#[allow(clippy::too_many_arguments)]
pub async fn upsert_track(
    pool: &SqlitePool,
    id: &str,
    title: &str,
    artist: Option<&str>,
    duration_ms: i64,
    thumbnail_url: Option<&str>,
    source_url: &str,
    source_type: &str,
    file_path: Option<&str>,
    youtube_id: Option<&str>,
) -> DbResult<Track> {
    sqlx::query_as::<_, Track>(
        "INSERT INTO tracks (id, title, artist, duration_ms, thumbnail_url, source_url, source_type, file_path, youtube_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT(id) DO UPDATE SET
           title = ?2, artist = ?3, duration_ms = ?4, thumbnail_url = ?5,
           file_path = COALESCE(?8, tracks.file_path), youtube_id = COALESCE(?9, tracks.youtube_id)
         RETURNING id, title, artist, duration_ms, thumbnail_url, source_url, source_type, file_path, youtube_id, volume, created_at",
    )
    .bind(id)
    .bind(title)
    .bind(artist)
    .bind(duration_ms)
    .bind(thumbnail_url)
    .bind(source_url)
    .bind(source_type)
    .bind(file_path)
    .bind(youtube_id)
    .fetch_one(pool)
    .await
    .map_err(DbError::from)
}

pub async fn get_track(pool: &SqlitePool, id: &str) -> DbResult<Track> {
    sqlx::query_as::<_, Track>(
        "SELECT id, title, artist, duration_ms, thumbnail_url, source_url, source_type, file_path, youtube_id, volume, created_at
         FROM tracks WHERE id = ?1",
    )
    .bind(id)
    .fetch_optional(pool)
    .await?
    .ok_or(DbError::NotFound)
}

pub async fn search_tracks(
    pool: &SqlitePool,
    query: &str,
    limit: i64,
    offset: i64,
) -> DbResult<Vec<Track>> {
    let pattern = format!("%{query}%");
    sqlx::query_as::<_, Track>(
        "SELECT id, title, artist, duration_ms, thumbnail_url, source_url, source_type, file_path, youtube_id, volume, created_at
         FROM tracks
         WHERE title LIKE ?1 OR artist LIKE ?1
         ORDER BY created_at DESC
         LIMIT ?2 OFFSET ?3",
    )
    .bind(&pattern)
    .bind(limit)
    .bind(offset)
    .fetch_all(pool)
    .await
    .map_err(DbError::from)
}

pub async fn update_track_volume(pool: &SqlitePool, track_id: &str, volume: i64) -> DbResult<()> {
    sqlx::query("UPDATE tracks SET volume = ?1 WHERE id = ?2")
        .bind(volume)
        .bind(track_id)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn update_file_path(
    pool: &SqlitePool,
    track_id: &str,
    file_path: &str,
) -> DbResult<()> {
    sqlx::query("UPDATE tracks SET file_path = ?1 WHERE id = ?2")
        .bind(file_path)
        .bind(track_id)
        .execute(pool)
        .await?;
    Ok(())
}
