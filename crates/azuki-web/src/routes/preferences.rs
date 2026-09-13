use axum::Json;
use axum::extract::State;
use axum_extra::extract::CookieJar;
use serde::{Deserialize, Serialize};

use crate::auth::{extract_user_id, extract_verified_auth};
use crate::{ApiError, WebState};

#[derive(Serialize)]
pub struct PreferencesResponse {
    pub theme: String,
    pub locale: String,
}

#[derive(Deserialize)]
pub struct UpdatePreferences {
    pub theme: Option<String>,
    pub locale: Option<String>,
}

async fn get_preferences(
    State(state): State<WebState>,
    jar: CookieJar,
) -> Result<Json<PreferencesResponse>, ApiError> {
    let user_id = extract_user_id(&jar, &state).await?;
    let prefs = azuki_db::queries::preferences::get_user_preferences(&state.db, &user_id).await?;

    Ok(Json(PreferencesResponse {
        theme: prefs.theme,
        locale: prefs.locale,
    }))
}

async fn update_preferences(
    State(state): State<WebState>,
    jar: CookieJar,
    Json(body): Json<UpdatePreferences>,
) -> Result<Json<PreferencesResponse>, ApiError> {
    let user_id = extract_user_id(&jar, &state).await?;

    let current = azuki_db::queries::preferences::get_user_preferences(&state.db, &user_id).await?;

    let theme = body.theme.as_deref().unwrap_or(&current.theme);
    let locale = body.locale.as_deref().unwrap_or(&current.locale);

    if !matches!(theme, "dark" | "light" | "system") {
        return Err(ApiError::BadRequest(
            "theme must be dark, light, or system".into(),
        ));
    }

    if !matches!(locale, "ko" | "en") {
        return Err(ApiError::BadRequest("locale must be ko or en".into()));
    }

    let prefs =
        azuki_db::queries::preferences::upsert_user_preferences(&state.db, &user_id, theme, locale)
            .await?;

    Ok(Json(PreferencesResponse {
        theme: prefs.theme,
        locale: prefs.locale,
    }))
}

#[derive(Serialize)]
pub struct MeResponse {
    pub id: String,
    pub username: String,
    pub avatar_url: Option<String>,
    pub is_admin: bool,
    pub expires_at: i64,
    pub absolute_expires_at: i64,
}

async fn get_me(
    State(state): State<WebState>,
    jar: CookieJar,
) -> Result<Json<MeResponse>, ApiError> {
    let authenticated = extract_verified_auth(&jar, &state).await?;
    let absolute_expires_at = authenticated
        .claims
        .absolute_expires_at()
        .ok_or(ApiError::Unauthorized)?;

    Ok(Json(MeResponse {
        id: authenticated.user.id,
        username: authenticated.user.username,
        avatar_url: authenticated.user.avatar_url,
        is_admin: authenticated.user.is_admin,
        expires_at: authenticated.claims.exp,
        absolute_expires_at,
    }))
}

pub fn preferences_routes() -> axum::Router<WebState> {
    axum::Router::new()
        .route("/api/me", axum::routing::get(get_me))
        .route("/api/preferences", axum::routing::get(get_preferences))
        .route("/api/preferences", axum::routing::put(update_preferences))
}
