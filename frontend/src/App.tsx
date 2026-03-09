import { useEffect, useState } from "react";
import { BrowserRouter, Routes, Route, Navigate, Outlet } from "react-router-dom";
import { ToastProvider, ToastContainer } from "./components/ui/Toast";
import { useAuthStore } from "./stores/authStore";
import { api } from "./lib/api";
import { useWebSocket } from "./hooks/useWebSocket";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import { usePasteDetection } from "./hooks/usePasteDetection";
import { useFileDrop } from "./hooks/useFileDrop";
import { AppShell } from "./components/layout/AppShell";
import { DropOverlay } from "./components/ui/DropOverlay";
import { UploadMetadataModal } from "./components/features/upload/UploadMetadataModal";
import { Login } from "./pages/Login";
import { Home } from "./pages/Home";
import { History } from "./pages/History";
import { Stats } from "./pages/Stats";
import { Settings } from "./pages/Settings";
import { Help } from "./pages/Help";
import { SearchPage } from "./components/features/search/SearchPage";
import { QueuePanel } from "./components/features/queue";
import { UploadsPage } from "./components/features/uploads/UploadsPage";
import { WelcomeModal } from "./components/features/onboarding/WelcomeModal";

function ProtectedRoute() {
  const { authenticated, checking, setAuthenticated, setChecking, setIsAdmin } = useAuthStore();

  useEffect(() => {
    if (!checking) return;
    fetch("/api/stats/me", { credentials: "include" })
      .then((res) => {
        setAuthenticated(res.ok);
        if (res.ok) {
          api.getMe().then((me) => setIsAdmin(me.is_admin));
        }
      })
      .catch(() => {
        setAuthenticated(false);
        setChecking(false);
      });
  }, [checking, setAuthenticated, setChecking, setIsAdmin]);

  if (checking) {
    return (
      <div className="flex items-center justify-center h-dvh bg-[var(--color-bg)]">
        <div className="text-[var(--color-text-secondary)]">Loading...</div>
      </div>
    );
  }

  if (!authenticated) {
    return <Navigate to="/login" replace />;
  }

  return <AuthenticatedLayout />;
}

function AuthenticatedLayout() {
  useWebSocket();
  useKeyboardShortcuts();
  usePasteDetection();
  const { isDragging, droppedFile, clearDroppedFile, triggerFileInput } = useFileDrop();
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
      <WelcomeModal
        open={showWelcome}
        onClose={() => setShowWelcome(false)}
      />
    </>
  );
}

export default function App() {
  return (
    <ToastProvider>
      <BrowserRouter>
        <ToastContainer />
        <Routes>
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
        </Routes>
      </BrowserRouter>
    </ToastProvider>
  );
}
