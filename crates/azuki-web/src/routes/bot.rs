use axum::extract::State;
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::{Json, Router};
use axum_extra::extract::CookieJar;
use serde::Serialize;

use azuki_bot::{BotStatus, RestartError, RestartOutcome};

use crate::auth::extract_user_id;
use crate::{ApiError, WebState};

#[derive(Serialize)]
struct RestartResponse {
    outcome: &'static str,
    status: BotStatus,
}

pub async fn status(
    jar: CookieJar,
    State(state): State<WebState>,
) -> Result<Json<BotStatus>, ApiError> {
    extract_user_id(&jar, &state).await?;
    Ok(Json(state.bot_control.status()))
}

pub async fn restart(jar: CookieJar, State(state): State<WebState>) -> Result<Response, ApiError> {
    extract_user_id(&jar, &state).await?;
    restart_response(state.bot_control.restart().await)
}

fn restart_response(result: Result<RestartOutcome, RestartError>) -> Result<Response, ApiError> {
    let response = match result {
        Ok(RestartOutcome::Accepted(status)) => (
            StatusCode::ACCEPTED,
            Json(RestartResponse {
                outcome: "accepted",
                status,
            }),
        )
            .into_response(),
        Ok(RestartOutcome::AlreadyRestarting(status)) => (
            StatusCode::ACCEPTED,
            Json(RestartResponse {
                outcome: "already_restarting",
                status,
            }),
        )
            .into_response(),
        Err(RestartError::Cooldown {
            retry_after_seconds,
        }) => {
            let mut response = (
                StatusCode::TOO_MANY_REQUESTS,
                Json(serde_json::json!({
                    "error": "bot restart is on cooldown",
                    "retry_after_seconds": retry_after_seconds,
                })),
            )
                .into_response();
            let retry_after: HeaderValue = retry_after_seconds
                .to_string()
                .parse()
                .map_err(|_| ApiError::Internal("invalid restart cooldown".to_string()))?;
            response
                .headers_mut()
                .insert(header::RETRY_AFTER, retry_after);
            response
        }
        Err(RestartError::Unavailable) => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(serde_json::json!({
                "error": "bot runtime is unavailable",
            })),
        )
            .into_response(),
    };

    Ok(response)
}

pub fn bot_routes() -> Router<WebState> {
    Router::new()
        .route("/api/bot/status", axum::routing::get(status))
        .route("/api/bot/restart", axum::routing::post(restart))
}

#[cfg(test)]
mod tests {
    use http_body_util::BodyExt;

    use super::*;

    #[tokio::test]
    async fn cooldown_response_has_retry_header_and_structured_remaining_time() {
        let response = restart_response(Err(RestartError::Cooldown {
            retry_after_seconds: 11,
        }))
        .unwrap();

        assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(
            response
                .headers()
                .get(header::RETRY_AFTER)
                .and_then(|value| value.to_str().ok()),
            Some("11")
        );
        let body = response.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&body).unwrap(),
            serde_json::json!({
                "error": "bot restart is on cooldown",
                "retry_after_seconds": 11,
            })
        );
    }
}
