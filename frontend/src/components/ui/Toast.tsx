import { useEffect } from "react";
import { CheckCircle, Info, X, XCircle } from "lucide-react";
import clsx from "clsx";
import { useToast } from "../../hooks/useToast";
import type { Toast as ToastData, ToastType } from "../../hooks/useToast";

export { ToastProvider, useToast } from "../../hooks/useToast";

const iconMap: Record<ToastType, React.ReactNode> = {
  success: (
    <CheckCircle
      size={16}
      className="text-[var(--color-success)] flex-shrink-0"
    />
  ),
  error: (
    <XCircle size={16} className="text-[var(--color-danger)] flex-shrink-0" />
  ),
  info: (
    <Info
      size={16}
      className="text-[var(--color-text-secondary)] flex-shrink-0"
    />
  ),
};

function RichPreviewSkeleton() {
  return (
    <div className="flex gap-3 animate-pulse">
      <div className="w-14 h-14 rounded-md bg-[var(--color-bg-tertiary)] flex-shrink-0" />
      <div className="flex-1 space-y-2 py-1">
        <div className="h-3 bg-[var(--color-bg-tertiary)] rounded w-3/4" />
        <div className="h-3 bg-[var(--color-bg-tertiary)] rounded w-1/2" />
      </div>
    </div>
  );
}

function ToastItem({
  toast,
  onRemove,
}: {
  toast: ToastData;
  onRemove: () => void;
}) {
  const hasRichPreview = toast.richPreview;
  const isRich = hasRichPreview || toast.action;

  return (
    <div
      className={clsx(
        "flex flex-col gap-2 px-4 py-3 rounded-lg shadow-lg",
        "bg-[var(--color-bg-secondary)] border border-[var(--color-border)]",
        "animate-[fadeInUp_0.2s_ease-out]",
        isRich ? "w-80 border-l-2 border-l-[var(--color-accent)]" : "max-w-sm",
      )}
      role="alert"
    >
      {/* Rich preview */}
      {hasRichPreview &&
        (toast.richPreview!.loading ? (
          <RichPreviewSkeleton />
        ) : (
          <div className="flex gap-3">
            {toast.richPreview!.thumbnailUrl && (
              <img
                src={toast.richPreview!.thumbnailUrl}
                alt=""
                className="w-14 h-14 rounded-md object-cover flex-shrink-0"
              />
            )}
            <div className="flex-1 min-w-0">
              <p className="text-sm text-[var(--color-text)] font-medium line-clamp-2">
                {toast.richPreview!.title}
              </p>
              {toast.richPreview!.metadata && (
                <p className="text-xs text-[var(--color-text-tertiary)] mt-0.5">
                  {toast.richPreview!.metadata}
                </p>
              )}
            </div>
          </div>
        ))}

      {/* Standard message row */}
      {!hasRichPreview && (
        <div className="flex items-center gap-2.5">
          {iconMap[toast.type]}
          <span className="text-sm text-[var(--color-text)] flex-1">
            {toast.message}
          </span>
          {!toast.action && (
            <button
              onClick={onRemove}
              className="text-[var(--color-text-tertiary)] hover:text-[var(--color-text)] ml-1 flex-shrink-0"
              aria-label="Dismiss"
            >
              ×
            </button>
          )}
        </div>
      )}

      {/* Action row */}
      {toast.action && (
        <div className="flex items-center justify-between gap-2">
          {!hasRichPreview && <span />}
          <div className="flex items-center gap-2">
            <button
              onClick={toast.action.onClick}
              className="px-3 py-1.5 text-xs font-medium rounded-md bg-[var(--color-accent)] text-[#1a1a1a] hover:opacity-90 transition-opacity touch-manipulation min-h-[44px] sm:min-h-0"
            >
              {toast.action.label}
            </button>
            <button
              onClick={onRemove}
              className="p-1.5 text-[var(--color-text-tertiary)] hover:text-[var(--color-text)] transition-colors touch-manipulation min-w-[44px] min-h-[44px] sm:min-w-0 sm:min-h-0 flex items-center justify-center"
              aria-label="Dismiss"
            >
              <X size={14} />
            </button>
          </div>
        </div>
      )}

      {/* Non-action toasts have inline close */}
    </div>
  );
}

export function ToastContainer() {
  const { toasts, removeToast } = useToast();

  // Keyboard: Enter = trigger latest action toast, ESC = dismiss latest action toast
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const active = document.activeElement;
      if (
        active?.tagName === "INPUT" ||
        active?.tagName === "TEXTAREA" ||
        active?.getAttribute("contenteditable") === "true"
      ) {
        return;
      }

      const actionToasts = toasts.filter((t) => t.action);
      if (actionToasts.length === 0) return;
      const latest = actionToasts[actionToasts.length - 1];

      if (e.key === "Enter") {
        e.preventDefault();
        latest.action!.onClick();
        removeToast(latest.id);
      } else if (e.key === "Escape") {
        e.preventDefault();
        removeToast(latest.id);
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [toasts, removeToast]);

  if (toasts.length === 0) return null;

  return (
    <div
      className="fixed z-50 flex flex-col gap-2 right-4"
      style={{ bottom: "calc(var(--player-height, 5rem) + 1rem)" }}
      aria-live="polite"
      aria-atomic="false"
    >
      {toasts.map((toast) => (
        <ToastItem
          key={toast.id}
          toast={toast}
          onRemove={() => removeToast(toast.id)}
        />
      ))}
    </div>
  );
}
