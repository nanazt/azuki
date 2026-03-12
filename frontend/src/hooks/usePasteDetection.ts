import { useEffect } from "react";
import { useToast } from "./useToast";
import { t } from "./useLocale";
import { api } from "../lib/api";
import { fetchOEmbed, isSupportedOEmbedUrl } from "../lib/oembed";

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

      const isOEmbed = isSupportedOEmbedUrl(text);

      const handleAdd = async () => {
        removeToast(toastId);
        try {
          await api.addToQueue({ query_or_url: text });
          showToast(t().toast.addedToQueue, "success");
        } catch (err) {
          showToast(
            err instanceof Error ? err.message : t().toast.failedToAddToQueue,
            "error",
          );
        }
      };

      const toastId = showToast(text, "info", {
        duration: 0,
        action: { label: t().toast.addToQueue, onClick: handleAdd },
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
