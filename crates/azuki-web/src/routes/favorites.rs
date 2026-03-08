use axum::extract::{Path, State};
use axum::Json;
use axum_extra::extract::CookieJar;
use crate::auth::extract_user_id;
use crate::routes::content::{CursorQuery, decode_cursor, encode_cursor};
use crate::{ApiError, WebState};

pub async fn list_favorites(
    jar: CookieJar,
    State(state): State<WebState>,
    axum::extract::Query(params): axum::extract::Query<CursorQuery>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let user_id = extract_user_id(&jar, &state).await?;
    let limit = params.limit.unwrap_or(50).clamp(1, 100);

    let before_created_at: Option<String> = params
        .cursor
        .as_deref()
        .map(decode_cursor)
        .transpose()?;

    let favorites = azuki_db::queries::favorites::get_favorites(
        &state.db,
        &user_id,
        limit,
        before_created_at.as_deref(),
    )
    .await?;

    let next_cursor = if favorites.len() as i64 == limit {
        favorites.last().map(|t| encode_cursor(&t.created_at))
    } else {
        None
    };

    Ok(Json(serde_json::json!({
        "items": favorites,
        "next_cursor": next_cursor,
    })))
}

pub async fn toggle_favorite(
    jar: CookieJar,
    State(state): State<WebState>,
    Path(track_id): Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let user_id = extract_user_id(&jar, &state).await?;
    let is_favorited = azuki_db::queries::favorites::toggle_favorite(&state.db, &user_id, &track_id).await?;
    let _ = state.web_tx.send(crate::events::WebSeqEvent {
        seq: 0,
        event: crate::events::WebEvent::FavoriteChanged {
            track_id: track_id.clone(),
            user_id: user_id.clone(),
            favorited: is_favorited,
        },
    });
    Ok(Json(serde_json::json!({ "favorited": is_favorited })))
}

pub fn favorites_routes() -> axum::Router<WebState> {
    axum::Router::new()
        .route("/api/favorites", axum::routing::get(list_favorites))
        .route("/api/favorites/{track_id}", axum::routing::post(toggle_favorite))
}
