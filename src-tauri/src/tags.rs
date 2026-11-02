//! Writing title / artist / album / lyrics / front cover into the audio file itself.

use crate::covers;
use lofty::config::WriteOptions;
use lofty::file::{AudioFile, TaggedFileExt};
use lofty::picture::{MimeType, Picture, PictureType};
use lofty::tag::{Accessor, ItemKey, Tag, TagType};
use serde::Deserialize;

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct TagWrite {
    pub path: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub cover_path: Option<String>,
    pub lyrics: Option<String>,
    /// remove embedded pictures when `cover_path` is empty
    pub clear_cover: bool,
}

fn set_or_remove(tag: &mut Tag, value: &str, set: fn(&mut Tag, String), remove: fn(&mut Tag)) {
    if value.trim().is_empty() {
        remove(tag)
    } else {
        set(tag, value.to_string())
    }
}

pub fn write(t: &TagWrite) -> Result<(), String> {
    let mut file = lofty::read_from_path(&t.path).map_err(|e| e.to_string())?;
    if file.primary_tag().is_none() {
        let kind = file.primary_tag_type();
        file.insert_tag(Tag::new(kind));
    }
    let tag = file.primary_tag_mut().ok_or("no tag")?;
    set_or_remove(tag, &t.title, |t, v| t.set_title(v), |t| t.remove_title());
    tag.remove_key(ItemKey::TrackArtists);
    set_or_remove(tag, &t.artist, |t, v| t.set_artist(v), |t| t.remove_artist());
    set_or_remove(tag, &t.album, |t, v| t.set_album(v), |t| t.remove_album());
    if let Some(lyrics) = &t.lyrics {
        // ID3v2 keeps unsynchronised lyrics in USLT; LRC text is stored there as it is
        let key = if tag.tag_type() == TagType::Id3v2 {
            ItemKey::UnsyncLyrics
        } else {
            ItemKey::Lyrics
        };
        tag.remove_key(ItemKey::Lyrics);
        tag.remove_key(ItemKey::UnsyncLyrics);
        if !lyrics.trim().is_empty() {
            tag.insert_text(key, lyrics.clone());
        }
    }
    let new_cover = t.cover_path.as_deref().filter(|p| !p.is_empty());
    if new_cover.is_some() || t.clear_cover {
        while tag.picture_count() > 0 {
            tag.remove_picture(0);
        }
    }
    if let Some(cover) = new_cover {
        let jpeg = covers::as_jpeg(cover, 1000);
        tag.push_picture(
            Picture::unchecked(jpeg)
                .pic_type(PictureType::CoverFront)
                .mime_type(MimeType::Jpeg)
                .description("Cover")
                .build(),
        );
    }
    file.save_to_path(&t.path, WriteOptions::default()).map_err(|e| e.to_string())
}
