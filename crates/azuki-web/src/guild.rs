use std::collections::HashSet;
use std::sync::RwLock;
use std::time::Duration;

use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

#[derive(Debug, thiserror::Error)]
pub enum GuildCheckError {
    #[error("HTTP error: {0}")]
    Http(#[from] reqwest::Error),
    #[error("unauthorized (invalid bot token)")]
    Unauthorized,
    #[error("forbidden (bot not in guild)")]
    Forbidden,
    #[error("unexpected status: {0}")]
    UnexpectedStatus(u16),
}

pub struct GuildMemberCache {
    members: RwLock<HashSet<String>>,
}

#[derive(serde::Deserialize)]
struct MemberUser {
    id: String,
}

#[derive(serde::Deserialize)]
struct GuildMember {
    user: Option<MemberUser>,
}

impl Default for GuildMemberCache {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(feature = "test-support")]
impl GuildMemberCache {
    /// Replace the member set. For testing only.
    pub fn set_members(&self, ids: impl IntoIterator<Item = String>) {
        *self.members.write().expect("poisoned") = ids.into_iter().collect();
    }
}

impl GuildMemberCache {
    pub fn new() -> Self {
        Self {
            members: RwLock::new(HashSet::new()),
        }
    }

    /// Returns true if the user is a guild member.
    /// Returns true (fail-open) when the cache is empty (initial refresh not yet done).
    pub fn is_member(&self, user_id: &str) -> bool {
        let members = self.members.read().expect("guild member cache poisoned");
        if members.is_empty() {
            tracing::warn!("guild member cache is empty, allowing access (fail-open)");
            return true;
        }
        members.contains(user_id)
    }

    pub fn member_count(&self) -> usize {
        self.members
            .read()
            .expect("guild member cache poisoned")
            .len()
    }

    pub async fn refresh(
        &self,
        client: &reqwest::Client,
        api_base: &str,
        bot_token: &str,
        guild_id: u64,
    ) -> Result<(), GuildCheckError> {
        let mut all_members = HashSet::new();
        let mut after: Option<String> = None;

        loop {
            let mut url = format!("{api_base}/api/v10/guilds/{guild_id}/members?limit=1000");
            if let Some(ref after_id) = after {
                url.push_str(&format!("&after={after_id}"));
            }

            let resp = client
                .get(&url)
                .header("Authorization", format!("Bot {bot_token}"))
                .send()
                .await?;

            let status = resp.status().as_u16();
            match status {
                200 => {}
                401 => return Err(GuildCheckError::Unauthorized),
                403 => return Err(GuildCheckError::Forbidden),
                429 => {
                    let retry_after = resp
                        .headers()
                        .get("retry-after")
                        .and_then(|v| v.to_str().ok())
                        .and_then(|v| v.parse::<f64>().ok())
                        .unwrap_or(5.0)
                        .min(600.0);
                    tracing::warn!("rate limited, retrying after {retry_after}s");
                    tokio::time::sleep(Duration::from_secs_f64(retry_after)).await;

                    // One retry
                    let retry_resp = client
                        .get(&url)
                        .header("Authorization", format!("Bot {bot_token}"))
                        .send()
                        .await?;

                    let retry_status = retry_resp.status().as_u16();
                    if retry_status != 200 {
                        return Err(GuildCheckError::UnexpectedStatus(retry_status));
                    }
                    let members: Vec<GuildMember> = retry_resp.json().await?;
                    let last_id = Self::collect_members(&mut all_members, &members);
                    if members.len() < 1000 || last_id.is_none() {
                        break;
                    }
                    after = last_id;
                    continue;
                }
                _ => return Err(GuildCheckError::UnexpectedStatus(status)),
            }

            let members: Vec<GuildMember> = resp.json().await?;
            let last_id = Self::collect_members(&mut all_members, &members);
            if members.len() < 1000 || last_id.is_none() {
                break;
            }
            after = last_id;
        }

        let count = all_members.len();
        *self.members.write().expect("guild member cache poisoned") = all_members;
        tracing::info!("guild member cache refreshed: {count} members");
        Ok(())
    }

    fn collect_members(set: &mut HashSet<String>, members: &[GuildMember]) -> Option<String> {
        let mut last_id = None;
        for m in members {
            if let Some(ref user) = m.user {
                last_id = Some(user.id.clone());
                set.insert(user.id.clone());
            }
        }
        last_id
    }

    pub fn start_refresh_loop(
        self: &std::sync::Arc<Self>,
        client: reqwest::Client,
        api_base: String,
        bot_token: String,
        guild_id: u64,
        cancel: CancellationToken,
    ) -> JoinHandle<()> {
        let cache = std::sync::Arc::clone(self);
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(600));
            interval.tick().await; // skip immediate tick (initial refresh already done)
            loop {
                tokio::select! {
                    _ = interval.tick() => {
                        if let Err(e) = cache.refresh(&client, &api_base, &bot_token, guild_id).await {
                            tracing::warn!("guild member cache refresh failed: {e}");
                        }
                    }
                    _ = cancel.cancelled() => break,
                }
            }
        })
    }
}
