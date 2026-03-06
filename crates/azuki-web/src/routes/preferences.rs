use axum::extract::State;
use axum::Json;
use axum_extra::extract::CookieJar;
use serde::{Deserialize, Serialize};

use crate::auth::extract_user_id;
use crate::{ApiError, WebState};

#[derive(Serialize)]
pub struct PreferencesResponse {
    pub theme: String,
}

#[derive(Deserialize)]
pub struct UpdatePreferences {
    pub theme: Option<String>,
}

async fn get_preferences(
    State(state): State<WebState>,
    jar: CookieJar,
) -> Result<Json<PreferencesResponse>, ApiError> {
    let user_id = extract_user_id(&jar, &state).await?;
    let prefs =
        azuki_db::queries::preferences::get_user_preferences(&state.db, &user_id).await?;

    Ok(Json(PreferencesResponse { theme: prefs.theme }))
}

async fn update_preferences(
    State(state): State<WebState>,
    jar: CookieJar,
    Json(body): Json<UpdatePreferences>,
) -> Result<Json<PreferencesResponse>, ApiError> {
    let user_id = extract_user_id(&jar, &state).await?;

    let current =
        azuki_db::queries::preferences::get_user_preferences(&state.db, &user_id).await?;

    let theme = body.theme.as_deref().unwrap_or(&current.theme);

    if theme != "dark" {
        return Err(ApiError::BadRequest("theme must be dark".into()));
    }

    let prefs = azuki_db::queries::preferences::upsert_user_preferences(
        &state.db, &user_id, theme,
    )
    .await?;

    Ok(Json(PreferencesResponse { theme: prefs.theme }))
}

#[derive(Serialize)]
pub struct MeResponse {
    pub id: String,
    pub username: String,
    pub avatar_url: Option<String>,
}

async fn get_me(
    State(state): State<WebState>,
    jar: CookieJar,
) -> Result<Json<MeResponse>, ApiError> {
    let user_id = extract_user_id(&jar, &state).await?;
    let user = azuki_db::queries::users::get_user(&state.db, &user_id).await?;

    Ok(Json(MeResponse {
        id: user.id,
        username: user.username,
        avatar_url: user.avatar_url,
    }))
}

pub fn preferences_routes() -> axum::Router<WebState> {
    axum::Router::new()
        .route("/api/me", axum::routing::get(get_me))
        .route("/api/preferences", axum::routing::get(get_preferences))
        .route("/api/preferences", axum::routing::put(update_preferences))
}
