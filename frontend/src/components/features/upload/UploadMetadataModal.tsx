import { useState, useEffect, useRef, useCallback } from "react";
import { Loader2, X, Upload } from "lucide-react";
import clsx from "clsx";
import { api } from "../../../lib/api";
import { useToast } from "../../../hooks/useToast";
import type { DroppedFileUpload } from "../../../hooks/useFileDrop";
import type { UploadResponse } from "../../../lib/types";

interface Props {
  file: DroppedFileUpload;
  onClose: () => void;
}

function uploadViaFilePicker(file: File): Promise<UploadResponse> {
  const formData = new FormData();
  formData.append("file", file);
  return fetch("/api/upload", {
    method: "POST",
    body: formData,
    credentials: "include",
    headers: { "X-Requested-With": "XMLHttpRequest" },
  }).then(async (res) => {
    if (res.status === 401) {
      window.location.href = "/auth/login";
      throw new Error("unauthorized");
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(body.error || res.statusText);
    }
    return res.json();
  });
}

export function UploadMetadataModal({ file, onClose }: Props) {
  const { showToast } = useToast();
  const [title, setTitle] = useState("");
  const [artist, setArtist] = useState("");
  const [uploading, setUploading] = useState(true);
  const [uploadFailed, setUploadFailed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);
  const retryInputRef = useRef<HTMLInputElement>(null);
  const uploadResultRef = useRef<UploadResponse | null>(null);

  const handleUploadSuccess = useCallback(
    (result: UploadResponse) => {
      uploadResultRef.current = result;
      setUploading(false);
      setUploadFailed(false);

      if (result.title) setTitle(result.title);
      if (result.artist) setArtist(result.artist);

      if (result.duplicate) {
        showToast("File already uploaded", "info");
        api.addTrackToQueue(result.track_id).then(
          () => showToast("Added to queue", "success"),
          (err) => showToast(err instanceof Error ? err.message : "Failed", "error"),
        );
        onClose();
      }
    },
    [onClose, showToast],
  );

  // Wait for the upload promise (started in useFileDrop drop handler).
  useEffect(() => {
    const fallbackTitle = file.name.replace(/\.[^.]+$/, "") || file.name;
    setTitle(fallbackTitle);

    let cancelled = false;

    file.uploadPromise.then(
      (result) => {
        if (!cancelled) handleUploadSuccess(result);
      },
      (err) => {
        if (cancelled) return;
        console.error("Upload failed:", err);
        // Don't close — show retry UI so user can pick the file manually.
        setUploading(false);
        setUploadFailed(true);
      },
    );

    return () => { cancelled = true; };
  }, [file, handleUploadSuccess]);

  // Focus title input
  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  // Retry via native file picker — File from <input> is always valid.
  const handleRetryClick = useCallback(() => {
    retryInputRef.current?.click();
  }, []);

  const handleRetryFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const selected = e.target.files?.[0];
      if (!selected) return;
      e.target.value = "";

      setUploading(true);
      setUploadFailed(false);

      uploadViaFilePicker(selected).then(
        (result) => handleUploadSuccess(result),
        (err) => {
          console.error("Retry upload failed:", err);
          setUploading(false);
          setUploadFailed(true);
          showToast(
            err instanceof Error ? err.message : "Upload failed",
            "error",
          );
        },
      );
    },
    [handleUploadSuccess, showToast],
  );

  const handleSubmit = async () => {
    if (submitting) return;
    setSubmitting(true);

    try {
      const result = uploadResultRef.current;
      if (!result) {
        showToast("Upload not complete", "error");
        setSubmitting(false);
        return;
      }

      if (result.duplicate) {
        onClose();
        return;
      }

      // Update metadata if changed
      const updates: { title?: string; artist?: string } = {};
      if (title.trim() && title !== result.title) updates.title = title.trim();
      if (artist.trim() !== (result.artist || "")) updates.artist = artist.trim() || undefined;

      if (Object.keys(updates).length > 0) {
        await api.updateTrack(result.track_id, updates);
      }

      // Add to queue
      await api.addTrackToQueue(result.track_id);
      showToast("Added to queue", "success");
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : "Failed to add to queue",
        "error"
      );
    } finally {
      setSubmitting(false);
      onClose();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !submitting) {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="w-full max-w-md bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-xl shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--color-border)]">
          <h2 className="text-base font-semibold text-[var(--color-text)]">
            Upload to Queue
          </h2>
          <button
            onClick={onClose}
            className="p-1.5 text-[var(--color-text-tertiary)] hover:text-[var(--color-text)] transition-colors touch-manipulation"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        {/* Form */}
        <div className="px-5 py-4 space-y-4" onKeyDown={handleKeyDown}>
          <div>
            <label className="block text-xs font-medium text-[var(--color-text-secondary)] mb-1.5">
              Title
            </label>
            <input
              ref={titleRef}
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className={clsx(
                "w-full px-3 py-2.5 md:py-2 rounded-lg text-base md:text-sm",
                "bg-[var(--color-bg-tertiary)] border border-[var(--color-border)]",
                "text-[var(--color-text)] placeholder:text-[var(--color-text-tertiary)]",
                "outline-none focus:border-[var(--color-accent)] transition-colors"
              )}
              placeholder="Track title"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-[var(--color-text-secondary)] mb-1.5">
              Artist
            </label>
            <input
              type="text"
              value={artist}
              onChange={(e) => setArtist(e.target.value)}
              className={clsx(
                "w-full px-3 py-2.5 md:py-2 rounded-lg text-base md:text-sm",
                "bg-[var(--color-bg-tertiary)] border border-[var(--color-border)]",
                "text-[var(--color-text)] placeholder:text-[var(--color-text-tertiary)]",
                "outline-none focus:border-[var(--color-accent)] transition-colors"
              )}
              placeholder="Artist name"
            />
          </div>

          <p className="text-xs text-[var(--color-text-tertiary)]">
            {file.name} ({(file.size / 1024 / 1024).toFixed(1)} MB)
          </p>

          {/* Upload failed — retry with file picker */}
          {uploadFailed && (
            <div className="flex items-center gap-3 p-3 rounded-lg bg-[var(--color-bg-tertiary)] border border-[var(--color-border)]">
              <p className="text-xs text-[var(--color-text-secondary)] flex-1">
                Drag-and-drop upload failed. Select the file manually to retry.
              </p>
              <button
                onClick={handleRetryClick}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-[var(--color-accent)] text-[#1a1a1a] hover:opacity-90 transition-colors touch-manipulation shrink-0"
              >
                <Upload size={12} />
                Select File
              </button>
              <input
                ref={retryInputRef}
                type="file"
                accept=".mp3,.ogg,.wav,.flac,.aac,.opus,.webm,.mp4,.m4a"
                className="hidden"
                onChange={handleRetryFileChange}
              />
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-[var(--color-border)]">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-[var(--color-text-secondary)] hover:text-[var(--color-text)] transition-colors touch-manipulation min-h-[44px] sm:min-h-0"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={submitting || uploading || uploadFailed || !title.trim()}
            className={clsx(
              "px-4 py-2 text-sm font-medium rounded-lg transition-colors touch-manipulation min-h-[44px] sm:min-h-0",
              "bg-[var(--color-accent)] text-[#1a1a1a]",
              (submitting || uploading || uploadFailed || !title.trim())
                ? "opacity-50 cursor-not-allowed"
                : "hover:opacity-90"
            )}
          >
            {uploading || submitting ? (
              <span className="flex items-center gap-2">
                <Loader2 size={14} className="animate-spin" />
                {uploading ? "Uploading..." : "Adding..."}
              </span>
            ) : (
              "Add to Queue"
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
