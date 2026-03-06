use sqlx::SqlitePool;

use crate::models::User;
use crate::{DbError, DbResult};

pub async fn upsert_user(
    pool: &SqlitePool,
    id: &str,
    username: &str,
    avatar_url: Option<&str>,
) -> DbResult<User> {
    sqlx::query_as::<_, User>(
        "INSERT INTO users (id, username, avatar_url)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(id) DO UPDATE SET username = ?2, avatar_url = ?3
         RETURNING id, username, avatar_url, token_version, created_at",
    )
    .bind(id)
    .bind(username)
    .bind(avatar_url)
    .fetch_one(pool)
    .await
    .map_err(DbError::from)
}

pub async fn get_user(pool: &SqlitePool, id: &str) -> DbResult<User> {
    sqlx::query_as::<_, User>(
        "SELECT id, username, avatar_url, token_version, created_at FROM users WHERE id = ?1",
    )
    .bind(id)
    .fetch_optional(pool)
    .await?
    .ok_or(DbError::NotFound)
}

pub async fn increment_token_version(pool: &SqlitePool, id: &str) -> DbResult<()> {
    sqlx::query("UPDATE users SET token_version = token_version + 1 WHERE id = ?1")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}
