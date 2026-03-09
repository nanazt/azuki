use serenity::all::{
    ButtonStyle, Colour, CreateActionRow, CreateButton, CreateEmbed, CreateEmbedAuthor,
    CreateEmbedFooter, CreateSelectMenu, CreateSelectMenuKind, CreateSelectMenuOption, Timestamp,
};

use azuki_player::TrackInfo;

use crate::commands::format_duration;

pub fn build_track_embed(
    track: &TrackInfo,
    volume: u8,
    display_name: &str,
    thumbnail_url: Option<&str>,
) -> CreateEmbed {
    let mut embed = CreateEmbed::new()
        .title(&track.title)
        .url(&track.source_url)
        .color(embed_color(&track.source_type))
        .field("⏱️ 재생 시간", format_duration(track.duration_ms), true)
        .field("🔊 소리 크기", format!("{volume} / 100"), true)
        .footer(CreateEmbedFooter::new(format!(
            "{} • {}",
            source_label(&track.source_type),
            display_name,
        )))
        .timestamp(Timestamp::now());

    if let Some(ref artist) = track.artist {
        embed = embed.author(CreateEmbedAuthor::new(artist));
    }

    if let Some(thumb) = thumbnail_url {
        embed = embed.thumbnail(thumb);
    }

    embed
}

pub fn build_play_button(track_id: &str) -> CreateActionRow {
    CreateActionRow::Buttons(vec![
        CreateButton::new(format!("play:{track_id}"))
            .label("재생하기")
            .style(ButtonStyle::Success),
    ])
}

pub fn build_search_select(results: &[(String, String, String, String)]) -> CreateActionRow {
    // results: Vec of (youtube_id, title, artist, duration_str)
    let options: Vec<CreateSelectMenuOption> = results
        .iter()
        .filter(|(id, _, _, _)| !id.is_empty())
        .take(5)
        .map(|(id, title, artist, dur)| {
            CreateSelectMenuOption::new(truncate_str(title, 100), id)
                .description(truncate_str(&format!("{artist} · {dur}"), 100))
        })
        .collect();

    CreateActionRow::SelectMenu(
        CreateSelectMenu::new("ss:search", CreateSelectMenuKind::String { options })
            .placeholder("Select a track to play"),
    )
}

fn truncate_str(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let truncated: String = s.chars().take(max - 3).collect();
        format!("{truncated}...")
    }
}

fn embed_color(source_type: &str) -> Colour {
    match source_type {
        "youtube" => Colour::from(0xFF0000),
        "soundcloud" => Colour::from(0xF26F23),
        _ => Colour::from(0x808080),
    }
}

fn source_label(source_type: &str) -> &'static str {
    match source_type {
        "youtube" => "YouTube",
        "soundcloud" => "SoundCloud",
        _ => "Unknown",
    }
}
