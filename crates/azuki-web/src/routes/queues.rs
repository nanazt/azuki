use axum::Json;
use axum::extract::State;
use axum_extra::extract::CookieJar;

use crate::auth::extract_user_id;
use crate::{ApiError, WebState};

/// GET /api/queues — get the current queue state
pub async fn get_queue_state(
    jar: CookieJar,
    State(state): State<WebState>,
) -> Result<Json<serde_json::Value>, ApiError> {
    extract_user_id(&jar, &state).await?;
    let snapshot = state.player.get_state().await;
    Ok(Json(serde_json::json!({
        "queue": snapshot.queue,
        "state": snapshot.state,
        "volume": snapshot.volume,
        "loop_mode": snapshot.loop_mode,
    })))
}

pub fn queue_routes() -> axum::Router<WebState> {
    axum::Router::new().route("/api/queues", axum::routing::get(get_queue_state))
}
