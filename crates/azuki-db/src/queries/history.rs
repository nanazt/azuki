use serde::Serialize;
use sqlx::{FromRow, SqlitePool};

use crate::models::PlayHistory;
use crate::{DbError, DbResult};

#[derive(Debug, Serialize, FromRow)]
pub struct HistoryEntry {
    pub id: i64,
    pub track_id: String,
    pub title: String,
    pub artist: Option<String>,
    pub duration_ms: i64,
    pub thumbnail_url: Option<String>,
    pub source_url: String,
    pub user_id: String,
    pub username: String,
    pub played_at: String,
    pub completed: bool,
    pub play_count: i64,
}

#[derive(Debug, Serialize, FromRow)]
pub struct TrackStat {
    pub track_id: String,
    pub title: String,
    pub artist: Option<String>,
    pub play_count: i64,
}

#[derive(Debug, Serialize, FromRow)]
pub struct UserStat {
    pub total_plays: i64,
    pub total_time_ms: i64,
    pub unique_tracks: i64,
}

#[derive(Debug, Serialize, FromRow)]
pub struct ServerStat {
    pub total_plays: i64,
    pub total_time_ms: i64,
    pub unique_users: i64,
    pub unique_tracks: i64,
}

pub async fn record_play(
    pool: &SqlitePool,
    track_id: &str,
    user_id: &str,
    volume: i64,
) -> DbResult<PlayHistory> {
    sqlx::query_as::<_, PlayHistory>(
        "INSERT INTO play_history (track_id, user_id, volume)
         VALUES (?1, ?2, ?3)
         RETURNING id, track_id, user_id, played_at, completed, message_id, volume",
    )
    .bind(track_id)
    .bind(user_id)
    .bind(volume)
    .fetch_one(pool)
    .await
    .map_err(DbError::from)
}

pub async fn update_message_id(pool: &SqlitePool, id: i64, message_id: &str) -> DbResult<()> {
    sqlx::query("UPDATE play_history SET message_id = ?1 WHERE id = ?2")
        .bind(message_id)
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn update_history_volume(pool: &SqlitePool, id: i64, volume: i64) -> DbResult<()> {
    sqlx::query("UPDATE play_history SET volume = ?1 WHERE id = ?2")
        .bind(volume)
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn mark_completed(pool: &SqlitePool, id: i64) -> DbResult<()> {
    sqlx::query("UPDATE play_history SET completed = 1 WHERE id = ?1")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn get_history(
    pool: &SqlitePool,
    limit: i64,
    offset: i64,
) -> DbResult<Vec<HistoryEntry>> {
    sqlx::query_as::<_, HistoryEntry>(
        "SELECT h.id, h.track_id,
                t.title, t.artist, t.duration_ms,
                t.thumbnail_url,
                t.source_url,
                h.user_id,
                u.username, h.played_at, h.completed,
                (SELECT COUNT(*) FROM play_history h3
                 WHERE h3.track_id = h.track_id) AS play_count
         FROM play_history h
         JOIN tracks t ON t.id = h.track_id
         JOIN users u ON u.id = h.user_id
         WHERE h.id = (
             SELECT MAX(h2.id) FROM play_history h2
             WHERE h2.track_id = h.track_id
         )
         ORDER BY h.played_at DESC
         LIMIT ?1 OFFSET ?2",
    )
    .bind(limit)
    .bind(offset)
    .fetch_all(pool)
    .await
    .map_err(DbError::from)
}

#[derive(Debug, FromRow)]
pub struct RestoreEntry {
    pub track_id: String,
    pub title: String,
    pub artist: Option<String>,
    pub duration_ms: i64,
    pub thumbnail_url: Option<String>,
    pub source_url: String,
    pub source_type: String,
    pub youtube_id: Option<String>,
    pub volume: i64,
    pub user_id: String,
    pub username: Option<String>,
    pub avatar_url: Option<String>,
}

pub async fn get_history_for_restore(
    pool: &SqlitePool,
    limit: i64,
) -> DbResult<Vec<RestoreEntry>> {
    sqlx::query_as::<_, RestoreEntry>(
        "SELECT h.track_id,
                t.title, t.artist, t.duration_ms,
                t.thumbnail_url,
                t.source_url,
                t.source_type,
                t.youtube_id,
                t.volume,
                h.user_id,
                u.username,
                u.avatar_url
         FROM play_history h
         JOIN tracks t ON t.id = h.track_id
         LEFT JOIN users u ON u.id = h.user_id
         ORDER BY h.played_at DESC
         LIMIT ?1",
    )
    .bind(limit)
    .fetch_all(pool)
    .await
    .map_err(DbError::from)
}

pub async fn get_user_stats(pool: &SqlitePool, user_id: &str) -> DbResult<UserStat> {
    sqlx::query_as::<_, UserStat>(
        "SELECT
           COUNT(*) AS total_plays,
           COALESCE(SUM(t.duration_ms), 0) AS total_time_ms,
           COUNT(DISTINCT h.track_id) AS unique_tracks
         FROM play_history h
         JOIN tracks t ON t.id = h.track_id
         WHERE h.user_id = ?1",
    )
    .bind(user_id)
    .fetch_one(pool)
    .await
    .map_err(DbError::from)
}

pub async fn get_server_stats(pool: &SqlitePool) -> DbResult<ServerStat> {
    sqlx::query_as::<_, ServerStat>(
        "SELECT
           COUNT(*) AS total_plays,
           COALESCE(SUM(t.duration_ms), 0) AS total_time_ms,
           COUNT(DISTINCT h.user_id) AS unique_users,
           COUNT(DISTINCT h.track_id) AS unique_tracks
         FROM play_history h
         JOIN tracks t ON t.id = h.track_id",
    )
    .fetch_one(pool)
    .await
    .map_err(DbError::from)
}

pub async fn get_top_tracks(
    pool: &SqlitePool,
    limit: i64,
) -> DbResult<Vec<TrackStat>> {
    sqlx::query_as::<_, TrackStat>(
        "SELECT h.track_id, t.title, t.artist,
                COUNT(*) AS play_count
         FROM play_history h
         JOIN tracks t ON t.id = h.track_id
         GROUP BY h.track_id
         ORDER BY 4 DESC
         LIMIT ?1",
    )
    .bind(limit)
    .fetch_all(pool)
    .await
    .map_err(DbError::from)
}

pub async fn get_user_top_tracks(
    pool: &SqlitePool,
    user_id: &str,
    limit: i64,
) -> DbResult<Vec<TrackStat>> {
    sqlx::query_as::<_, TrackStat>(
        "SELECT h.track_id, t.title, t.artist,
                COUNT(*) AS play_count
         FROM play_history h
         JOIN tracks t ON t.id = h.track_id
         WHERE h.user_id = ?1
         GROUP BY h.track_id
         ORDER BY 4 DESC
         LIMIT ?2",
    )
    .bind(user_id)
    .bind(limit)
    .fetch_all(pool)
    .await
    .map_err(DbError::from)
}

#[derive(Debug, Serialize, FromRow)]
pub struct HourlyCount {
    pub hour: i64,
    pub count: i64,
}

pub async fn get_hourly_activity(pool: &SqlitePool) -> DbResult<Vec<HourlyCount>> {
    sqlx::query_as::<_, HourlyCount>(
        "SELECT CAST(strftime('%H', played_at) AS INTEGER) AS hour,
                COUNT(*) AS count
         FROM play_history
         GROUP BY hour
         ORDER BY hour",
    )
    .fetch_all(pool)
    .await
    .map_err(DbError::from)
}
