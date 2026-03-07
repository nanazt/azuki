use sqlx::SqlitePool;

use crate::models::{Playlist, PlaylistTrack, Track};
use crate::{DbError, DbResult};

pub async fn create_playlist(
    pool: &SqlitePool,
    name: &str,
    owner_id: Option<&str>,
    is_shared: bool,
) -> DbResult<Playlist> {
    sqlx::query_as::<_, Playlist>(
        "INSERT INTO playlists (name, owner_id, is_shared)
         VALUES (?1, ?2, ?3)
         RETURNING id, name, owner_id, is_shared, created_at",
    )
    .bind(name)
    .bind(owner_id)
    .bind(is_shared)
    .fetch_one(pool)
    .await
    .map_err(DbError::from)
}

pub async fn get_playlist(pool: &SqlitePool, id: i64) -> DbResult<Playlist> {
    sqlx::query_as::<_, Playlist>(
        "SELECT id, name, owner_id, is_shared, created_at FROM playlists WHERE id = ?1",
    )
    .bind(id)
    .fetch_optional(pool)
    .await?
    .ok_or(DbError::NotFound)
}

pub async fn list_playlists(
    pool: &SqlitePool,
    user_id: &str,
) -> DbResult<Vec<Playlist>> {
    sqlx::query_as::<_, Playlist>(
        "SELECT id, name, owner_id, is_shared, created_at
         FROM playlists
         WHERE owner_id = ?1 OR is_shared = 1 OR owner_id IS NULL
         ORDER BY created_at DESC",
    )
    .bind(user_id)
    .fetch_all(pool)
    .await
    .map_err(DbError::from)
}

pub async fn rename_playlist(
    pool: &SqlitePool,
    id: i64,
    name: &str,
) -> DbResult<()> {
    let result = sqlx::query("UPDATE playlists SET name = ?1 WHERE id = ?2")
        .bind(name)
        .bind(id)
        .execute(pool)
        .await?;
    if result.rows_affected() == 0 {
        return Err(DbError::NotFound);
    }
    Ok(())
}

pub async fn delete_playlist(pool: &SqlitePool, id: i64) -> DbResult<()> {
    let result = sqlx::query("DELETE FROM playlists WHERE id = ?1")
        .bind(id)
        .execute(pool)
        .await?;
    if result.rows_affected() == 0 {
        return Err(DbError::NotFound);
    }
    Ok(())
}

pub async fn add_track_to_playlist(
    pool: &SqlitePool,
    playlist_id: i64,
    track_id: &str,
    added_by: Option<&str>,
) -> DbResult<()> {
    let max_pos: Option<i64> = sqlx::query_scalar(
        "SELECT MAX(position) FROM playlist_tracks WHERE playlist_id = ?1",
    )
    .bind(playlist_id)
    .fetch_one(pool)
    .await?;

    let position = max_pos.unwrap_or(-1) + 1;

    sqlx::query(
        "INSERT INTO playlist_tracks (playlist_id, track_id, position, added_by)
         VALUES (?1, ?2, ?3, ?4)",
    )
    .bind(playlist_id)
    .bind(track_id)
    .bind(position)
    .bind(added_by)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn remove_track_from_playlist(
    pool: &SqlitePool,
    playlist_id: i64,
    position: i64,
) -> DbResult<()> {
    let result = sqlx::query(
        "DELETE FROM playlist_tracks WHERE playlist_id = ?1 AND position = ?2",
    )
    .bind(playlist_id)
    .bind(position)
    .execute(pool)
    .await?;
    if result.rows_affected() == 0 {
        return Err(DbError::NotFound);
    }
    // Reorder remaining positions
    sqlx::query(
        "UPDATE playlist_tracks
         SET position = position - 1
         WHERE playlist_id = ?1 AND position > ?2",
    )
    .bind(playlist_id)
    .bind(position)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn get_playlist_tracks(
    pool: &SqlitePool,
    playlist_id: i64,
) -> DbResult<Vec<Track>> {
    sqlx::query_as::<_, Track>(
        "SELECT t.id, t.title, t.artist, t.duration_ms, t.thumbnail_url,
                t.source_url, t.source_type, t.file_path, t.youtube_id, t.volume, t.created_at
         FROM playlist_tracks pt
         JOIN tracks t ON t.id = pt.track_id
         WHERE pt.playlist_id = ?1
         ORDER BY pt.position ASC",
    )
    .bind(playlist_id)
    .fetch_all(pool)
    .await
    .map_err(DbError::from)
}

#[allow(dead_code)]
pub async fn get_playlist_entries(
    pool: &SqlitePool,
    playlist_id: i64,
) -> DbResult<Vec<PlaylistTrack>> {
    sqlx::query_as::<_, PlaylistTrack>(
        "SELECT playlist_id, track_id, position, added_by, added_at
         FROM playlist_tracks
         WHERE playlist_id = ?1
         ORDER BY position ASC",
    )
    .bind(playlist_id)
    .fetch_all(pool)
    .await
    .map_err(DbError::from)
}
