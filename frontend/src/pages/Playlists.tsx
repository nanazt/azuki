import { useEffect, useState } from "react";
import { api } from "../lib/api";
import type { Playlist, PlaylistTrack } from "../lib/types";
import { Skeleton } from "../components/ui/Skeleton";
import { Modal } from "../components/ui/Modal";
import { Button } from "../components/ui/Button";
import { ListMusic, Plus, Trash2, ChevronLeft, Loader2, Download, Play, ExternalLink } from "lucide-react";
import { TrackThumbnail } from "../components/ui/TrackThumbnail";
import { formatTime } from "../lib/utils";
import { useToast } from "../components/ui/Toast";

export function Playlists() {
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);

  // Import state
  const [importOpen, setImportOpen] = useState(false);
  const [importUrl, setImportUrl] = useState("");
  const [importing, setImporting] = useState(false);

  // Play state
  const [playingId, setPlayingId] = useState<number | null>(null);

  // Detail view
  const [selected, setSelected] = useState<Playlist | null>(null);
  const [tracks, setTracks] = useState<PlaylistTrack[]>([]);
  const [tracksLoading, setTracksLoading] = useState(false);

  const loadPlaylists = () => {
    setLoading(true);
    api
      .getPlaylists()
      .then((res) => setPlaylists(res.playlists))
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    loadPlaylists();
  }, []);

  useEffect(() => {
    const handler = () => {
      api.getPlaylists()
        .then((res) => setPlaylists(res.playlists))
        .catch(() => {});
      if (selected) {
        api.getPlaylistTracks(selected.id)
          .then((res) => setTracks(res.tracks))
          .catch(() => {});
      }
    };
    window.addEventListener("playlist-updated", handler);
    return () => window.removeEventListener("playlist-updated", handler);
  }, [selected]);

  const openPlaylist = (pl: Playlist) => {
    setSelected(pl);
    setTracksLoading(true);
    api
      .getPlaylistTracks(pl.id)
      .then((res) => setTracks(res.tracks))
      .catch(() => setTracks([]))
      .finally(() => setTracksLoading(false));
  };

  const handleCreate = async () => {
    if (!newName.trim()) return;
    setCreating(true);
    try {
      await api.createPlaylist(newName.trim());
      setNewName("");
      setCreateOpen(false);
      loadPlaylists();
    } catch {
      // ignore
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (id: number) => {
    await api.deletePlaylist(id).catch(() => {});
    if (selected?.id === id) setSelected(null);
    loadPlaylists();
  };

  const handleRemoveTrack = async (position: number) => {
    if (!selected) return;
    await api.removePlaylistTrack(selected.id, position).catch(() => {});
    setTracks((prev) => prev.filter((t) => t.position !== position));
  };

  const [addingIds, setAddingIds] = useState<Set<string>>(new Set());
  const { showToast } = useToast();

  const handleImport = async () => {
    if (!importUrl.trim()) return;
    setImporting(true);
    try {
      await api.importPlaylist(importUrl.trim());
      setImportUrl("");
      setImportOpen(false);
      loadPlaylists();
      showToast("Playlist imported successfully", "success");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to import playlist", "error");
    } finally {
      setImporting(false);
    }
  };

  const handlePlay = async (pl: Playlist) => {
    if (playingId) return;
    setPlayingId(pl.id);
    try {
      await api.playPlaylist(pl.id);
      showToast(`Playing: ${pl.name}`, "success");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to play playlist", "error");
    } finally {
      setPlayingId(null);
    }
  };

  const handleAddTrack = async (track: PlaylistTrack) => {
    if (addingIds.has(track.track.id)) return;
    setAddingIds(prev => new Set(prev).add(track.track.id));
    try {
      await api.addToQueue(track.track.source_url);
    } catch {
      showToast("Failed to add to queue", "error");
    } finally {
      setAddingIds(prev => {
        const next = new Set(prev);
        next.delete(track.track.id);
        return next;
      });
    }
  };

  if (selected) {
    return (
      <div className="p-4 md:p-6 max-w-3xl mx-auto flex flex-col gap-4">
        <div className="flex items-center gap-3">
          <button
            onClick={() => setSelected(null)}
            className="p-2 rounded-lg hover:bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)] transition-colors"
          >
            <ChevronLeft size={20} />
          </button>
          <div className="flex-1 min-w-0">
            <h1 className="text-xl font-bold text-[var(--color-text)] truncate">{selected.name}</h1>
            <p className="text-sm text-[var(--color-text-tertiary)]">
              {tracks.length} track{tracks.length !== 1 ? "s" : ""}
            </p>
          </div>
          <Button
            variant="primary"
            size="sm"
            onClick={() => handlePlay(selected)}
            disabled={playingId === selected.id}
          >
            {playingId === selected.id ? <Loader2 size={16} className="animate-spin" /> : <Play size={16} />}
            Play All
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => handleDelete(selected.id)}
            className="text-[var(--color-danger)] hover:text-[var(--color-danger)]"
          >
            <Trash2 size={16} />
          </Button>
        </div>

        {tracksLoading ? (
          <div className="flex flex-col gap-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3">
                <Skeleton className="w-10 h-10 rounded-md" />
                <div className="flex-1 flex flex-col gap-1.5">
                  <Skeleton className="h-4 w-2/3 rounded" />
                  <Skeleton className="h-3 w-1/3 rounded" />
                </div>
              </div>
            ))}
          </div>
        ) : tracks.length === 0 ? (
          <p className="text-sm text-[var(--color-text-tertiary)] py-8 text-center">
            This playlist is empty.
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {tracks.map((entry) => (
              <li key={entry.position} className="flex items-center gap-3 group px-3 py-2 rounded-lg hover:bg-[var(--color-bg-secondary)] transition-colors">
                  <TrackThumbnail track={entry.track} sizeClass="w-10 h-10" iconSize={16} className="rounded-md" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-[var(--color-text)] truncate">
                      {entry.track.title}
                    </p>
                    {entry.track.artist && (
                      <p className="text-xs text-[var(--color-text-tertiary)] truncate">
                        {entry.track.artist}
                      </p>
                    )}
                  </div>
                  <span className="text-xs text-[var(--color-text-tertiary)] flex-shrink-0">
                    {formatTime(entry.track.duration_ms)}
                  </span>
                  <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 [@media(hover:none)]:opacity-100 transition-opacity flex-shrink-0">
                    <button
                      onClick={() => handleAddTrack(entry)}
                      disabled={addingIds.has(entry.track.id)}
                      className="p-1.5 rounded-lg text-[var(--color-text-tertiary)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-hover)] transition-colors disabled:opacity-50"
                      aria-label="Add to queue"
                    >
                      {addingIds.has(entry.track.id) ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />}
                    </button>
                    <button
                      onClick={() => handleRemoveTrack(entry.position)}
                      className="p-1.5 rounded-lg text-[var(--color-text-tertiary)] hover:text-[var(--color-danger)] hover:bg-[var(--color-danger)]/10 transition-colors"
                      aria-label="Remove from playlist"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }

  return (
    <div className="p-4 md:p-6 max-w-3xl mx-auto flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-[var(--color-text)]">Playlists</h1>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => setImportOpen(true)}>
            <Download size={16} />
            Import
          </Button>
          <Button variant="primary" size="sm" onClick={() => setCreateOpen(true)}>
            <Plus size={16} />
            New Playlist
          </Button>
        </div>
      </div>

      {loading ? (
        <div className="flex flex-col gap-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-16 rounded-xl" />
          ))}
        </div>
      ) : playlists.length === 0 ? (
        <div className="flex flex-col items-center gap-3 py-16 text-center">
          <ListMusic size={40} className="text-[var(--color-text-tertiary)]" />
          <p className="text-[var(--color-text-secondary)]">No playlists yet.</p>
          <p className="text-sm text-[var(--color-text-tertiary)]">Create one to get started.</p>
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {playlists.map((pl) => (
            <li key={pl.id}>
              <div className="flex items-center gap-3 px-4 py-3 rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)] group hover:border-[var(--color-accent)]/40 transition-colors">
                <button
                  onClick={() => openPlaylist(pl)}
                  className="flex items-center gap-3 flex-1 min-w-0 text-left"
                >
                  {pl.source_kind === "youtube" ? (
                    <div className="w-10 h-10 rounded-lg bg-red-500/20 flex items-center justify-center flex-shrink-0">
                      <ExternalLink size={18} className="text-red-400" />
                    </div>
                  ) : pl.source_kind === "soundcloud" ? (
                    <div className="w-10 h-10 rounded-lg bg-orange-500/20 flex items-center justify-center flex-shrink-0">
                      <ExternalLink size={18} className="text-orange-400" />
                    </div>
                  ) : (
                    <div className="w-10 h-10 rounded-lg bg-[var(--color-accent)]/20 flex items-center justify-center flex-shrink-0">
                      <ListMusic size={18} className="text-[var(--color-text-secondary)]" />
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-[var(--color-text)] truncate">{pl.name}</p>
                    <p className="text-xs text-[var(--color-text-tertiary)]">
                      {pl.track_count ?? 0} track{(pl.track_count ?? 0) !== 1 ? "s" : ""}
                    </p>
                  </div>
                </button>
                <button
                  onClick={() => handlePlay(pl)}
                  disabled={playingId === pl.id}
                  className="p-2 rounded-lg text-[var(--color-text-tertiary)] hover:text-[var(--color-accent)] opacity-0 group-hover:opacity-100 [@media(hover:none)]:opacity-100 transition-all flex-shrink-0"
                  aria-label="Play playlist"
                >
                  {playingId === pl.id ? <Loader2 size={16} className="animate-spin" /> : <Play size={16} />}
                </button>
                <button
                  onClick={() => handleDelete(pl.id)}
                  className="p-2 rounded-lg text-[var(--color-text-tertiary)] hover:text-[var(--color-danger)] opacity-0 group-hover:opacity-100 transition-all flex-shrink-0"
                  aria-label="Delete playlist"
                >
                  <Trash2 size={16} />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <Modal open={createOpen} onClose={() => { setCreateOpen(false); setNewName(""); }} title="New Playlist">
        <div className="flex flex-col gap-4">
          <input
            type="text"
            placeholder="Playlist name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleCreate()}
            className="w-full px-3 py-2 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] text-[var(--color-text)] placeholder:text-[var(--color-text-tertiary)] focus:outline-none focus:border-[var(--color-accent)] text-sm"
            autoFocus
          />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => { setCreateOpen(false); setNewName(""); }}>
              Cancel
            </Button>
            <Button variant="primary" onClick={handleCreate} disabled={!newName.trim() || creating}>
              {creating ? "Creating..." : "Create"}
            </Button>
          </div>
        </div>
      </Modal>

      <Modal open={importOpen} onClose={() => { if (!importing) { setImportOpen(false); setImportUrl(""); } }} title="Import Playlist">
        <div className="flex flex-col gap-4">
          <p className="text-sm text-[var(--color-text-secondary)]">
            Paste a YouTube playlist URL to import.
          </p>
          <input
            type="url"
            placeholder="https://youtube.com/playlist?list=..."
            value={importUrl}
            onChange={(e) => setImportUrl(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !importing && handleImport()}
            className="w-full px-3 py-2 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] text-[var(--color-text)] placeholder:text-[var(--color-text-tertiary)] focus:outline-none focus:border-[var(--color-accent)] text-[16px]"
            disabled={importing}
            autoFocus
          />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => { setImportOpen(false); setImportUrl(""); }} disabled={importing}>
              Cancel
            </Button>
            <Button variant="primary" onClick={handleImport} disabled={!importUrl.trim() || importing}>
              {importing ? (
                <><Loader2 size={14} className="animate-spin" /> Importing...</>
              ) : (
                "Import"
              )}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
