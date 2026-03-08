import { useState, useEffect, useCallback } from "react";
import { Upload, Plus, Loader2 } from "lucide-react";
import clsx from "clsx";
import { api } from "../../../lib/api";
import { useToast } from "../../../hooks/useToast";
import type { TrackInfo } from "../../../lib/types";

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

function UploadRow({
  track,
  onUpdate,
}: {
  track: TrackInfo;
  onUpdate: () => void;
}) {
  const { showToast } = useToast();
  const [editing, setEditing] = useState<"title" | "artist" | null>(null);
  const [editValue, setEditValue] = useState("");
  const [adding, setAdding] = useState(false);

  const handleEdit = (field: "title" | "artist") => {
    setEditing(field);
    setEditValue(field === "title" ? track.title : track.artist || "");
  };

  const handleSave = async () => {
    if (!editing) return;
    try {
      await api.updateTrack(track.id, { [editing]: editValue.trim() || undefined });
      onUpdate();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Update failed", "error");
    }
    setEditing(null);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") handleSave();
    if (e.key === "Escape") setEditing(null);
  };

  const handleAddToQueue = async () => {
    setAdding(true);
    try {
      await api.addTrackToQueue(track.id);
      showToast("Added to queue", "success");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed", "error");
    } finally {
      setAdding(false);
    }
  };

  return (
    <div className="flex items-center gap-3 px-3 py-2.5 hover:bg-[var(--color-bg-hover)] rounded-md group transition-colors">
      {/* Icon */}
      <div className="w-10 h-10 rounded bg-[var(--color-bg-tertiary)] flex items-center justify-center flex-shrink-0">
        <Upload size={16} className="text-[var(--color-text-tertiary)]" />
      </div>

      {/* Info */}
      <div className="flex-1 min-w-0">
        {editing === "title" ? (
          <input
            autoFocus
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onBlur={handleSave}
            onKeyDown={handleKeyDown}
            className="w-full text-sm bg-transparent border-b border-[var(--color-accent)] text-[var(--color-text)] outline-none"
          />
        ) : (
          <p
            className="text-sm text-[var(--color-text)] truncate cursor-pointer hover:underline"
            onClick={() => handleEdit("title")}
          >
            {track.title}
          </p>
        )}

        <div className="flex items-center gap-2 text-xs text-[var(--color-text-tertiary)]">
          {editing === "artist" ? (
            <input
              autoFocus
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onBlur={handleSave}
              onKeyDown={handleKeyDown}
              className="bg-transparent border-b border-[var(--color-accent)] text-[var(--color-text-tertiary)] outline-none"
            />
          ) : (
            <span
              className="truncate cursor-pointer hover:underline"
              onClick={() => handleEdit("artist")}
            >
              {track.artist || "Unknown artist"}
            </span>
          )}
          {track.duration_ms > 0 && (
            <>
              <span>·</span>
              <span>{formatDuration(track.duration_ms)}</span>
            </>
          )}
        </div>
      </div>

      {/* Add button */}
      <button
        onClick={handleAddToQueue}
        disabled={adding}
        className={clsx(
          "p-2 rounded-md transition-colors touch-manipulation min-w-[44px] min-h-[44px] flex items-center justify-center",
          "text-[var(--color-text-tertiary)] hover:text-[var(--color-accent)] hover:bg-[var(--color-bg-tertiary)]",
          "opacity-0 group-hover:opacity-100 focus:opacity-100",
          adding && "opacity-100"
        )}
        aria-label="Add to queue"
      >
        {adding ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} />}
      </button>
    </div>
  );
}

export function UploadsPage() {
  const [tracks, setTracks] = useState<TrackInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const perPage = 20;

  const fetchUploads = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.getUploads(page, perPage);
      setTracks(data.items);
      setTotal(data.total);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [page]);

  useEffect(() => {
    fetchUploads();
  }, [fetchUploads]);

  const totalPages = Math.ceil(total / perPage);

  return (
    <div className="flex flex-col h-full bg-[var(--color-bg-secondary)] pb-32 md:pb-0">
      <div className="px-4 pt-4 pb-3 border-b border-[var(--color-border)]">
        <h1 className="text-lg font-semibold text-[var(--color-text)]">Uploads</h1>
        {total > 0 && (
          <p className="text-xs text-[var(--color-text-tertiary)] mt-0.5">
            {total} uploaded tracks
          </p>
        )}
      </div>

      <div className="flex-1 overflow-y-auto py-2 px-1">
        {loading && tracks.length === 0 && (
          <div className="flex items-center justify-center py-10">
            <Loader2 size={24} className="text-[var(--color-text-tertiary)] animate-spin" />
          </div>
        )}

        {!loading && tracks.length === 0 && (
          <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
            <Upload size={28} className="text-[var(--color-text-tertiary)]" />
            <p className="text-sm text-[var(--color-text-secondary)]">
              No uploaded files yet
            </p>
            <p className="text-xs text-[var(--color-text-tertiary)]">
              Drag and drop audio files to upload
            </p>
          </div>
        )}

        {tracks.map((track) => (
          <UploadRow key={track.id} track={track} onUpdate={fetchUploads} />
        ))}

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-center gap-2 py-4">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page === 1}
              className="px-3 py-1.5 text-xs rounded-md bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)] disabled:opacity-50"
            >
              Previous
            </button>
            <span className="text-xs text-[var(--color-text-tertiary)]">
              {page} / {totalPages}
            </span>
            <button
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page === totalPages}
              className="px-3 py-1.5 text-xs rounded-md bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)] disabled:opacity-50"
            >
              Next
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
