use serenity::all::{
    ButtonStyle, Colour, CreateActionRow, CreateButton, CreateEmbed, CreateEmbedAuthor,
    CreateEmbedFooter, Timestamp,
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
            .style(ButtonStyle::Secondary),
    ])
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
