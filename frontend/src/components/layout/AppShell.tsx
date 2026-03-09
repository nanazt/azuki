import { type ReactNode, useState, useEffect, useCallback } from "react";
import { Sidebar } from "./Sidebar";
import { QueuePanel } from "../features/queue";
import { MobileTabBar } from "./MobileTabBar";
import { PlayerBar } from "../features/player/PlayerBar";
import { ConnectionStatus } from "../ui/ConnectionStatus";

interface AppShellProps {
  children: ReactNode;
}

export function AppShell({ children }: AppShellProps) {
  const [queueDrawerOpen, setQueueDrawerOpen] = useState(false);

  const toggleQueueDrawer = useCallback(() => {
    setQueueDrawerOpen((prev) => !prev);
  }, []);

  // Close drawer on ESC
  useEffect(() => {
    if (!queueDrawerOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setQueueDrawerOpen(false);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [queueDrawerOpen]);

  // Auto-close drawer when viewport crosses lg breakpoint
  useEffect(() => {
    const mql = window.matchMedia("(min-width: 1024px)");
    const handleChange = (e: MediaQueryListEvent) => {
      if (e.matches) setQueueDrawerOpen(false);
    };
    mql.addEventListener("change", handleChange);
    return () => mql.removeEventListener("change", handleChange);
  }, []);

  return (
    <div className="flex h-dvh overflow-hidden bg-[var(--color-bg)]">
      {/* Left sidebar — hidden on mobile */}
      <div className="hidden md:flex flex-shrink-0 w-60">
        <Sidebar />
      </div>

      {/* Main content area */}
      <main className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <ConnectionStatus />
        <div className="flex-1 overflow-y-auto pb-32 md:pb-20" data-main-scroll>
          {children}
        </div>
      </main>

      {/* Right panel — hidden on mobile and tablet */}
      <div className="hidden lg:flex flex-shrink-0 w-[340px] border-l border-[var(--color-border)] flex-col overflow-hidden">
        <QueuePanel />
      </div>

      {/* Queue drawer backdrop — md~lg only */}
      {queueDrawerOpen && (
        <div
          className="fixed inset-0 bg-black/40 z-40 lg:hidden"
          onClick={() => setQueueDrawerOpen(false)}
        />
      )}

      {/* Queue drawer panel — md~lg only */}
      <div
        className={`fixed top-0 right-0 bottom-0 w-[340px] z-50 lg:hidden bg-[var(--color-bg)] border-l border-[var(--color-border)] flex flex-col overflow-hidden transition-transform duration-300 ease-out ${
          queueDrawerOpen ? "translate-x-0" : "translate-x-full"
        }`}
      >
        <QueuePanel />
      </div>

      {/* Fixed bottom player bar */}
      <div className="fixed bottom-0 left-0 right-0 z-30">
        <PlayerBar
          onToggleQueue={toggleQueueDrawer}
          queueDrawerOpen={queueDrawerOpen}
        />
      </div>

      {/* Mobile bottom tab bar — shown only on mobile, above player bar */}
      <div className="md:hidden fixed bottom-[60px] left-0 right-0 z-30">
        <MobileTabBar />
      </div>
    </div>
  );
}
