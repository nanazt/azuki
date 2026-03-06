import { CheckCircle, Info, XCircle } from "lucide-react";
import clsx from "clsx";
import { useToast } from "../../hooks/useToast";
import type { Toast as ToastItem, ToastType } from "../../hooks/useToast";

export { ToastProvider, useToast } from "../../hooks/useToast";

const iconMap: Record<ToastType, React.ReactNode> = {
  success: <CheckCircle size={16} className="text-[var(--color-success)] flex-shrink-0" />,
  error: <XCircle size={16} className="text-[var(--color-danger)] flex-shrink-0" />,
  info: <Info size={16} className="text-[var(--color-accent)] flex-shrink-0" />,
};

function ToastItem({ toast, onRemove }: { toast: ToastItem; onRemove: () => void }) {
  return (
    <div
      className={clsx(
        "flex items-center gap-2.5 px-4 py-3 rounded-lg shadow-lg max-w-sm",
        "bg-[var(--color-bg-secondary)] border border-[var(--color-border)]",
        "animate-[fadeInUp_0.2s_ease-out]"
      )}
      role="alert"
    >
      {iconMap[toast.type]}
      <span className="text-sm text-[var(--color-text)] flex-1">{toast.message}</span>
      <button
        onClick={onRemove}
        className="text-[var(--color-text-tertiary)] hover:text-[var(--color-text)] ml-1 flex-shrink-0"
        aria-label="Dismiss"
      >
        ×
      </button>
    </div>
  );
}

export function ToastContainer() {
  const { toasts, removeToast } = useToast();

  if (toasts.length === 0) return null;

  return (
    <div
      className="fixed bottom-24 right-4 z-50 flex flex-col gap-2"
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
