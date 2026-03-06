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
