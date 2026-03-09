use std::collections::HashMap;

use serde::Deserialize;
use url::Url;

use crate::types::TrackMeta;
use crate::MediaError;

pub struct YouTubeClient {
    client: reqwest::Client,
    api_key: String,
}

impl YouTubeClient {
    pub fn new(api_key: String) -> Self {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(10))
            .build()
            .expect("failed to build reqwest client");
        Self { client, api_key }
    }

    pub fn api_key_masked(&self) -> String {
        let key = &self.api_key;
        if key.len() >= 8 {
            format!("{}...{}", &key[..4], &key[key.len() - 3..])
        } else {
            "***".to_string()
        }
    }

    pub async fn search(&self, query: &str, limit: u32) -> Result<Vec<TrackMeta>, MediaError> {
        let search_url = Url::parse_with_params(
            "https://www.googleapis.com/youtube/v3/search",
            &[
                ("part", "snippet"),
                ("type", "video"),
                ("q", query),
                ("maxResults", &limit.to_string()),
                ("key", &self.api_key),
            ],
        )
        .map_err(|e| MediaError::YouTube(format!("failed to build search URL: {e}")))?;

        let search_resp: SearchResponse = self
            .client
            .get(search_url)
            .send()
            .await
            .map_err(|e| MediaError::YouTube(sanitize_error(e)))?
            .error_for_status()
            .map_err(|e| MediaError::YouTube(sanitize_error(e)))?
            .json()
            .await
            .map_err(|e| MediaError::YouTube(sanitize_error(e)))?;

        if search_resp.items.is_empty() {
            return Ok(Vec::new());
        }

        let ids: String = search_resp
            .items
            .iter()
            .map(|item| item.id.video_id.as_str())
            .collect::<Vec<_>>()
            .join(",");

        let video_url = Url::parse_with_params(
            "https://www.googleapis.com/youtube/v3/videos",
            &[
                ("part", "contentDetails"),
                ("id", &ids),
                ("key", &self.api_key),
            ],
        )
        .map_err(|e| MediaError::YouTube(format!("failed to build video URL: {e}")))?;

        let video_resp: VideoResponse = self
            .client
            .get(video_url)
            .send()
            .await
            .map_err(|e| MediaError::YouTube(sanitize_error(e)))?
            .error_for_status()
            .map_err(|e| MediaError::YouTube(sanitize_error(e)))?
            .json()
            .await
            .map_err(|e| MediaError::YouTube(sanitize_error(e)))?;

        let durations: HashMap<&str, u64> = video_resp
            .items
            .iter()
            .map(|v| {
                (
                    v.id.as_str(),
                    parse_iso8601_duration(&v.content_details.duration),
                )
            })
            .collect();

        let results = search_resp
            .items
            .into_iter()
            .map(|item| {
                let duration_ms = durations
                    .get(item.id.video_id.as_str())
                    .copied()
                    .unwrap_or(0);
                let thumbnail_url = item.snippet.thumbnails.default.map(|t| t.url);
                TrackMeta {
                    youtube_id: Some(item.id.video_id.clone()),
                    title: item.snippet.title,
                    artist: Some(item.snippet.channel_title),
                    duration_ms,
                    thumbnail_url,
                    source_url: format!(
                        "https://www.youtube.com/watch?v={}",
                        item.id.video_id
                    ),
                }
            })
            .collect();

        Ok(results)
    }

    pub fn extract_playlist_id(url: &str) -> Option<String> {
        let parsed = Url::parse(url).ok()?;
        parsed
            .query_pairs()
            .find(|(k, _)| k == "list")
            .map(|(_, v)| v.to_string())
    }

    pub async fn get_playlist_meta(&self, playlist_id: &str) -> Result<PlaylistMeta, MediaError> {
        let url = Url::parse_with_params(
            "https://www.googleapis.com/youtube/v3/playlists",
            &[
                ("part", "snippet,contentDetails"),
                ("id", playlist_id),
                ("key", &self.api_key),
            ],
        )
        .map_err(|e| MediaError::YouTube(format!("failed to build playlist URL: {e}")))?;

        let resp: PlaylistResponse = self
            .client
            .get(url)
            .send()
            .await
            .map_err(|e| MediaError::YouTube(sanitize_error(e)))?
            .error_for_status()
            .map_err(|e| MediaError::YouTube(sanitize_error(e)))?
            .json()
            .await
            .map_err(|e| MediaError::YouTube(sanitize_error(e)))?;

        let item = resp
            .items
            .into_iter()
            .next()
            .ok_or_else(|| MediaError::YouTube("playlist not found".to_string()))?;

        let thumbnail_url = item
            .snippet
            .thumbnails
            .as_ref()
            .and_then(|t| t.default.as_ref())
            .map(|t| t.url.clone());

        Ok(PlaylistMeta {
            playlist_id: playlist_id.to_string(),
            title: item.snippet.title,
            description: item.snippet.description.filter(|d| !d.is_empty()),
            thumbnail_url,
            channel_title: item.snippet.channel_title,
            item_count: item
                .content_details
                .as_ref()
                .map(|cd| cd.item_count)
                .unwrap_or(0),
        })
    }

    pub async fn get_playlist_items(
        &self,
        playlist_id: &str,
        max_items: u32,
    ) -> Result<Vec<PlaylistItemMeta>, MediaError> {
        let mut items: Vec<PlaylistItemMeta> = Vec::new();
        let mut page_token: Option<String> = None;
        let cap = max_items.min(300);

        loop {
            if items.len() as u32 >= cap {
                break;
            }

            let remaining = cap - items.len() as u32;
            let page_size = remaining.min(50);

            let mut params: Vec<(&str, String)> = vec![
                ("part", "snippet,contentDetails".to_string()),
                ("playlistId", playlist_id.to_string()),
                ("maxResults", page_size.to_string()),
                ("key", self.api_key.clone()),
            ];
            if let Some(ref token) = page_token {
                params.push(("pageToken", token.clone()));
            }

            let url = Url::parse_with_params(
                "https://www.googleapis.com/youtube/v3/playlistItems",
                &params,
            )
            .map_err(|e| MediaError::YouTube(format!("failed to build playlistItems URL: {e}")))?;

            let resp: PlaylistItemsResponse = self
                .client
                .get(url)
                .send()
                .await
                .map_err(|e| MediaError::YouTube(sanitize_error(e)))?
                .error_for_status()
                .map_err(|e| MediaError::YouTube(sanitize_error(e)))?
                .json()
                .await
                .map_err(|e| MediaError::YouTube(sanitize_error(e)))?;

            // Batch fetch video details for duration and status
            let video_ids: Vec<&str> = resp
                .items
                .iter()
                .map(|i| i.snippet.resource_id.video_id.as_str())
                .collect();

            let video_details = if video_ids.is_empty() {
                std::collections::HashMap::new()
            } else {
                let ids_str = video_ids.join(",");
                let vurl = Url::parse_with_params(
                    "https://www.googleapis.com/youtube/v3/videos",
                    &[
                        ("part", "contentDetails,status"),
                        ("id", &ids_str),
                        ("key", &self.api_key),
                    ],
                )
                .map_err(|e| {
                    MediaError::YouTube(format!("failed to build videos URL: {e}"))
                })?;

                let vresp: VideoStatusResponse = self
                    .client
                    .get(vurl)
                    .send()
                    .await
                    .map_err(|e| MediaError::YouTube(sanitize_error(e)))?
                    .error_for_status()
                    .map_err(|e| MediaError::YouTube(sanitize_error(e)))?
                    .json()
                    .await
                    .map_err(|e| MediaError::YouTube(sanitize_error(e)))?;

                vresp
                    .items
                    .into_iter()
                    .map(|v| (v.id.clone(), v))
                    .collect::<std::collections::HashMap<_, _>>()
            };

            for pi in resp.items {
                let video_id = pi.snippet.resource_id.video_id.clone();
                let detail = video_details.get(&video_id);
                let duration_ms = detail
                    .and_then(|d| d.content_details.as_ref())
                    .map(|cd| parse_iso8601_duration(&cd.duration))
                    .unwrap_or(0);
                let is_unavailable = detail
                    .and_then(|d| d.status.as_ref())
                    .map(|s| s.privacy_status != "public" && s.privacy_status != "unlisted")
                    .unwrap_or(true);
                let thumbnail_url = pi
                    .snippet
                    .thumbnails
                    .as_ref()
                    .and_then(|t| t.default.as_ref())
                    .map(|t| t.url.clone());

                items.push(PlaylistItemMeta {
                    video_id,
                    title: pi.snippet.title,
                    channel_title: pi.snippet.channel_title,
                    duration_ms,
                    thumbnail_url,
                    position: pi.snippet.position,
                    is_unavailable,
                });
            }

            page_token = resp.next_page_token;
            if page_token.is_none() {
                break;
            }
        }

        Ok(items)
    }

    /// Fetch metadata for a single video by ID using the YouTube Data API.
    pub async fn get_video(&self, video_id: &str) -> Result<TrackMeta, MediaError> {
        let snippet_url = Url::parse_with_params(
            "https://www.googleapis.com/youtube/v3/videos",
            &[
                ("part", "snippet,contentDetails"),
                ("id", video_id),
                ("key", &self.api_key),
            ],
        )
        .map_err(|e| MediaError::YouTube(format!("failed to build video URL: {e}")))?;

        let resp: VideoSnippetResponse = self
            .client
            .get(snippet_url)
            .send()
            .await
            .map_err(|e| MediaError::YouTube(sanitize_error(e)))?
            .error_for_status()
            .map_err(|e| MediaError::YouTube(sanitize_error(e)))?
            .json()
            .await
            .map_err(|e| MediaError::YouTube(sanitize_error(e)))?;

        let item = resp
            .items
            .into_iter()
            .next()
            .ok_or_else(|| MediaError::YouTube("video not found".to_string()))?;

        let duration_ms = parse_iso8601_duration(&item.content_details.duration);
        let thumbnail_url = item.snippet.thumbnails.default.map(|t| t.url);

        Ok(TrackMeta {
            youtube_id: Some(video_id.to_string()),
            title: item.snippet.title,
            artist: Some(item.snippet.channel_title),
            duration_ms,
            thumbnail_url,
            source_url: format!("https://www.youtube.com/watch?v={video_id}"),
        })
    }
}

pub struct PlaylistMeta {
    pub playlist_id: String,
    pub title: String,
    pub description: Option<String>,
    pub thumbnail_url: Option<String>,
    pub channel_title: Option<String>,
    pub item_count: u32,
}

pub struct PlaylistItemMeta {
    pub video_id: String,
    pub title: String,
    pub channel_title: Option<String>,
    pub duration_ms: u64,
    pub thumbnail_url: Option<String>,
    pub position: u32,
    pub is_unavailable: bool,
}

/// Extract a YouTube video ID from a URL, if present.
pub fn extract_video_id(url: &str) -> Option<String> {
    let parsed = Url::parse(url).ok()?;
    match parsed.host_str()? {
        "www.youtube.com" | "youtube.com" | "m.youtube.com" | "music.youtube.com" => {
            parsed
                .query_pairs()
                .find(|(k, _)| k == "v")
                .map(|(_, v)| v.to_string())
        }
        "youtu.be" => {
            let path = parsed.path().strip_prefix('/')?;
            if path.is_empty() {
                None
            } else {
                Some(path.split('/').next()?.to_string())
            }
        }
        _ => None,
    }
}

fn sanitize_error(e: reqwest::Error) -> String {
    if e.is_timeout() {
        "request timed out".to_string()
    } else if e.is_connect() {
        "connection failed".to_string()
    } else if e.is_status() {
        format!(
            "HTTP error {}",
            e.status().map_or("unknown".to_string(), |s| s.as_str().to_string())
        )
    } else if e.is_decode() {
        "failed to decode response".to_string()
    } else {
        "request failed".to_string()
    }
}

fn parse_iso8601_duration(s: &str) -> u64 {
    // Format: PT[nH][nM][nS]
    let s = s.strip_prefix("PT").unwrap_or(s);
    let mut hours: u64 = 0;
    let mut minutes: u64 = 0;
    let mut seconds: u64 = 0;
    let mut current = String::new();

    for ch in s.chars() {
        match ch {
            '0'..='9' => current.push(ch),
            'H' => {
                hours = current.parse().unwrap_or(0);
                current.clear();
            }
            'M' => {
                minutes = current.parse().unwrap_or(0);
                current.clear();
            }
            'S' => {
                seconds = current.parse().unwrap_or(0);
                current.clear();
            }
            _ => {}
        }
    }

    let total_secs = hours
        .saturating_mul(3600)
        .saturating_add(minutes.saturating_mul(60))
        .saturating_add(seconds);
    total_secs.saturating_mul(1000)
}

// Response structs for YouTube API

#[derive(Deserialize)]
struct SearchResponse {
    items: Vec<SearchItem>,
}

#[derive(Deserialize)]
struct SearchItem {
    id: SearchItemId,
    snippet: Snippet,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SearchItemId {
    video_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Snippet {
    title: String,
    channel_title: String,
    thumbnails: Thumbnails,
}

#[derive(Deserialize)]
struct Thumbnails {
    default: Option<ThumbnailInfo>,
}

#[derive(Deserialize)]
struct ThumbnailInfo {
    url: String,
}

#[derive(Deserialize)]
struct VideoResponse {
    items: Vec<VideoItem>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct VideoItem {
    id: String,
    content_details: ContentDetails,
}

#[derive(Deserialize)]
struct ContentDetails {
    duration: String,
}

#[derive(Deserialize)]
struct VideoSnippetResponse {
    items: Vec<VideoSnippetItem>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct VideoSnippetItem {
    snippet: Snippet,
    content_details: ContentDetails,
}

// Playlist API response structs

#[derive(Deserialize)]
struct PlaylistResponse {
    items: Vec<PlaylistItem>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlaylistItem {
    snippet: PlaylistSnippet,
    content_details: Option<PlaylistContentDetails>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlaylistSnippet {
    title: String,
    description: Option<String>,
    channel_title: Option<String>,
    thumbnails: Option<Thumbnails>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlaylistContentDetails {
    item_count: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlaylistItemsResponse {
    items: Vec<PlaylistItemEntry>,
    next_page_token: Option<String>,
}

#[derive(Deserialize)]
struct PlaylistItemEntry {
    snippet: PlaylistItemSnippet,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlaylistItemSnippet {
    title: String,
    channel_title: Option<String>,
    thumbnails: Option<Thumbnails>,
    position: u32,
    resource_id: ResourceId,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResourceId {
    video_id: String,
}

#[derive(Deserialize)]
struct VideoStatusResponse {
    items: Vec<VideoStatusItem>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct VideoStatusItem {
    id: String,
    content_details: Option<ContentDetails>,
    status: Option<VideoStatus>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct VideoStatus {
    privacy_status: String,
}
