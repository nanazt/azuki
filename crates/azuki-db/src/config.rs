use std::collections::HashMap;

use sqlx::SqlitePool;

use crate::DbResult;

pub const REQUIRED_KEYS: &[&str] = &[
    "discord_token",
    "discord_guild_id",
    "discord_client_id",
    "discord_client_secret",
    "discord_redirect_uri",
    "jwt_secret",
];

pub async fn load_config(pool: &SqlitePool) -> DbResult<HashMap<String, String>> {
    let rows = sqlx::query_as::<_, (String, String)>(r#"SELECT key, value FROM app_config"#)
        .fetch_all(pool)
        .await?;

    Ok(rows.into_iter().collect())
}

pub async fn save_config(pool: &SqlitePool, entries: &[(&str, &str)]) -> DbResult<()> {
    for (key, value) in entries {
        sqlx::query("INSERT OR REPLACE INTO app_config (key, value) VALUES (?, ?)")
            .bind(key)
            .bind(value)
            .execute(pool)
            .await?;
    }
    Ok(())
}

pub async fn get_config(pool: &SqlitePool, key: &str) -> DbResult<Option<String>> {
    let row = sqlx::query_scalar::<_, String>(r#"SELECT value FROM app_config WHERE key = ?"#)
        .bind(key)
        .fetch_optional(pool)
        .await?;
    Ok(row.filter(|v| !v.is_empty()))
}

pub async fn is_configured(pool: &SqlitePool) -> DbResult<bool> {
    for key in REQUIRED_KEYS {
        let row = sqlx::query_scalar::<_, String>(r#"SELECT value FROM app_config WHERE key = ?"#)
            .bind(key)
            .fetch_optional(pool)
            .await?;

        match row {
            Some(v) if !v.is_empty() => {}
            _ => return Ok(false),
        }
    }
    Ok(true)
}
