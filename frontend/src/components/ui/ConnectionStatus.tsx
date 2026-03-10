import { usePlayerStore } from "../../stores/playerStore";
import { useLocale, t } from "../../hooks/useLocale";

export function ConnectionStatus() {
  useLocale();
  const s = t();
  const connected = usePlayerStore((st) => st.connected);
  const hasConnected = usePlayerStore((st) => st.hasConnected);

  const show = hasConnected && !connected;

  return (
    <div
      className="overflow-hidden transition-all duration-300 ease-in-out"
      style={{ maxHeight: show ? "48px" : "0px" }}
      aria-live="polite"
      role="status"
    >
      <div className="flex items-center gap-2 px-4 py-2.5 border-b bg-[var(--color-warning-bg)] border-[var(--color-warning-border)]">
        <span className="relative flex h-2 w-2 flex-shrink-0">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[var(--color-warning)] opacity-75" />
          <span className="relative inline-flex rounded-full h-2 w-2 bg-[var(--color-warning)]" />
        </span>
        <span className="text-xs font-medium text-[var(--color-warning)]">
          {s.status.reconnecting}
        </span>
      </div>
    </div>
  );
}
