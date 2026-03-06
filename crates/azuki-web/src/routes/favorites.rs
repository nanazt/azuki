use axum::extract::{Path, State};
use axum::Json;
use axum_extra::extract::CookieJar;
use crate::auth::extract_user_id;
use crate::routes::content::PaginationQuery;
use crate::{ApiError, WebState};

pub async fn list_favorites(
    jar: CookieJar,
    State(state): State<WebState>,
    axum::extract::Query(params): axum::extract::Query<PaginationQuery>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let user_id = extract_user_id(&jar, &state).await?;
    let page = params.page.unwrap_or(1).max(1);
    let per_page = params.per_page.unwrap_or(20).min(100);
    let offset = (page - 1) * per_page;

    let favorites = azuki_db::queries::favorites::get_favorites(&state.db, &user_id, per_page, offset).await?;
    Ok(Json(serde_json::json!({
        "tracks": favorites,
        "page": page,
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
