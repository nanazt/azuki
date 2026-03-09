use sqlx::SqlitePool;

use crate::models::UserPreferences;
use crate::{DbError, DbResult};

pub async fn get_user_preferences(pool: &SqlitePool, user_id: &str) -> DbResult<UserPreferences> {
    let row = sqlx::query_as::<_, UserPreferences>(
        r#"SELECT user_id, theme, locale, updated_at
           FROM user_preferences WHERE user_id = ?1"#,
    )
    .bind(user_id)
    .fetch_optional(pool)
    .await?;

    Ok(row.unwrap_or_else(|| UserPreferences {
        user_id: user_id.to_string(),
        theme: "dark".to_string(),
        locale: "ko".to_string(),
        updated_at: String::new(),
    }))
}

pub async fn upsert_user_preferences(
    pool: &SqlitePool,
    user_id: &str,
    theme: &str,
    locale: &str,
) -> DbResult<UserPreferences> {
    sqlx::query_as::<_, UserPreferences>(
        r#"INSERT INTO user_preferences (user_id, theme, locale, updated_at)
           VALUES (?1, ?2, ?3, datetime('now'))
           ON CONFLICT(user_id) DO UPDATE SET
               theme = ?2,
               locale = ?3,
               updated_at = datetime('now')
           RETURNING user_id, theme, locale, updated_at"#,
    )
    .bind(user_id)
    .bind(theme)
    .bind(locale)
    .fetch_one(pool)
    .await
    .map_err(DbError::from)
}
