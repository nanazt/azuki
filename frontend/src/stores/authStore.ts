import { create } from "zustand";

const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const AUTH_HEADERS = { "X-Requested-With": "XMLHttpRequest" };

export type AuthStatus =
  | "checking"
  | "authenticated"
  | "unauthenticated"
  | "transient"
  | "forbidden";

export interface AuthUser {
  id: string;
  username: string;
  avatar_url: string | null;
  is_admin: boolean;
}

interface AuthMetadata {
  expires_at: number;
  absolute_expires_at: number;
}

interface MeResponse extends AuthUser, AuthMetadata {}

class AuthRequestError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null) {
    super(message);
    this.name = "AuthRequestError";
    this.status = status;
  }
}

interface AuthState {
  status: AuthStatus;
  user: AuthUser | null;
  isAdmin: boolean;
  expiresAt: number | null;
  absoluteExpiresAt: number | null;
  loggingOut: boolean;
  retry: () => Promise<AuthStatus>;
  logout: () => Promise<void>;
}

type AuthOutcome<T> =
  | { kind: "success"; value: T }
  | { kind: "unauthenticated"; error: AuthRequestError }
  | { kind: "forbidden"; error: AuthRequestError }
  | { kind: "transient"; error: AuthRequestError };

let authGeneration = 0;
let refreshInFlight: Promise<AuthStatus> | null = null;
let probeInFlight:
  | {
      generation: number;
      promise: Promise<AuthStatus | null>;
    }
  | null = null;
let logoutInFlight: Promise<void> | null = null;
let coordinatorActive = false;
let coordinatorGeneration = 0;
let refreshTimer: ReturnType<typeof setTimeout> | undefined;
let removeCoordinatorListeners: (() => void) | null = null;

async function responseError(response: Response): Promise<AuthRequestError> {
  const body = await response
    .json()
    .catch(() => ({ error: response.statusText }));
  const message =
    typeof body?.error === "string" && body.error
      ? body.error
      : response.statusText || "Request failed";
  return new AuthRequestError(message, response.status);
}

async function authRequest<T>(
  url: string,
  init?: RequestInit,
): Promise<AuthOutcome<T>> {
  let response: Response;

  try {
    response = await fetch(url, {
      credentials: "include",
      cache: "no-store",
      ...init,
      headers: { ...AUTH_HEADERS, ...init?.headers },
    });
  } catch (error) {
    return {
      kind: "transient",
      error: new AuthRequestError(
        error instanceof Error ? error.message : "Network request failed",
        null,
      ),
    };
  }

  if (response.status === 401) {
    return { kind: "unauthenticated", error: await responseError(response) };
  }
  if (response.status === 403) {
    return { kind: "forbidden", error: await responseError(response) };
  }
  if (!response.ok) {
    return { kind: "transient", error: await responseError(response) };
  }

  if (response.status === 204) {
    return { kind: "success", value: undefined as T };
  }

  try {
    return { kind: "success", value: (await response.json()) as T };
  } catch {
    return {
      kind: "transient",
      error: new AuthRequestError("Invalid server response", response.status),
    };
  }
}

function clearRefreshTimer() {
  if (refreshTimer !== undefined) {
    clearTimeout(refreshTimer);
    refreshTimer = undefined;
  }
}

function canRenew() {
  const state = useAuthStore.getState();
  return (
    coordinatorActive &&
    document.visibilityState === "visible" &&
    state.status === "authenticated" &&
    !state.loggingOut
  );
}

function scheduleRefresh() {
  clearRefreshTimer();
  const scheduledCoordinator = coordinatorGeneration;

  if (!canRenew()) return;

  refreshTimer = setTimeout(() => {
    refreshTimer = undefined;
    if (
      scheduledCoordinator !== coordinatorGeneration ||
      !canRenew()
    ) {
      return;
    }
    void refreshAuthentication();
  }, REFRESH_INTERVAL_MS);
}

function applyMe(me: MeResponse) {
  useAuthStore.setState({
    status: "authenticated",
    user: {
      id: me.id,
      username: me.username,
      avatar_url: me.avatar_url,
      is_admin: me.is_admin,
    },
    isAdmin: me.is_admin,
    expiresAt: me.expires_at,
    absoluteExpiresAt: me.absolute_expires_at,
  });
  scheduleRefresh();
}

function applyProbeFailure(status: Exclude<AuthStatus, "checking" | "authenticated">) {
  useAuthStore.setState({
    status,
    user: null,
    isAdmin: false,
    expiresAt: null,
    absoluteExpiresAt: null,
  });
  clearRefreshTimer();
}

async function runProbe(generation: number): Promise<AuthStatus | null> {
  const outcome = await authRequest<MeResponse>("/api/me");
  if (
    generation !== authGeneration ||
    useAuthStore.getState().loggingOut
  ) {
    return null;
  }

  switch (outcome.kind) {
    case "success":
      applyMe(outcome.value);
      return "authenticated";
    case "unauthenticated":
      applyProbeFailure("unauthenticated");
      return "unauthenticated";
    case "forbidden":
      applyProbeFailure("forbidden");
      return "forbidden";
    case "transient":
      applyProbeFailure("transient");
      return "transient";
  }
}

async function verifyCurrentAuthentication(
  waitForRefresh = true,
  shouldContinue: () => boolean = () => true,
): Promise<AuthStatus> {
  if (waitForRefresh && refreshInFlight) {
    await refreshInFlight;
  }

  if (!shouldContinue()) return useAuthStore.getState().status;
  for (;;) {
    if (useAuthStore.getState().loggingOut) {
      return useAuthStore.getState().status;
    }
    if (!shouldContinue()) return useAuthStore.getState().status;

    const generation = authGeneration;
    let probe = probeInFlight;

    if (!probe || probe.generation !== generation) {
      probe = {
        generation,
        promise: runProbe(generation),
      };
      probeInFlight = probe;
    }

    const result = await probe.promise;
    if (probeInFlight === probe) {
      probeInFlight = null;
    }
    if (result !== null) return result;
    if (!shouldContinue()) return useAuthStore.getState().status;

    if (waitForRefresh && refreshInFlight) {
      await refreshInFlight;
    }
  }
}

export async function recoverAuthentication(): Promise<AuthStatus> {
  return verifyCurrentAuthentication(true);
}

export async function waitForPendingRefresh(): Promise<void> {
  if (refreshInFlight) {
    await refreshInFlight;
  }
}

async function refreshAuthentication(): Promise<AuthStatus> {
  if (refreshInFlight) return refreshInFlight;
  if (!canRenew()) return useAuthStore.getState().status;

  const generation = ++authGeneration;
  const operation = (async () => {
    const outcome = await authRequest<AuthMetadata>("/api/auth/refresh", {
      method: "POST",
    });

    if (
      generation !== authGeneration ||
      useAuthStore.getState().loggingOut
    ) {
      return useAuthStore.getState().status;
    }

    if (outcome.kind === "success") {
      useAuthStore.setState({
        expiresAt: outcome.value.expires_at,
        absoluteExpiresAt: outcome.value.absolute_expires_at,
      });
      return "authenticated";
    }

    if (outcome.kind === "transient") {
      return useAuthStore.getState().status;
    }

    return verifyCurrentAuthentication(false);
  })();

  refreshInFlight = operation;
  try {
    return await operation;
  } finally {
    if (refreshInFlight === operation) {
      refreshInFlight = null;
    }
    scheduleRefresh();
  }
}

async function retryAuthentication(): Promise<AuthStatus> {
  if (logoutInFlight) return useAuthStore.getState().status;

  ++authGeneration;
  useAuthStore.setState({ status: "checking" });
  const status = await verifyCurrentAuthentication(false);
  if (status === "authenticated" && document.visibilityState === "visible") {
    return refreshAuthentication();
  }
  return status;
}

async function logout(): Promise<void> {
  if (logoutInFlight) return logoutInFlight;

  ++authGeneration;
  clearRefreshTimer();
  useAuthStore.setState({ loggingOut: true });

  const operation = (async () => {
    const outcome = await authRequest<void>("/auth/logout", { method: "POST" });

    if (outcome.kind === "success") {
      ++authGeneration;
      useAuthStore.setState({
        status: "unauthenticated",
        user: null,
        isAdmin: false,
        expiresAt: null,
        absoluteExpiresAt: null,
        loggingOut: false,
      });
      window.location.assign("/login");
      return;
    }

    if (outcome.kind === "unauthenticated") {
      useAuthStore.setState({ loggingOut: false });
      await verifyCurrentAuthentication(false);
    } else {
      useAuthStore.setState({ loggingOut: false });
    }

    throw outcome.error;
  })();

  logoutInFlight = operation;
  try {
    await operation;
  } finally {
    if (logoutInFlight === operation) {
      logoutInFlight = null;
    }
    scheduleRefresh();
  }
}

export const useAuthStore = create<AuthState>(() => ({
  status: "checking",
  user: null,
  isAdmin: false,
  expiresAt: null,
  absoluteExpiresAt: null,
  loggingOut: false,
  retry: retryAuthentication,
  logout,
}));

export function startAuthCoordinator(): () => void {
  if (coordinatorActive) return () => {};

  coordinatorActive = true;
  const lifecycle = ++coordinatorGeneration;

  const refreshIfCurrent = async () => {
    const belongsToCurrentCoordinator = () =>
      coordinatorActive && lifecycle === coordinatorGeneration;
    const status = await verifyCurrentAuthentication(
      true,
      belongsToCurrentCoordinator,
    );
    if (
      coordinatorActive &&
      lifecycle === coordinatorGeneration &&
      status === "authenticated" &&
      document.visibilityState === "visible"
    ) {
      await refreshAuthentication();
    }
  };

  const handleVisibility = () => {
    if (document.visibilityState !== "visible") {
      clearRefreshTimer();
      return;
    }
    void refreshIfCurrent();
  };

  const handleOnline = () => {
    if (document.visibilityState === "visible") {
      void refreshIfCurrent();
    }
  };

  document.addEventListener("visibilitychange", handleVisibility);
  window.addEventListener("online", handleOnline);
  removeCoordinatorListeners = () => {
    document.removeEventListener("visibilitychange", handleVisibility);
    window.removeEventListener("online", handleOnline);
  };

  void refreshIfCurrent();

  return () => {
    if (!coordinatorActive || lifecycle !== coordinatorGeneration) return;
    coordinatorActive = false;
    ++coordinatorGeneration;
    ++authGeneration;
    clearRefreshTimer();
    removeCoordinatorListeners?.();
    removeCoordinatorListeners = null;
  };
}
