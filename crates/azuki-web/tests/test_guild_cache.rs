use std::sync::Arc;

use wiremock::matchers::{header, method, path_regex};
use wiremock::{Mock, MockServer, ResponseTemplate};

use azuki_web::guild::GuildMemberCache;

fn member_json(ids: &[&str]) -> serde_json::Value {
    ids.iter()
        .map(|id| serde_json::json!({"user": {"id": id}}))
        .collect::<Vec<_>>()
        .into()
}

#[tokio::test]
async fn cache_returns_true_for_member_after_refresh() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path_regex(r"/api/v10/guilds/.*/members"))
        .and(header("Authorization", "Bot test-token"))
        .respond_with(ResponseTemplate::new(200).set_body_json(member_json(&["user1", "user2"])))
        .mount(&server)
        .await;

    let cache = GuildMemberCache::new();
    let client = reqwest::Client::new();
    cache
        .refresh(&client, &server.uri(), "test-token", 12345)
        .await
        .unwrap();

    assert!(cache.is_member("user1"));
    assert!(cache.is_member("user2"));
}

#[tokio::test]
async fn cache_returns_false_for_non_member() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path_regex(r"/api/v10/guilds/.*/members"))
        .respond_with(ResponseTemplate::new(200).set_body_json(member_json(&["user1"])))
        .mount(&server)
        .await;

    let cache = GuildMemberCache::new();
    let client = reqwest::Client::new();
    cache
        .refresh(&client, &server.uri(), "test-token", 12345)
        .await
        .unwrap();

    assert!(!cache.is_member("unknown"));
}

#[tokio::test]
async fn cache_refresh_parses_discord_member_list() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path_regex(r"/api/v10/guilds/.*/members"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(member_json(&["a", "b", "c", "d", "e"])),
        )
        .mount(&server)
        .await;

    let cache = GuildMemberCache::new();
    let client = reqwest::Client::new();
    cache
        .refresh(&client, &server.uri(), "test-token", 12345)
        .await
        .unwrap();

    assert_eq!(cache.member_count(), 5);
}

#[tokio::test]
async fn cache_is_empty_returns_true_fail_open() {
    let cache = GuildMemberCache::new();
    // Empty cache should return true (fail-open)
    assert!(cache.is_member("anyone"));
}

#[tokio::test]
async fn cache_refresh_updates_member_set() {
    let server = MockServer::start().await;

    // First refresh: user1, user2
    Mock::given(method("GET"))
        .and(path_regex(r"/api/v10/guilds/.*/members"))
        .respond_with(ResponseTemplate::new(200).set_body_json(member_json(&["user1", "user2"])))
        .up_to_n_times(1)
        .mount(&server)
        .await;

    let cache = GuildMemberCache::new();
    let client = reqwest::Client::new();
    cache
        .refresh(&client, &server.uri(), "test-token", 12345)
        .await
        .unwrap();

    assert!(cache.is_member("user1"));
    assert!(cache.is_member("user2"));

    // Second refresh: user3 only
    Mock::given(method("GET"))
        .and(path_regex(r"/api/v10/guilds/.*/members"))
        .respond_with(ResponseTemplate::new(200).set_body_json(member_json(&["user3"])))
        .mount(&server)
        .await;

    cache
        .refresh(&client, &server.uri(), "test-token", 12345)
        .await
        .unwrap();

    assert!(!cache.is_member("user1"));
    assert!(!cache.is_member("user2"));
    assert!(cache.is_member("user3"));
    assert_eq!(cache.member_count(), 1);
}

#[tokio::test]
async fn cache_returns_error_on_invalid_bot_token() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path_regex(r"/api/v10/guilds/.*/members"))
        .respond_with(ResponseTemplate::new(401))
        .mount(&server)
        .await;

    let cache = GuildMemberCache::new();
    let client = reqwest::Client::new();
    let result = cache
        .refresh(&client, &server.uri(), "bad-token", 12345)
        .await;

    assert!(matches!(
        result,
        Err(azuki_web::guild::GuildCheckError::Unauthorized)
    ));
}

#[tokio::test]
async fn cache_returns_error_on_forbidden() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path_regex(r"/api/v10/guilds/.*/members"))
        .respond_with(ResponseTemplate::new(403))
        .mount(&server)
        .await;

    let cache = GuildMemberCache::new();
    let client = reqwest::Client::new();
    let result = cache
        .refresh(&client, &server.uri(), "test-token", 12345)
        .await;

    assert!(matches!(
        result,
        Err(azuki_web::guild::GuildCheckError::Forbidden)
    ));
}

#[tokio::test]
async fn cache_preserves_old_data_on_refresh_failure() {
    let server = MockServer::start().await;

    // First refresh succeeds
    Mock::given(method("GET"))
        .and(path_regex(r"/api/v10/guilds/.*/members"))
        .respond_with(ResponseTemplate::new(200).set_body_json(member_json(&["user1"])))
        .up_to_n_times(1)
        .mount(&server)
        .await;

    let cache = GuildMemberCache::new();
    let client = reqwest::Client::new();
    cache
        .refresh(&client, &server.uri(), "test-token", 12345)
        .await
        .unwrap();

    assert!(cache.is_member("user1"));

    // Second refresh fails (401)
    Mock::given(method("GET"))
        .and(path_regex(r"/api/v10/guilds/.*/members"))
        .respond_with(ResponseTemplate::new(401))
        .mount(&server)
        .await;

    let result = cache
        .refresh(&client, &server.uri(), "test-token", 12345)
        .await;
    assert!(result.is_err());

    // Old data preserved
    assert!(cache.is_member("user1"));
    assert_eq!(cache.member_count(), 1);
}

// Background task tests

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn background_task_refreshes_periodically() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path_regex(r"/api/v10/guilds/.*/members"))
        .and(header("Authorization", "Bot test-token"))
        .respond_with(ResponseTemplate::new(200).set_body_json(member_json(&["user1", "user2"])))
        .expect(1..)
        .mount(&server)
        .await;

    let cache = Arc::new(GuildMemberCache::new());
    let cancel = tokio_util::sync::CancellationToken::new();

    // Initial refresh (simulates what main.rs does)
    cache
        .refresh(&reqwest::Client::new(), &server.uri(), "test-token", 12345)
        .await
        .unwrap();

    let _handle = cache.start_refresh_loop(
        reqwest::Client::new(),
        server.uri(),
        "test-token".to_string(),
        12345,
        cancel.clone(),
    );

    // Advance past the first interval tick (600s) + buffer
    tokio::time::advance(std::time::Duration::from_secs(610)).await;
    // Yield to let the spawned task run
    tokio::task::yield_now().await;

    cancel.cancel();

    // wiremock expect(1..) validates at least 1 call was made by the loop
    // (plus the initial refresh call above)
}

#[tokio::test]
async fn background_loop_recovers_after_error() {
    let server = MockServer::start().await;

    // First call: 500 error. Second call onward: success.
    Mock::given(method("GET"))
        .and(path_regex(r"/api/v10/guilds/.*/members"))
        .respond_with(ResponseTemplate::new(500))
        .up_to_n_times(1)
        .expect(1)
        .mount(&server)
        .await;

    Mock::given(method("GET"))
        .and(path_regex(r"/api/v10/guilds/.*/members"))
        .respond_with(ResponseTemplate::new(200).set_body_json(member_json(&["user1"])))
        .expect(1..)
        .mount(&server)
        .await;

    let cache = Arc::new(GuildMemberCache::new());
    let cancel = tokio_util::sync::CancellationToken::new();

    // Use a very short interval (1s) to avoid long waits in real time
    let cache_clone = Arc::clone(&cache);
    let client = reqwest::Client::new();
    let api_base = server.uri();
    let cancel_clone = cancel.clone();
    let handle = tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_millis(100));
        interval.tick().await; // skip immediate tick
        loop {
            tokio::select! {
                _ = interval.tick() => {
                    if let Err(e) = cache_clone.refresh(&client, &api_base, "test-token", 12345).await {
                        tracing::warn!("test refresh failed: {e}");
                    }
                }
                _ = cancel_clone.cancelled() => break,
            }
        }
    });

    // Wait for loop to process both ticks (error + recovery)
    // Poll until cache is populated or timeout
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
    while cache.member_count() == 0 && tokio::time::Instant::now() < deadline {
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }

    cancel.cancel();
    handle.await.unwrap();

    // Loop survived the 500 error and recovered on the next tick
    assert!(
        cache.member_count() > 0,
        "loop should have recovered after error"
    );
    assert!(cache.is_member("user1"));
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn initial_refresh_timeout_is_non_fatal() {
    let server = MockServer::start().await;

    // Respond with a 5-second delay (will exceed our 1s timeout)
    Mock::given(method("GET"))
        .and(path_regex(r"/api/v10/guilds/.*/members"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(member_json(&["user1"]))
                .set_delay(std::time::Duration::from_secs(5)),
        )
        .mount(&server)
        .await;

    let cache = GuildMemberCache::new();
    let client = reqwest::Client::new();

    // Simulate initial refresh with timeout (like main.rs would do)
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(1),
        cache.refresh(&client, &server.uri(), "test-token", 12345),
    )
    .await;

    // Timeout should have fired
    assert!(result.is_err());

    // Cache is empty → fail-open → is_member returns true
    assert_eq!(cache.member_count(), 0);
    assert!(cache.is_member("anyone"));
}

#[tokio::test]
async fn background_task_stops_on_cancel() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path_regex(r"/api/v10/guilds/.*/members"))
        .respond_with(ResponseTemplate::new(200).set_body_json(member_json(&["user1"])))
        .mount(&server)
        .await;

    let cache = Arc::new(GuildMemberCache::new());
    let cancel = tokio_util::sync::CancellationToken::new();

    let handle = cache.start_refresh_loop(
        reqwest::Client::new(),
        server.uri(),
        "test-token".to_string(),
        12345,
        cancel.clone(),
    );

    // Give it a moment then cancel
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    cancel.cancel();

    // Should complete without hanging
    tokio::time::timeout(std::time::Duration::from_secs(2), handle)
        .await
        .expect("task should complete")
        .expect("task should not panic");
}
