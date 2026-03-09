import { useEffect } from "react";
import { useToast } from "./useToast";
import { api } from "../lib/api";
import { fetchOEmbed, isSupportedOEmbedUrl } from "../lib/oembed";

function isPlaylistUrl(url: string): boolean {
  try {
    const u = new URL(url);
    const host = u.hostname;
    if ((host.includes("youtube.com") || host.includes("youtu.be")) && u.searchParams.has("list")) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

function isUnsupportedPlaylistUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.hostname.includes("soundcloud.com") && /^\/[^/]+\/sets\//.test(u.pathname)) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

export function usePasteDetection() {
  const { showToast, updateToast, removeToast } = useToast();

  useEffect(() => {
    const handlePaste = (e: ClipboardEvent) => {
      const active = document.activeElement;
      if (
        active?.tagName === "INPUT" ||
        active?.tagName === "TEXTAREA" ||
        active?.getAttribute("contenteditable") === "true"
      ) {
        return;
      }

      const text = e.clipboardData?.getData("text/plain")?.trim();
      if (!text) return;

      try {
        new URL(text);
      } catch {
        return;
      }
      if (!text.startsWith("http")) return;

      e.preventDefault();

      if (isUnsupportedPlaylistUrl(text)) {
        showToast("SoundCloud playlists are not supported", "error");
        return;
      }

      const isOEmbed = isSupportedOEmbedUrl(text);

      if (isPlaylistUrl(text)) {
        const toastId = showToast(text, "info", {
          duration: 0,
          action: {
            label: "Import playlist",
            onClick: async () => {
              removeToast(toastId);
              try {
                await api.importPlaylist(text);
                showToast("Playlist imported successfully", "success");
              } catch (err) {
                showToast(
                  err instanceof Error ? err.message : "Failed to import playlist",
                  "error"
                );
              }
            },
          },
          richPreview: isOEmbed
            ? { thumbnailUrl: "", title: "", metadata: "", loading: true }
            : undefined,
        });

        if (isOEmbed) {
          fetchOEmbed(text).then((result) => {
            if (result) {
              updateToast(toastId, {
                richPreview: {
                  thumbnailUrl: result.thumbnailUrl,
                  title: result.title,
                  metadata: [result.duration, result.provider]
                    .filter(Boolean)
                    .join(" · "),
                  loading: false,
                },
              });
            } else {
              updateToast(toastId, { richPreview: undefined });
            }
          });
        }
        return;
      }

      const handleAdd = async () => {
        removeToast(toastId);
        try {
          await api.addToQueue(text);
          showToast("Added to queue", "success");
        } catch (err) {
          showToast(
            err instanceof Error ? err.message : "Failed to add to queue",
            "error"
          );
        }
      };

      const toastId = showToast(text, "info", {
        duration: 0,
        action: { label: "Add to queue", onClick: handleAdd },
        richPreview: isOEmbed
          ? { thumbnailUrl: "", title: "", metadata: "", loading: true }
          : undefined,
      });

      if (isOEmbed) {
        fetchOEmbed(text).then((result) => {
          if (result) {
            updateToast(toastId, {
              richPreview: {
                thumbnailUrl: result.thumbnailUrl,
                title: result.title,
                metadata: [result.duration, result.provider]
                  .filter(Boolean)
                  .join(" · "),
                loading: false,
              },
            });
          } else {
            updateToast(toastId, { richPreview: undefined });
          }
        });
      }
    };

    document.addEventListener("paste", handlePaste);
    return () => document.removeEventListener("paste", handlePaste);
  }, [showToast, updateToast, removeToast]);
}
