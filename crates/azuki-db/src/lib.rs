pub mod config;
pub mod models;
pub mod queries;

use sqlx::sqlite::SqliteConnectOptions;
use sqlx::SqlitePool;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum DbError {
    #[error("database error: {0}")]
    Sqlx(#[from] sqlx::Error),
    #[error("migration error: {0}")]
    Migrate(#[from] sqlx::migrate::MigrateError),
    #[error("not found")]
    NotFound,
}

pub type DbResult<T> = Result<T, DbError>;

pub async fn create_pool(database_url: &str) -> DbResult<SqlitePool> {
    let options: SqliteConnectOptions = database_url.parse::<SqliteConnectOptions>()?
        .create_if_missing(true);
    let pool = SqlitePool::connect_with(options).await?;

    #[cfg(unix)]
    if let Some(path) = database_url.strip_prefix("sqlite:") {
        use std::os::unix::fs::PermissionsExt;
        let perms = std::fs::Permissions::from_mode(0o600);
        let _ = std::fs::set_permissions(path, perms.clone());
        let _ = std::fs::set_permissions(format!("{path}-wal"), perms.clone());
        let _ = std::fs::set_permissions(format!("{path}-shm"), perms);
    }

    sqlx::query("PRAGMA journal_mode = WAL")
        .execute(&pool)
        .await?;
    sqlx::query("PRAGMA foreign_keys = ON")
        .execute(&pool)
        .await?;
    sqlx::query("PRAGMA busy_timeout = 5000")
        .execute(&pool)
        .await?;
    Ok(pool)
}

pub async fn run_migrations(pool: &SqlitePool) -> DbResult<()> {
    sqlx::migrate!("../../migrations").run(pool).await?;
    Ok(())
}
