use sqlx::SqlitePool;

use crate::models::Track;
use crate::{DbError, DbResult};

const TRACK_COLUMNS: &str = "id, title, artist, duration_ms, thumbnail_url, source_url, source_type, file_path, youtube_id, volume, uploaded_by, created_at";

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
    uploaded_by: Option<&str>,
) -> DbResult<Track> {
    let sql = format!(
        "INSERT INTO tracks (id, title, artist, duration_ms, thumbnail_url, source_url, source_type, file_path, youtube_id, uploaded_by)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
         ON CONFLICT(id) DO UPDATE SET
           title = ?2, artist = ?3, duration_ms = ?4, thumbnail_url = ?5,
           file_path = COALESCE(?8, tracks.file_path), youtube_id = COALESCE(?9, tracks.youtube_id)
         RETURNING {TRACK_COLUMNS}"
    );
    sqlx::query_as::<_, Track>(&sql)
        .bind(id)
        .bind(title)
        .bind(artist)
        .bind(duration_ms)
        .bind(thumbnail_url)
        .bind(source_url)
        .bind(source_type)
        .bind(file_path)
        .bind(youtube_id)
        .bind(uploaded_by)
        .fetch_one(pool)
        .await
        .map_err(DbError::from)
}

pub async fn get_track(pool: &SqlitePool, id: &str) -> DbResult<Track> {
    let sql = format!("SELECT {TRACK_COLUMNS} FROM tracks WHERE id = ?1");
    sqlx::query_as::<_, Track>(&sql)
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
    let sql = format!(
        "SELECT {TRACK_COLUMNS} FROM tracks
         WHERE title LIKE ?1 OR artist LIKE ?1
         ORDER BY created_at DESC
         LIMIT ?2 OFFSET ?3"
    );
    sqlx::query_as::<_, Track>(&sql)
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

pub async fn list_uploads(
    pool: &SqlitePool,
    limit: i64,
    offset: i64,
) -> DbResult<Vec<Track>> {
    let sql = format!(
        "SELECT {TRACK_COLUMNS} FROM tracks
         WHERE source_type = 'upload'
         ORDER BY created_at DESC
         LIMIT ?1 OFFSET ?2"
    );
    sqlx::query_as::<_, Track>(&sql)
        .bind(limit)
        .bind(offset)
        .fetch_all(pool)
        .await
        .map_err(DbError::from)
}

pub async fn count_uploads(pool: &SqlitePool) -> DbResult<i64> {
    let row: (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM tracks WHERE source_type = 'upload'")
            .fetch_one(pool)
            .await?;
    Ok(row.0)
}

pub async fn delete_track_cascade(pool: &SqlitePool, track_id: &str) -> DbResult<Option<String>> {
    let mut tx = pool.begin().await?;
    let file_path: Option<String> =
        sqlx::query_scalar("SELECT file_path FROM tracks WHERE id = ?1")
            .bind(track_id)
            .fetch_optional(&mut *tx)
            .await?;
    if file_path.is_none() {
        tx.rollback().await?;
        return Err(DbError::NotFound);
    }
    sqlx::query("DELETE FROM queue_items WHERE track_id = ?1")
        .bind(track_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM lyrics_cache WHERE track_id = ?1")
        .bind(track_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM favorites WHERE track_id = ?1")
        .bind(track_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM playlist_tracks WHERE track_id = ?1")
        .bind(track_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM play_history WHERE track_id = ?1")
        .bind(track_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM tracks WHERE id = ?1")
        .bind(track_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(file_path)
}

pub async fn update_track_metadata(
    pool: &SqlitePool,
    track_id: &str,
    title: Option<&str>,
    artist: Option<&str>,
) -> DbResult<Track> {
    let sql = format!(
        "UPDATE tracks SET
           title = COALESCE(?1, title),
           artist = COALESCE(?2, artist)
         WHERE id = ?3
         RETURNING {TRACK_COLUMNS}"
    );
    sqlx::query_as::<_, Track>(&sql)
        .bind(title)
        .bind(artist)
        .bind(track_id)
        .fetch_optional(pool)
        .await?
        .ok_or(DbError::NotFound)
}
