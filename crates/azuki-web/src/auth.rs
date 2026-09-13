#[cfg(feature = "test-support")]
use std::sync::Arc;

#[cfg(feature = "test-support")]
use axum::Extension;
use axum::Json;
use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Redirect, Response};
use axum_extra::extract::CookieJar;
use axum_extra::extract::cookie::{Cookie, SameSite};
use chrono::Utc;
use jsonwebtoken::errors::{Error as JwtError, ErrorKind, new_error};
use jsonwebtoken::{Algorithm, DecodingKey, EncodingKey, Header, Validation, decode, encode};
use serde::{Deserialize, Serialize};
#[cfg(feature = "test-support")]
use tokio::sync::Notify;
use tracing::error;

use crate::{ApiError, WebState};

const INACTIVITY_SECONDS: i64 = 7 * 24 * 60 * 60;
const ABSOLUTE_SESSION_SECONDS: i64 = 90 * 24 * 60 * 60;
const OAUTH_STATE_COOKIE: &str = "oauth_state";
const JWT_COOKIE: &str = "azuki_token";

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Claims {
    pub sub: String,
    pub exp: i64,
    pub tv: i64,
    pub session_started_at: i64,
}
impl Claims {
    pub fn absolute_expires_at(&self) -> Option<i64> {
        self.session_started_at
            .checked_add(ABSOLUTE_SESSION_SECONDS)
    }
}

#[derive(Clone, Debug)]
pub struct AuthenticatedUser {
    pub user: azuki_db::models::User,
    pub claims: Claims,
}

#[derive(Clone, Debug)]
pub struct AuthRevocation {
    pub user_id: String,
    pub token_version: i64,
}

#[cfg(feature = "test-support")]
#[derive(Debug, Default)]
pub struct LogoutTestGate {
    entered: Notify,
    resume: Notify,
}

#[cfg(feature = "test-support")]
impl LogoutTestGate {
    pub async fn wait_until_entered(&self) {
        self.entered.notified().await;
    }

    pub fn resume(&self) {
        self.resume.notify_one();
    }

    async fn pause(&self) {
        self.entered.notify_one();
        self.resume.notified().await;
    }
}

#[derive(Serialize)]
pub struct AuthLifetimeResponse {
    pub expires_at: i64,
    pub absolute_expires_at: i64,
}

#[derive(Deserialize)]
pub struct OAuthCallback {
    pub code: String,
    pub state: String,
}

#[derive(Deserialize)]
struct DiscordTokenResponse {
    access_token: String,
    #[allow(dead_code)]
    token_type: String,
}

#[derive(Deserialize)]
struct DiscordUser {
    id: String,
    username: String,
    avatar: Option<String>,
}

fn invalid_token() -> JwtError {
    new_error(ErrorKind::InvalidToken)
}

fn absolute_expires_at(claims: &Claims) -> Result<i64, JwtError> {
    claims.absolute_expires_at().ok_or_else(invalid_token)
}

fn validate_claims_at(claims: &Claims, now: i64) -> Result<(), JwtError> {
    if claims.sub.is_empty() || claims.tv < 0 {
        return Err(invalid_token());
    }
    if claims.session_started_at > now {
        return Err(new_error(ErrorKind::ImmatureSignature));
    }
    if now >= claims.exp {
        return Err(new_error(ErrorKind::ExpiredSignature));
    }
    if claims.exp > absolute_expires_at(claims)? {
        return Err(invalid_token());
    }
    Ok(())
}

fn encode_claims(claims: &Claims, secret: &str) -> Result<String, JwtError> {
    encode(
        &Header::new(Algorithm::HS256),
        claims,
        &EncodingKey::from_secret(secret.as_bytes()),
    )
}

fn create_initial_jwt_at(
    user_id: &str,
    secret: &str,
    token_version: i64,
    now: i64,
) -> Result<(String, Claims), JwtError> {
    let exp = now
        .checked_add(INACTIVITY_SECONDS)
        .ok_or_else(invalid_token)?;
    let claims = Claims {
        sub: user_id.to_string(),
        exp,
        tv: token_version,
        session_started_at: now,
    };
    validate_claims_at(&claims, now)?;
    let token = encode_claims(&claims, secret)?;
    Ok((token, claims))
}

fn renew_claims_at(claims: &Claims, now: i64) -> Result<Claims, JwtError> {
    validate_claims_at(claims, now)?;
    let inactivity_expires_at = now
        .checked_add(INACTIVITY_SECONDS)
        .ok_or_else(invalid_token)?;
    let exp = inactivity_expires_at.min(absolute_expires_at(claims)?);
    let renewed = Claims {
        sub: claims.sub.clone(),
        exp,
        tv: claims.tv,
        session_started_at: claims.session_started_at,
    };
    validate_claims_at(&renewed, now)?;
    Ok(renewed)
}

fn verify_jwt_at(token: &str, secret: &str, now: i64) -> Result<Claims, JwtError> {
    let mut validation = Validation::new(Algorithm::HS256);
    validation.validate_exp = false;
    validation.leeway = 0;
    validation.set_required_spec_claims(&["sub", "exp", "tv", "session_started_at"]);
    let data = decode::<Claims>(
        token,
        &DecodingKey::from_secret(secret.as_bytes()),
        &validation,
    )?;
    validate_claims_at(&data.claims, now)?;
    Ok(data.claims)
}

pub fn create_jwt(user_id: &str, secret: &str, token_version: i64) -> Result<String, JwtError> {
    create_initial_jwt_at(user_id, secret, token_version, Utc::now().timestamp())
        .map(|(token, _)| token)
}

pub fn verify_jwt(token: &str, secret: &str) -> Result<Claims, JwtError> {
    verify_jwt_at(token, secret, Utc::now().timestamp())
}
fn jwt_cookie(token: String, max_age_seconds: i64, is_secure: bool) -> Cookie<'static> {
    Cookie::build((JWT_COOKIE, token))
        .http_only(true)
        .secure(is_secure)
        .same_site(SameSite::Lax)
        .max_age(cookie::time::Duration::seconds(max_age_seconds))
        .path("/")
        .build()
}

fn clear_jwt_cookie(is_secure: bool) -> Cookie<'static> {
    Cookie::build((JWT_COOKIE, ""))
        .http_only(true)
        .secure(is_secure)
        .same_site(SameSite::Lax)
        .max_age(cookie::time::Duration::ZERO)
        .path("/")
        .build()
}

fn lifetime_response(claims: &Claims) -> Result<AuthLifetimeResponse, ApiError> {
    Ok(AuthLifetimeResponse {
        expires_at: claims.exp,
        absolute_expires_at: absolute_expires_at(claims).map_err(|_| ApiError::Unauthorized)?,
    })
}

pub async fn login(State(state): State<WebState>, jar: CookieJar) -> impl IntoResponse {
    let oauth_state = uuid::Uuid::new_v4().to_string();
    let is_secure = state.discord_redirect_uri.starts_with("https://");

    let state_cookie = Cookie::build((OAUTH_STATE_COOKIE, oauth_state.clone()))
        .http_only(true)
        .secure(is_secure)
        .same_site(SameSite::Lax)
        .max_age(cookie::time::Duration::seconds(300))
        .path("/")
        .build();

    let url = format!(
        "https://discord.com/api/oauth2/authorize?client_id={}&redirect_uri={}&response_type=code&scope=identify&state={}",
        state.discord_client_id,
        urlencoding::encode(&state.discord_redirect_uri),
        oauth_state,
    );

    (jar.add(state_cookie), Redirect::temporary(&url))
}

pub async fn callback(
    State(state): State<WebState>,
    jar: CookieJar,
    Query(params): Query<OAuthCallback>,
) -> Response {
    // Validate CSRF state
    let stored_state = match jar.get(OAUTH_STATE_COOKIE) {
        Some(c) => c.value().to_string(),
        None => {
            return Redirect::temporary("/auth/login").into_response();
        }
    };

    if stored_state != params.state {
        return (StatusCode::BAD_REQUEST, "oauth state mismatch").into_response();
    }

    // Exchange code for token
    let client = &state.http_client;
    let token_resp = client
        .post(format!("{}/api/oauth2/token", state.discord_api_base))
        .form(&[
            ("client_id", state.discord_client_id.as_str()),
            ("client_secret", state.discord_client_secret.as_str()),
            ("grant_type", "authorization_code"),
            ("code", &params.code),
            ("redirect_uri", &state.discord_redirect_uri),
        ])
        .send()
        .await;

    let token_resp = match token_resp {
        Ok(r) => r,
        Err(e) => {
            error!("discord token exchange failed: {e}");
            return (StatusCode::BAD_GATEWAY, "discord token exchange failed").into_response();
        }
    };

    let token_data: DiscordTokenResponse = match token_resp.json().await {
        Ok(d) => d,
        Err(e) => {
            error!("failed to parse discord token: {e}");
            return (StatusCode::BAD_GATEWAY, "invalid discord response").into_response();
        }
    };

    // Get user info
    let user_resp = client
        .get(format!("{}/api/users/@me", state.discord_api_base))
        .bearer_auth(&token_data.access_token)
        .send()
        .await;

    let user: DiscordUser = match user_resp {
        Ok(r) => match r.json().await {
            Ok(u) => u,
            Err(e) => {
                error!("failed to parse discord user: {e}");
                return (StatusCode::BAD_GATEWAY, "invalid user response").into_response();
            }
        },
        Err(e) => {
            error!("discord user fetch failed: {e}");
            return (StatusCode::BAD_GATEWAY, "user fetch failed").into_response();
        }
    };

    // Guild membership check
    if state.guild_id != 0 {
        if !state.guild_member_cache.is_member(&user.id) {
            let clear_state = Cookie::build((OAUTH_STATE_COOKIE, ""))
                .path("/")
                .max_age(cookie::time::Duration::ZERO)
                .build();
            return (
                jar.add(clear_state),
                Redirect::temporary("/login?error=not_member"),
            )
                .into_response();
        }
    } else {
        tracing::warn!("guild_id is 0, skipping guild membership check");
    }

    // Upsert user in DB
    let avatar_url = user
        .avatar
        .as_ref()
        .map(|hash| format!("https://cdn.discordapp.com/avatars/{}/{hash}.png", user.id));

    let db_user = match azuki_db::queries::users::upsert_user(
        &state.db,
        &user.id,
        &user.username,
        avatar_url.as_deref(),
    )
    .await
    {
        Ok(u) => u,
        Err(e) => {
            error!("failed to upsert user: {e}");
            return (StatusCode::INTERNAL_SERVER_ERROR, "database error").into_response();
        }
    };

    let now = Utc::now().timestamp();
    let (jwt, claims) =
        match create_initial_jwt_at(&user.id, &state.jwt_secret, db_user.token_version, now) {
            Ok(created) => created,
            Err(e) => {
                error!("failed to create JWT: {e}");
                return (StatusCode::INTERNAL_SERVER_ERROR, "token creation failed")
                    .into_response();
            }
        };

    let is_secure = state.discord_redirect_uri.starts_with("https://");
    let jwt_cookie = jwt_cookie(jwt, claims.exp - now, is_secure);

    let clear_state = Cookie::build((OAUTH_STATE_COOKIE, ""))
        .path("/")
        .max_age(cookie::time::Duration::ZERO)
        .build();

    let jar = jar.add(jwt_cookie).add(clear_state);

    (jar, Redirect::temporary("/")).into_response()
}

async fn revalidate_claims_base(
    claims: &Claims,
    state: &WebState,
) -> Result<azuki_db::models::User, ApiError> {
    validate_claims_at(claims, Utc::now().timestamp()).map_err(|_| ApiError::Unauthorized)?;

    let user = match azuki_db::queries::users::get_user(&state.db, &claims.sub).await {
        Ok(user) => user,
        Err(azuki_db::DbError::NotFound) => return Err(ApiError::Unauthorized),
        Err(error) => return Err(ApiError::Db(error)),
    };
    validate_claims_at(claims, Utc::now().timestamp()).map_err(|_| ApiError::Unauthorized)?;
    if claims.tv != user.token_version {
        return Err(ApiError::Unauthorized);
    }
    Ok(user)
}

pub async fn revalidate_claims(
    claims: &Claims,
    state: &WebState,
) -> Result<azuki_db::models::User, ApiError> {
    let user = revalidate_claims_base(claims, state).await?;
    if state.guild_id != 0 && !state.guild_member_cache.is_member(&claims.sub) {
        return Err(ApiError::Forbidden);
    }
    Ok(user)
}

async fn extract_verified_base_auth(
    jar: &CookieJar,
    state: &WebState,
) -> Result<AuthenticatedUser, ApiError> {
    let token = jar
        .get(JWT_COOKIE)
        .map(|cookie| cookie.value())
        .ok_or(ApiError::Unauthorized)?;
    let claims = verify_jwt(token, &state.jwt_secret).map_err(|_| ApiError::Unauthorized)?;
    let user = revalidate_claims_base(&claims, state).await?;
    Ok(AuthenticatedUser { user, claims })
}

pub async fn extract_verified_auth(
    jar: &CookieJar,
    state: &WebState,
) -> Result<AuthenticatedUser, ApiError> {
    let authenticated = extract_verified_base_auth(jar, state).await?;
    if state.guild_id != 0
        && !state
            .guild_member_cache
            .is_member(&authenticated.claims.sub)
    {
        return Err(ApiError::Forbidden);
    }
    Ok(authenticated)
}

pub async fn extract_user_id(jar: &CookieJar, state: &WebState) -> Result<String, ApiError> {
    extract_verified_auth(jar, state)
        .await
        .map(|authenticated| authenticated.user.id)
}

pub async fn extract_admin_id(jar: &CookieJar, state: &WebState) -> Result<String, ApiError> {
    let authenticated = extract_verified_auth(jar, state).await?;
    if !authenticated.user.is_admin {
        return Err(ApiError::Forbidden);
    }
    Ok(authenticated.user.id)
}

pub async fn refresh(State(state): State<WebState>, jar: CookieJar) -> Result<Response, ApiError> {
    let authenticated = extract_verified_auth(&jar, &state).await?;
    let now = Utc::now().timestamp();
    let renewed =
        renew_claims_at(&authenticated.claims, now).map_err(|_| ApiError::Unauthorized)?;
    let token = encode_claims(&renewed, &state.jwt_secret)
        .map_err(|error| ApiError::Internal(error.to_string()))?;
    let lifetime = lifetime_response(&renewed)?;
    let is_secure = state.discord_redirect_uri.starts_with("https://");
    let cookie = jwt_cookie(token, renewed.exp - now, is_secure);
    Ok((jar.add(cookie), Json(lifetime)).into_response())
}

pub async fn logout(
    State(state): State<WebState>,
    headers: HeaderMap,
    jar: CookieJar,
    #[cfg(feature = "test-support")] gate: Option<Extension<Arc<LogoutTestGate>>>,
) -> Response {
    let has_csrf = headers
        .get("x-requested-with")
        .and_then(|value| value.to_str().ok())
        == Some("XMLHttpRequest");
    if !has_csrf {
        return ApiError::Forbidden.into_response();
    }

    let authenticated = match extract_verified_base_auth(&jar, &state).await {
        Ok(authenticated) => authenticated,
        Err(error) => return error.into_response(),
    };
    #[cfg(feature = "test-support")]
    if let Some(Extension(gate)) = gate {
        gate.pause().await;
    }

    let new_version = match azuki_db::queries::users::increment_token_version_if_current(
        &state.db,
        &authenticated.user.id,
        authenticated.claims.tv,
    )
    .await
    {
        Ok(Some(version)) => version,
        Ok(None) => return ApiError::Unauthorized.into_response(),
        Err(error) => return ApiError::Db(error).into_response(),
    };

    let _ = state.auth_revocations.send(AuthRevocation {
        user_id: authenticated.user.id,
        token_version: new_version,
    });

    let is_secure = state.discord_redirect_uri.starts_with("https://");
    (jar.add(clear_jwt_cookie(is_secure)), StatusCode::NO_CONTENT).into_response()
}

pub fn auth_routes() -> axum::Router<WebState> {
    axum::Router::new()
        .route("/auth/login", axum::routing::get(login))
        .route("/auth/callback", axum::routing::get(callback))
        .route("/auth/logout", axum::routing::post(logout))
}

mod urlencoding {
    pub fn encode(s: &str) -> String {
        url::form_urlencoded::byte_serialize(s.as_bytes()).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_700_000_000;
    const SECRET: &str = "test-secret";

    #[test]
    fn initial_credentials_have_exact_seven_day_lifetime() {
        let (token, claims) = create_initial_jwt_at("user", SECRET, 3, NOW).unwrap();

        assert_eq!(claims.session_started_at, NOW);
        assert_eq!(claims.exp, NOW + INACTIVITY_SECONDS);
        assert_eq!(claims.tv, 3);
        assert_eq!(
            verify_jwt_at(&token, SECRET, claims.exp - 1).unwrap().sub,
            "user"
        );
        let error = verify_jwt_at(&token, SECRET, claims.exp).unwrap_err();
        assert!(matches!(error.kind(), ErrorKind::ExpiredSignature));
    }

    #[test]
    fn session_start_is_required_and_cannot_be_in_the_future() {
        let missing_start = serde_json::json!({
            "sub": "user",
            "exp": NOW + 60,
            "tv": 0
        });
        let token = encode(
            &Header::new(Algorithm::HS256),
            &missing_start,
            &EncodingKey::from_secret(SECRET.as_bytes()),
        )
        .unwrap();
        assert!(verify_jwt_at(&token, SECRET, NOW).is_err());

        let future_start = Claims {
            sub: "user".to_string(),
            exp: NOW + 60,
            tv: 0,
            session_started_at: NOW + 1,
        };
        let token = encode_claims(&future_start, SECRET).unwrap();
        let error = verify_jwt_at(&token, SECRET, NOW).unwrap_err();
        assert!(matches!(error.kind(), ErrorKind::ImmatureSignature));
    }

    #[test]
    fn renewal_is_usable_at_old_expiry_and_preserves_session_identity() {
        let old = Claims {
            sub: "user".to_string(),
            exp: NOW + 60,
            tv: 4,
            session_started_at: NOW - 6 * 24 * 60 * 60,
        };
        let renewed = renew_claims_at(&old, NOW).unwrap();

        assert_eq!(renewed.sub, old.sub);
        assert_eq!(renewed.tv, old.tv);
        assert_eq!(renewed.session_started_at, old.session_started_at);
        assert!(validate_claims_at(&old, old.exp).is_err());
        assert!(validate_claims_at(&renewed, old.exp).is_ok());
    }

    #[test]
    fn renewal_caps_expiry_at_ninety_days_and_rejects_the_boundary() {
        let session_started_at = NOW - 89 * 24 * 60 * 60;
        let old = Claims {
            sub: "user".to_string(),
            exp: NOW + 60,
            tv: 0,
            session_started_at,
        };

        let renewed = renew_claims_at(&old, NOW).unwrap();
        let absolute_expires_at = session_started_at + ABSOLUTE_SESSION_SECONDS;
        assert_eq!(renewed.exp, absolute_expires_at);
        assert!(validate_claims_at(&renewed, absolute_expires_at - 1).is_ok());
        let error = validate_claims_at(&renewed, absolute_expires_at).unwrap_err();
        assert!(matches!(error.kind(), ErrorKind::ExpiredSignature));
    }

    #[test]
    fn credentials_cannot_extend_past_the_absolute_lifetime() {
        let claims = Claims {
            sub: "user".to_string(),
            exp: NOW + 1,
            tv: 0,
            session_started_at: NOW - ABSOLUTE_SESSION_SECONDS,
        };

        assert!(validate_claims_at(&claims, NOW).is_err());
    }
}
