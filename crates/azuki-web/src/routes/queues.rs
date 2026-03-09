use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use axum_extra::extract::CookieJar;

use crate::auth::extract_user_id;
use crate::{ApiError, WebState};

/// GET /api/queues — list all queue slots
pub async fn list_queues(
    jar: CookieJar,
    State(state): State<WebState>,
) -> Result<Json<serde_json::Value>, ApiError> {
    extract_user_id(&jar, &state).await?;
    let slots = state.player.get_multi_queue_state().await;
    Ok(Json(serde_json::json!({ "slots": slots })))
}

/// GET /api/queues/{slot_id}/items — get items for a specific queue slot
pub async fn get_queue_items(
    jar: CookieJar,
    State(state): State<WebState>,
    Path(slot_id): Path<u8>,
) -> Result<Json<serde_json::Value>, ApiError> {
    extract_user_id(&jar, &state).await?;
    if slot_id > 4 {
        return Err(ApiError::BadRequest("invalid slot_id".to_string()));
    }
    // Get the full state and extract the queue for this slot
    let snapshot = state.player.get_state().await;
    // The queue in snapshot is for active slot only; for non-active, return empty for now
    if slot_id == snapshot.active_slot {
        Ok(Json(serde_json::json!({ "items": snapshot.queue })))
    } else {
        Ok(Json(serde_json::json!({ "items": [] })))
    }
}

/// POST /api/queues/{slot_id}/switch — switch to a queue slot
pub async fn switch_queue(
    jar: CookieJar,
    State(state): State<WebState>,
    Path(slot_id): Path<u8>,
) -> Result<StatusCode, ApiError> {
    extract_user_id(&jar, &state).await?;
    if slot_id > 4 {
        return Err(ApiError::BadRequest("invalid slot_id".to_string()));
    }
    state.player.switch_queue(slot_id).await?;
    Ok(StatusCode::OK)
}

/// DELETE /api/queues/{slot_id} — delete a queue slot
pub async fn delete_queue_slot(
    jar: CookieJar,
    State(state): State<WebState>,
    Path(slot_id): Path<u8>,
) -> Result<StatusCode, ApiError> {
    extract_user_id(&jar, &state).await?;
    if slot_id == 0 {
        return Err(ApiError::BadRequest("cannot delete default queue".to_string()));
    }
    if slot_id > 4 {
        return Err(ApiError::BadRequest("invalid slot_id".to_string()));
    }
    state.player.delete_slot(slot_id).await?;
    Ok(StatusCode::OK)
}

pub fn queue_routes() -> axum::Router<WebState> {
    axum::Router::new()
        .route("/api/queues", axum::routing::get(list_queues))
        .route("/api/queues/{slot_id}/items", axum::routing::get(get_queue_items))
        .route("/api/queues/{slot_id}/switch", axum::routing::post(switch_queue))
        .route("/api/queues/{slot_id}", axum::routing::delete(delete_queue_slot))
}
