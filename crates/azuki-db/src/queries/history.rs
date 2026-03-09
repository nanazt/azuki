use serde::Serialize;
use sqlx::{FromRow, SqlitePool};

use crate::models::{
    ArtistStat, DailyCount, DailyListened, DowEntry, PeakDay, PlayHistory, StreakInfo, TopTrackRow,
};
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
         RETURNING id, track_id, user_id, played_at, completed, message_id, volume, listened_ms",
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

pub async fn finish_play(
    pool: &SqlitePool,
    id: i64,
    listened_ms: i64,
    completed: bool,
) -> DbResult<()> {
    sqlx::query("UPDATE play_history SET listened_ms = ?1, completed = ?2 WHERE id = ?3")
        .bind(listened_ms)
        .bind(completed)
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn get_history(
    pool: &SqlitePool,
    limit: i64,
    before_id: Option<i64>,
) -> DbResult<Vec<HistoryEntry>> {
    let sql = if before_id.is_some() {
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
         AND h.id < ?2
         ORDER BY h.id DESC
         LIMIT ?1"
    } else {
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
         ORDER BY h.id DESC
         LIMIT ?1"
    };
    let mut query = sqlx::query_as::<_, HistoryEntry>(sql).bind(limit);
    if let Some(id) = before_id {
        query = query.bind(id);
    }
    query.fetch_all(pool).await.map_err(DbError::from)
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
    pub file_path: Option<String>,
    pub youtube_id: Option<String>,
    pub volume: i64,
    pub user_id: String,
    pub username: Option<String>,
    pub avatar_url: Option<String>,
}

pub async fn get_history_for_restore(pool: &SqlitePool, limit: i64) -> DbResult<Vec<RestoreEntry>> {
    sqlx::query_as::<_, RestoreEntry>(
        "SELECT h.track_id,
                t.title, t.artist, t.duration_ms,
                t.thumbnail_url,
                t.source_url,
                t.source_type,
                t.file_path,
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

pub async fn get_server_stats(pool: &SqlitePool) -> DbResult<ServerStat> {
    sqlx::query_as::<_, ServerStat>(
        "SELECT
           COUNT(*) AS total_plays,
           COALESCE(SUM(COALESCE(h.listened_ms, 0)), 0) AS total_time_ms,
           COUNT(DISTINCT h.user_id) AS unique_users,
           COUNT(DISTINCT h.track_id) AS unique_tracks
         FROM play_history h
         JOIN tracks t ON t.id = h.track_id",
    )
    .fetch_one(pool)
    .await
    .map_err(DbError::from)
}

pub async fn get_heatmap(pool: &SqlitePool, tz_offset: &str) -> DbResult<Vec<DailyListened>> {
    sqlx::query_as::<_, DailyListened>(
        "SELECT date(played_at, ?1) AS date,
                SUM(COALESCE(listened_ms, 0)) AS listened_ms
         FROM play_history
         WHERE played_at >= date('now', ?1, '-365 days')
         GROUP BY date(played_at, ?1)
         ORDER BY date",
    )
    .bind(tz_offset)
    .fetch_all(pool)
    .await
    .map_err(DbError::from)
}

pub async fn get_trend(pool: &SqlitePool, tz_offset: &str) -> DbResult<Vec<DailyCount>> {
    sqlx::query_as::<_, DailyCount>(
        "SELECT date(played_at, ?1) AS date,
                COUNT(*) AS play_count
         FROM play_history
         WHERE played_at >= date('now', ?1, '-30 days')
         GROUP BY date(played_at, ?1)
         ORDER BY date",
    )
    .bind(tz_offset)
    .fetch_all(pool)
    .await
    .map_err(DbError::from)
}

pub async fn get_dow_activity(pool: &SqlitePool, tz_offset: &str) -> DbResult<Vec<DowEntry>> {
    sqlx::query_as::<_, DowEntry>(
        "SELECT (CAST(strftime('%w', played_at, ?1) AS INTEGER) + 6) % 7 AS dow,
                SUM(COALESCE(listened_ms, 0)) / MAX(COUNT(DISTINCT date(played_at, ?1)), 1) AS avg_listened_ms
         FROM play_history
         WHERE played_at >= date('now', ?1, '-365 days')
         GROUP BY dow
         ORDER BY dow",
    )
    .bind(tz_offset)
    .fetch_all(pool)
    .await
    .map_err(DbError::from)
}

pub async fn get_streak(pool: &SqlitePool, tz_offset: &str) -> DbResult<StreakInfo> {
    sqlx::query_as::<_, StreakInfo>(
        "WITH daily AS (
            SELECT DISTINCT date(played_at, ?1) AS d FROM play_history
            WHERE played_at >= date('now', ?1, '-365 days')
        ),
        grouped AS (
            SELECT d, julianday(d) - ROW_NUMBER() OVER (ORDER BY d) AS grp
            FROM daily
        ),
        streaks AS (
            SELECT COUNT(*) AS len, MIN(d) AS start_d, MAX(d) AS end_d
            FROM grouped GROUP BY grp
        )
        SELECT
            COALESCE((SELECT len FROM streaks
                      WHERE end_d >= date('now', ?1, '-1 day')
                      ORDER BY end_d DESC LIMIT 1), 0) AS current,
            COALESCE((SELECT MAX(len) FROM streaks), 0) AS max",
    )
    .bind(tz_offset)
    .fetch_one(pool)
    .await
    .map_err(DbError::from)
}

pub async fn get_peak_day(pool: &SqlitePool, tz_offset: &str) -> DbResult<Option<PeakDay>> {
    sqlx::query_as::<_, PeakDay>(
        "SELECT date(played_at, ?1) AS date,
                COUNT(*) AS play_count
         FROM play_history
         GROUP BY date(played_at, ?1)
         ORDER BY play_count DESC
         LIMIT 1",
    )
    .bind(tz_offset)
    .fetch_optional(pool)
    .await
    .map_err(DbError::from)
}

/// Get message_ids of previous play_history records for the same track
pub async fn get_previous_message_ids(
    pool: &SqlitePool,
    track_id: &str,
    exclude_history_id: i64,
) -> DbResult<Vec<String>> {
    sqlx::query_scalar::<_, String>(
        "SELECT message_id FROM play_history
         WHERE track_id = ?1 AND id != ?2 AND message_id IS NOT NULL",
    )
    .bind(track_id)
    .bind(exclude_history_id)
    .fetch_all(pool)
    .await
    .map_err(DbError::from)
}

/// Clear old message_ids to prevent double-deletion
pub async fn clear_old_message_ids(
    pool: &SqlitePool,
    track_id: &str,
    exclude_history_id: i64,
) -> DbResult<()> {
    sqlx::query(
        "UPDATE play_history SET message_id = NULL
         WHERE track_id = ?1 AND id != ?2 AND message_id IS NOT NULL",
    )
    .bind(track_id)
    .bind(exclude_history_id)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn get_top_tracks_paginated(
    pool: &SqlitePool,
    limit: i64,
    cursor: Option<(i64, String)>,
) -> DbResult<Vec<TopTrackRow>> {
    if let Some((cursor_count, cursor_id)) = cursor {
        sqlx::query_as::<_, TopTrackRow>(
            "SELECT h.track_id, t.title, t.artist, t.duration_ms, t.thumbnail_url,
                    COUNT(*) AS play_count
             FROM play_history h
             JOIN tracks t ON t.id = h.track_id
             GROUP BY h.track_id
             HAVING COUNT(*) < ?1 OR (COUNT(*) = ?1 AND h.track_id > ?2)
             ORDER BY play_count DESC, h.track_id ASC
             LIMIT ?3",
        )
        .bind(cursor_count)
        .bind(cursor_id)
        .bind(limit)
        .fetch_all(pool)
        .await
        .map_err(DbError::from)
    } else {
        sqlx::query_as::<_, TopTrackRow>(
            "SELECT h.track_id, t.title, t.artist, t.duration_ms, t.thumbnail_url,
                    COUNT(*) AS play_count
             FROM play_history h
             JOIN tracks t ON t.id = h.track_id
             GROUP BY h.track_id
             ORDER BY play_count DESC, h.track_id ASC
             LIMIT ?1",
        )
        .bind(limit)
        .fetch_all(pool)
        .await
        .map_err(DbError::from)
    }
}

pub async fn get_top_artists(
    pool: &SqlitePool,
    limit: i64,
    cursor: Option<(i64, String)>,
) -> DbResult<Vec<ArtistStat>> {
    if let Some((cursor_count, cursor_artist)) = cursor {
        sqlx::query_as::<_, ArtistStat>(
            "SELECT COALESCE(t.artist, 'Unknown') AS artist,
                    COUNT(*) AS play_count,
                    SUM(COALESCE(h.listened_ms, 0)) AS total_listened_ms,
                    COUNT(DISTINCT h.track_id) AS track_count
             FROM play_history h
             JOIN tracks t ON t.id = h.track_id
             GROUP BY artist
             HAVING COUNT(*) < ?1 OR (COUNT(*) = ?1 AND artist > ?2)
             ORDER BY play_count DESC, artist ASC
             LIMIT ?3",
        )
        .bind(cursor_count)
        .bind(cursor_artist)
        .bind(limit)
        .fetch_all(pool)
        .await
        .map_err(DbError::from)
    } else {
        sqlx::query_as::<_, ArtistStat>(
            "SELECT COALESCE(t.artist, 'Unknown') AS artist,
                    COUNT(*) AS play_count,
                    SUM(COALESCE(h.listened_ms, 0)) AS total_listened_ms,
                    COUNT(DISTINCT h.track_id) AS track_count
             FROM play_history h
             JOIN tracks t ON t.id = h.track_id
             GROUP BY artist
             ORDER BY play_count DESC, artist ASC
             LIMIT ?1",
        )
        .bind(limit)
        .fetch_all(pool)
        .await
        .map_err(DbError::from)
    }
}
