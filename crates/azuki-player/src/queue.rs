use std::collections::VecDeque;

use crate::events::{LoopMode, QueueEntry, TrackInfo};

#[derive(Debug, Default)]
pub struct Queue {
    items: VecDeque<QueueEntry>,
    loop_mode: LoopMode,
    history: Vec<QueueEntry>,
}

impl Queue {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn enqueue(&mut self, track: TrackInfo, added_by: String) {
        self.items.push_back(QueueEntry { track, added_by });
    }

    pub fn advance(&mut self) -> Option<QueueEntry> {
        match self.loop_mode {
            LoopMode::Off => {
                let entry = self.items.pop_front();
                if let Some(ref e) = entry {
                    self.history.push(e.clone());
                }
                entry
            }
            LoopMode::One => {
                // Return a clone of the front item without removing it
                self.items.front().cloned()
            }
            LoopMode::All => {
                let entry = self.items.pop_front();
                if let Some(ref e) = entry {
                    self.items.push_back(e.clone());
                }
                // Return the item that was at front (now at back)
                entry
            }
        }
    }

    pub fn current(&self) -> Option<&QueueEntry> {
        self.items.front()
    }

    pub fn remove(&mut self, position: usize) -> Option<QueueEntry> {
        self.items.remove(position)
    }

    pub fn clear(&mut self) {
        self.items.clear();
    }

    pub fn items(&self) -> Vec<QueueEntry> {
        self.items.iter().cloned().collect()
    }

    pub fn len(&self) -> usize {
        self.items.len()
    }

    pub fn is_empty(&self) -> bool {
        self.items.is_empty()
    }

    pub fn loop_mode(&self) -> LoopMode {
        self.loop_mode
    }

    pub fn set_loop_mode(&mut self, mode: LoopMode) {
        self.loop_mode = mode;
    }

    pub fn move_item(&mut self, from: usize, to: usize) -> bool {
        if from >= self.items.len() || to >= self.items.len() {
            return false;
        }
        if let Some(item) = self.items.remove(from) {
            self.items.insert(to, item);
            true
        } else {
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_track(id: &str) -> TrackInfo {
        TrackInfo {
            id: id.to_string(),
            title: format!("Track {id}"),
            artist: None,
            duration_ms: 180_000,
            thumbnail_url: None,
            source_url: format!("https://example.com/{id}"),
            source_type: "youtube".to_string(),
            file_path: None,
            youtube_id: Some(id.to_string()),
            volume: 5,
        }
    }

    #[test]
    fn test_enqueue_and_advance() {
        let mut q = Queue::new();
        q.enqueue(make_track("1"), "user1".into());
        q.enqueue(make_track("2"), "user1".into());
        q.enqueue(make_track("3"), "user1".into());
        assert_eq!(q.len(), 3);

        let e = q.advance().unwrap();
        assert_eq!(e.track.id, "1");
        let e = q.advance().unwrap();
        assert_eq!(e.track.id, "2");
        assert_eq!(q.len(), 1);

        let e = q.advance().unwrap();
        assert_eq!(e.track.id, "3");
        assert!(q.advance().is_none());
    }

    #[test]
    fn test_loop_one() {
        let mut q = Queue::new();
        q.set_loop_mode(LoopMode::One);
        q.enqueue(make_track("1"), "user1".into());
        q.enqueue(make_track("2"), "user1".into());

        let e1 = q.advance().unwrap();
        assert_eq!(e1.track.id, "1");
        let e2 = q.advance().unwrap();
        assert_eq!(e2.track.id, "1");
        assert_eq!(q.len(), 2); // Nothing removed
    }

    #[test]
    fn test_loop_all() {
        let mut q = Queue::new();
        q.set_loop_mode(LoopMode::All);
        q.enqueue(make_track("1"), "user1".into());
        q.enqueue(make_track("2"), "user1".into());

        let e = q.advance().unwrap();
        assert_eq!(e.track.id, "1");
        let e = q.advance().unwrap();
        assert_eq!(e.track.id, "2");
        let e = q.advance().unwrap();
        assert_eq!(e.track.id, "1"); // Wraps around
        assert_eq!(q.len(), 2);
    }

    #[test]
    fn test_remove() {
        let mut q = Queue::new();
        q.enqueue(make_track("1"), "user1".into());
        q.enqueue(make_track("2"), "user1".into());
        q.enqueue(make_track("3"), "user1".into());

        let removed = q.remove(1).unwrap();
        assert_eq!(removed.track.id, "2");
        assert_eq!(q.len(), 2);
    }
}
