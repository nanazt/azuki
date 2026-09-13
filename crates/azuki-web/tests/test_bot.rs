mod common;

use axum::body::Body;
use axum::http::{Method, Request, StatusCode, header};
use common::*;

fn assert_no_store(response: &axum::response::Response) {
    assert_eq!(
        response
            .headers()
            .get(header::CACHE_CONTROL)
            .and_then(|value| value.to_str().ok()),
        Some("no-store")
    );
}

#[tokio::test]
async fn authenticated_users_can_read_the_complete_bot_status_without_admin_access() {
    let app = TestApp::new().await;
    let user_cookie = create_test_user(&app, "user1", "member", false).await;
    let admin_cookie = create_test_user(&app, "admin1", "admin", true).await;

    for cookie in [&user_cookie, &admin_cookie] {
        let response = send(&app.router, get("/api/bot/status", cookie)).await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_no_store(&response);
        assert_eq!(
            body_json(response).await,
            serde_json::json!({
                "revision": 0,
                "status": "stopped",
                "target_voice_channel_id": null,
                "restart_in_progress": false,
                "restart_available_at": null,
                "next_retry_at": null,
                "last_error": null,
                "last_checkpoint_at": null,
                "persistence_error": null,
            })
        );
    }

    let admin_response = send(&app.router, get("/api/admin/bot-locale", &user_cookie)).await;
    assert_eq!(admin_response.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn restart_uses_shared_control_admission_and_coalesces_an_in_progress_request() {
    let app = TestApp::new().await;
    let cookie = create_test_user(&app, "user1", "member", false).await;
    let admin_cookie = create_test_user(&app, "admin1", "admin", true).await;

    let accepted = send(
        &app.router,
        post_json("/api/bot/restart", &cookie, serde_json::json!({})),
    )
    .await;
    assert_eq!(accepted.status(), StatusCode::ACCEPTED);
    assert_no_store(&accepted);
    let accepted_body = body_json(accepted).await;
    assert_eq!(accepted_body["outcome"], "accepted");
    assert_eq!(accepted_body["status"]["revision"], 1);
    assert_eq!(accepted_body["status"]["status"], "restarting");
    assert_eq!(accepted_body["status"]["restart_in_progress"], true);
    let available_at = accepted_body["status"]["restart_available_at"].clone();
    assert!(available_at.is_i64() || available_at.is_u64());

    let coalesced = send(
        &app.router,
        post_json("/api/bot/restart", &admin_cookie, serde_json::json!({})),
    )
    .await;
    assert_eq!(coalesced.status(), StatusCode::ACCEPTED);
    assert_no_store(&coalesced);
    let coalesced_body = body_json(coalesced).await;
    assert_eq!(coalesced_body["outcome"], "already_restarting");
    assert_eq!(coalesced_body["status"]["revision"], 1);
    assert_eq!(
        coalesced_body["status"]["restart_available_at"],
        available_at
    );
}

#[tokio::test]
async fn bot_routes_preserve_authentication_csrf_and_membership_precedence() {
    let app = TestApp::new().await;
    let cookie = create_test_user(&app, "user1", "member", false).await;

    let response = send(&app.router, unauthed_get("/api/bot/status")).await;
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    assert_no_store(&response);

    let response = send(&app.router, unauthed_post("/api/bot/restart")).await;
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    assert_no_store(&response);

    let response = send(&app.router, post_no_csrf("/api/bot/restart", &cookie)).await;
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    assert_no_store(&response);

    let missing_csrf_without_auth = Request::builder()
        .method(Method::POST)
        .uri("/api/bot/restart")
        .body(Body::empty())
        .unwrap();
    let response = send(&app.router, missing_csrf_without_auth).await;
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    assert_no_store(&response);

    let invalid_csrf = Request::builder()
        .method(Method::POST)
        .uri("/api/bot/restart")
        .header("cookie", &cookie)
        .header("x-requested-with", "fetch")
        .body(Body::empty())
        .unwrap();
    let response = send(&app.router, invalid_csrf).await;
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    assert_no_store(&response);

    let invalid_csrf_without_auth = Request::builder()
        .method(Method::POST)
        .uri("/api/bot/restart")
        .header("x-requested-with", "fetch")
        .body(Body::empty())
        .unwrap();
    let response = send(&app.router, invalid_csrf_without_auth).await;
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    assert_no_store(&response);

    let guild_app = TestApp::with_guild(42, "").await;
    let guild_cookie = create_test_user(&guild_app, "user2", "former-member", false).await;
    guild_app
        .guild_member_cache
        .set_members(["different-user".to_string()]);
    let response = send(
        &guild_app.router,
        post_json("/api/bot/restart", &guild_cookie, serde_json::json!({})),
    )
    .await;
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    assert_no_store(&response);
}

#[tokio::test]
async fn restart_reports_unavailable_when_the_runtime_receiver_is_gone() {
    let mut app = TestApp::new().await;
    let cookie = create_test_user(&app, "user1", "member", false).await;
    app.stop_bot_runtime();

    let response = send(
        &app.router,
        post_json("/api/bot/restart", &cookie, serde_json::json!({})),
    )
    .await;
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_no_store(&response);
    assert_eq!(
        body_json(response).await,
        serde_json::json!({ "error": "bot runtime is unavailable" })
    );
}
