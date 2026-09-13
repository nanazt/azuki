import { useEffect, useState } from "react";
import {
  BrowserRouter,
  Routes,
  Route,
  Navigate,
  Outlet,
} from "react-router-dom";
import { ToastProvider, ToastContainer } from "./components/ui/Toast";
import {
  startAuthCoordinator,
  useAuthStore,
} from "./stores/authStore";
import { useWebSocket } from "./hooks/useWebSocket";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import { syncLocaleFromServer, t, useLocale } from "./hooks/useLocale";
import { usePasteDetection } from "./hooks/usePasteDetection";
import { useFileDrop } from "./hooks/useFileDrop";
import { AppShell } from "./components/layout/AppShell";
import { DropOverlay } from "./components/ui/DropOverlay";
import { UploadMetadataModal } from "./components/features/upload/UploadMetadataModal";
import { Login } from "./pages/Login";
import { Setup } from "./pages/Setup";
import { Home } from "./pages/Home";
import { History } from "./pages/History";
import { Stats } from "./pages/Stats";
import { Settings } from "./pages/Settings";
import { Help } from "./pages/Help";
import { SearchPage } from "./pages/Search";
import { QueuePanel } from "./components/features/queue";
import { UploadsPage } from "./pages/Uploads";
import { WelcomeModal } from "./components/features/onboarding/WelcomeModal";

function SetupGuard() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    fetch("/setup/status")
      .then((r) => r.json())
      .then((data: { status: string }) => {
        if (data.status === "setup") {
          window.location.href = "/setup";
        } else {
          setReady(true);
        }
      })
      .catch(() => {
        // /setup/status unavailable — server is in normal mode
        setReady(true);
      });
  }, []);

  if (!ready) {
    return (
      <div className="flex items-center justify-center h-dvh bg-[var(--color-bg)]">
        <div className="text-[var(--color-text-secondary)]">Loading...</div>
      </div>
    );
  }

  return <Outlet />;
}

function ProtectedRoute() {
  useLocale();
  const status = useAuthStore((state) => state.status);
  const retry = useAuthStore((state) => state.retry);
  const s = t();

  useEffect(() => startAuthCoordinator(), []);

  if (status === "checking") {
    return (
      <div className="flex items-center justify-center h-dvh bg-[var(--color-bg)]">
        <div className="text-[var(--color-text-secondary)]">
          {s.status.loading}
        </div>
      </div>
    );
  }

  if (status === "transient" || status === "forbidden") {
    const forbidden = status === "forbidden";
    return (
      <div className="flex items-center justify-center h-dvh bg-[var(--color-bg)] p-4">
        <div className="w-full max-w-sm bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-2xl p-6 flex flex-col items-center gap-4 text-center shadow-xl">
          <h1 className="text-lg font-semibold text-[var(--color-text)]">
            {forbidden ? s.auth.forbiddenTitle : s.auth.checkFailedTitle}
          </h1>
          <p className="text-sm text-[var(--color-text-secondary)]">
            {forbidden ? s.auth.forbiddenMessage : s.auth.checkFailedMessage}
          </p>
          <button
            type="button"
            onClick={() => void retry()}
            className="min-h-[44px] w-full px-4 py-2 rounded-lg text-sm font-semibold bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-[#1a1a1a] transition-colors"
          >
            {s.auth.retry}
          </button>
        </div>
      </div>
    );
  }

  if (status === "unauthenticated") {
    return <Navigate to="/login" replace />;
  }

  return <AuthenticatedLayout />;
}

function AuthenticatedLayout() {
  useWebSocket();
  useKeyboardShortcuts();
  usePasteDetection();
  useEffect(() => syncLocaleFromServer(), []);
  const { isDragging, droppedFile, clearDroppedFile, triggerFileInput } =
    useFileDrop();
  const [showWelcome, setShowWelcome] = useState(
    () => !localStorage.getItem("azuki-welcome-dismissed"),
  );

  return (
    <>
      <AppShell>
        <Outlet />
      </AppShell>
      {isDragging && <DropOverlay onSelectFile={triggerFileInput} />}
      {droppedFile && (
        <UploadMetadataModal file={droppedFile} onClose={clearDroppedFile} />
      )}
      <WelcomeModal open={showWelcome} onClose={() => setShowWelcome(false)} />
    </>
  );
}

export default function App() {
  return (
    <ToastProvider>
      <BrowserRouter>
        <ToastContainer />
        <Routes>
          <Route path="/setup" element={<Setup />} />
          <Route element={<SetupGuard />}>
            <Route path="/login" element={<Login />} />
            <Route element={<ProtectedRoute />}>
              <Route path="/" element={<Home />} />
              <Route path="/search" element={<SearchPage />} />
              <Route path="/history" element={<History />} />
              <Route path="/uploads" element={<UploadsPage />} />
              <Route path="/stats" element={<Stats />} />
              <Route path="/settings" element={<Settings />} />
              <Route path="/help" element={<Help />} />
              <Route path="/queue" element={<QueuePanel />} />
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </ToastProvider>
  );
}
