import { useEffect, useState, useRef } from "react";
import { api } from "../lib/api";
import { useAuthStore } from "../stores/authStore";
import { Skeleton } from "../components/ui/Skeleton";
import { Slider } from "../components/ui/Slider";
import { Select } from "../components/ui";
import {
  Settings as SettingsIcon,
  Loader2,
  CheckCircle,
  AlertCircle,
  LogOut,
  Volume2,
  Mic,
  Hash,
  Globe,
} from "lucide-react";
import clsx from "clsx";

interface Preferences {
  theme: string;
}

function SegmentedControl({
  options,
  value,
  onChange,
}: {
  options: {
    value: string;
    label: string;
    shortLabel?: string;
    disabled?: boolean;
  }[];
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="flex rounded-lg overflow-hidden border border-[var(--color-border)]">
      {options.map((opt) => (
        <button
          key={opt.value}
          onClick={() => !opt.disabled && onChange(opt.value)}
          disabled={opt.disabled}
          title={opt.disabled ? "Coming soon" : undefined}
          className={clsx(
            "flex-1 py-2.5 min-h-[44px] text-sm font-medium transition-colors",
            value === opt.value
              ? "bg-[var(--color-accent)] text-white"
              : opt.disabled
                ? "bg-[var(--color-bg-secondary)] text-[var(--color-text-tertiary)] opacity-50 cursor-not-allowed"
                : "bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] cursor-pointer",
          )}
        >
          <span className="sm:hidden">{opt.shortLabel ?? opt.label}</span>
          <span className="hidden sm:inline">{opt.label}</span>
        </button>
      ))}
    </div>
  );
}

export function Settings() {
  const logout = useAuthStore((s) => s.logout);
  const isAdmin = useAuthStore((s) => s.isAdmin);

  // Preferences state
  const [prefs, setPrefs] = useState<Preferences | null>(null);
  const [prefsLoading, setPrefsLoading] = useState(true);

  // Admin state
  const [ytInfo, setYtInfo] = useState<{
    has_key: boolean;
    key_masked: string | null;
  } | null>(null);
  const [newKey, setNewKey] = useState("");
  const [savingKey, setSavingKey] = useState(false);
  const [keySaved, setKeySaved] = useState(false);
  const [ytError, setYtError] = useState<string | null>(null);
  const [info, setInfo] = useState<{
    current_version: string | null;
    managed: boolean;
  } | null>(null);
  const [latest, setLatest] = useState<{
    latest_version: string;
    update_available: boolean;
  } | null>(null);
  const [adminLoading, setAdminLoading] = useState(true);
  const [checking, setChecking] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [adminError, setAdminError] = useState<string | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);

  // Bot settings state
  const [botDefaultVolume, setBotDefaultVolume] = useState<number>(5);
  const [savingBotVolume, setSavingBotVolume] = useState(false);
  const [botVolumeSaved, setBotVolumeSaved] = useState(false);
  const botVolumeDebounceRef = useRef<ReturnType<typeof setTimeout>>(null);

  // Voice channel state
  const [voiceChannels, setVoiceChannels] = useState<
    { id: string; name: string }[]
  >([]);
  const [defaultVoiceChannel, setDefaultVoiceChannel] = useState<string | null>(
    null,
  );
  const [savingVoice, setSavingVoice] = useState(false);
  const [voiceSaved, setVoiceSaved] = useState(false);

  // History channel state
  const [textChannels, setTextChannels] = useState<
    { id: string; name: string }[]
  >([]);
  const [historyChannelId, setHistoryChannelId] = useState<string | null>(null);
  const [savingHistory, setSavingHistory] = useState(false);
  const [historySaved, setHistorySaved] = useState(false);

  // Timezone state
  const [timezone, setTimezone] = useState("UTC");
  const [savingTz, setSavingTz] = useState(false);
  const [tzSaved, setTzSaved] = useState(false);

  const [me, setMe] = useState<{
    id: string;
    username: string;
    avatar_url: string | null;
  } | null>(null);

  useEffect(() => {
    api
      .getMe()
      .then(setMe)
      .catch(() => {});
    api
      .getPreferences()
      .then(setPrefs)
      .catch(() => {})
      .finally(() => setPrefsLoading(false));

    api
      .getYtdlpInfo()
      .then(setInfo)
      .catch(() => {})
      .finally(() => setAdminLoading(false));
    api
      .getYoutubeInfo()
      .then(setYtInfo)
      .catch(() => {});
    api
      .getVoiceChannel()
      .then((data) => {
        setVoiceChannels(data.channels);
        setDefaultVoiceChannel(data.default_channel_id);
      })
      .catch(() => {});
    api
      .getBotSettings()
      .then((s) => setBotDefaultVolume(s.default_volume))
      .catch(() => {});
    api
      .getHistoryChannel()
      .then((data) => {
        setTextChannels(data.channels);
        setHistoryChannelId(data.history_channel_id);
      })
      .catch(() => {});
    api
      .getTimezone()
      .then((data) => setTimezone(data.timezone))
      .catch(() => {});
  }, []);

  const handleCheck = async () => {
    setChecking(true);
    setAdminError(null);
    try {
      const result = await api.checkYtdlpUpdate();
      setLatest(result);
    } catch (e) {
      setAdminError(
        e instanceof Error ? e.message : "Failed to check for updates",
      );
    } finally {
      setChecking(false);
    }
  };

  const handleUpdate = async () => {
    setUpdating(true);
    setAdminError(null);
    try {
      const result = await api.updateYtdlp();
      setInfo((prev) =>
        prev ? { ...prev, current_version: result.version } : prev,
      );
      setLatest(null);
    } catch (e) {
      setAdminError(e instanceof Error ? e.message : "Update failed");
    } finally {
      setUpdating(false);
    }
  };

  const handleLogout = async () => {
    setLoggingOut(true);
    await logout();
  };

  if (prefsLoading && adminLoading) {
    return (
      <div className="p-4 md:p-6 max-w-3xl mx-auto flex flex-col gap-8 pb-32 md:pb-6">
        <Skeleton className="h-8 w-40 rounded" />
        <Skeleton className="h-40 rounded-xl" />
        <Skeleton className="h-40 rounded-xl" />
      </div>
    );
  }

  return (
    <div className="p-4 md:p-6 max-w-3xl mx-auto flex flex-col gap-10 pb-32 md:pb-6">
      <h1 className="text-lg font-semibold text-[var(--color-text)] flex items-center gap-2">
        <SettingsIcon size={20} className="text-[var(--color-accent)]" />
        Settings
      </h1>

      {/* ACCOUNT */}
      <section className="flex flex-col gap-4">
        <h2 className="text-sm font-semibold text-[var(--color-text-secondary)] uppercase tracking-wide">
          Account
        </h2>
        <div className="rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)] p-4 flex flex-col gap-4">
          {/* User info row */}
          <div className="flex items-center gap-3">
            {me?.avatar_url ? (
              <img
                src={me.avatar_url}
                alt={me.username}
                className="w-10 h-10 rounded-full object-cover flex-shrink-0"
              />
            ) : (
              <div className="w-10 h-10 rounded-full bg-[var(--color-bg-tertiary)] flex items-center justify-center flex-shrink-0">
                <span className="text-sm font-medium text-[var(--color-text-secondary)]">
                  {me?.username?.charAt(0)?.toUpperCase() ?? "?"}
                </span>
              </div>
            )}
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-[var(--color-text)] truncate">
                {me?.username ?? "Unknown"}
              </div>
              <div className="text-xs text-[var(--color-text-tertiary)]">
                Discord connected
              </div>
            </div>
            {/* Desktop logout button */}
            <button
              onClick={handleLogout}
              disabled={loggingOut}
              className="hidden md:flex min-h-[44px] px-4 py-2 rounded-lg text-sm font-medium text-red-400 border border-[var(--color-border)] hover:bg-[var(--color-bg-hover)] transition-colors items-center gap-2 cursor-pointer disabled:opacity-50"
            >
              {loggingOut ? (
                <Loader2 size={16} className="animate-spin" />
              ) : (
                <LogOut size={16} />
              )}
              Log out
            </button>
          </div>
          {/* Mobile logout button */}
          <button
            onClick={handleLogout}
            disabled={loggingOut}
            className="md:hidden min-h-[44px] w-full px-4 py-2 rounded-lg text-sm font-medium text-red-400 border border-[var(--color-border)] hover:bg-[var(--color-bg-hover)] transition-colors flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50"
          >
            {loggingOut ? (
              <Loader2 size={16} className="animate-spin" />
            ) : (
              <LogOut size={16} />
            )}
            Log out
          </button>
        </div>
      </section>

      {/* APPEARANCE */}
      <section className="flex flex-col gap-4">
        <h2 className="text-sm font-semibold text-[var(--color-text-secondary)] uppercase tracking-wide">
          Appearance
        </h2>
        <div className="rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)] p-4 flex flex-col gap-3">
          <span className="text-sm text-[var(--color-text-secondary)]">
            Theme
          </span>
          <SegmentedControl
            options={[
              { value: "dark", label: "Dark" },
              { value: "light", label: "Light (soon)", disabled: true },
              { value: "system", label: "System (soon)", disabled: true },
            ]}
            value={prefs?.theme ?? "dark"}
            onChange={() => {}}
          />
        </div>
      </section>

      {/* SERVER (admin) */}
      {isAdmin && <section className="flex flex-col gap-4">
        <h2 className="text-sm font-semibold text-[var(--color-text-secondary)] uppercase tracking-wide">
          Server
        </h2>

        {/* Default Volume */}
        <div className="rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)] p-4 flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium text-[var(--color-text)] flex items-center gap-2">
              <Volume2 size={16} className="text-[var(--color-accent)]" />
              Default Volume
            </h3>
            <span
              className={clsx(
                "flex items-center gap-1.5 text-xs transition-opacity duration-300",
                savingBotVolume
                  ? "opacity-100 text-[var(--color-text-tertiary)]"
                  : botVolumeSaved
                    ? "opacity-100 text-[var(--color-success)]"
                    : "opacity-0 pointer-events-none",
              )}
              aria-live="polite"
            >
              {savingBotVolume ? (
                <>
                  <Loader2 size={12} className="animate-spin" />
                  Saving
                </>
              ) : (
                <>
                  <CheckCircle size={12} />
                  Saved
                </>
              )}
            </span>
          </div>
          <p className="text-xs text-[var(--color-text-tertiary)] -mt-1">
            Applied to new tracks without a saved volume.
          </p>
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <span className="text-sm text-[var(--color-text-secondary)]">
                Volume
              </span>
              <span className="text-sm font-mono text-[var(--color-text)]">
                {botDefaultVolume}
              </span>
            </div>
            <Slider
              value={botDefaultVolume}
              min={0}
              max={100}
              onChange={(v) => {
                setBotDefaultVolume(v);
                setBotVolumeSaved(false);
                if (botVolumeDebounceRef.current)
                  clearTimeout(botVolumeDebounceRef.current);
                botVolumeDebounceRef.current = setTimeout(async () => {
                  setSavingBotVolume(true);
                  try {
                    await api.updateBotSettings({ default_volume: v });
                    setBotVolumeSaved(true);
                    setTimeout(() => setBotVolumeSaved(false), 2000);
                  } catch {
                  } finally {
                    setSavingBotVolume(false);
                  }
                }, 500);
              }}
              aria-label="Default volume"
            />
          </div>
        </div>

        {/* Default Voice Channel */}
        <div className="rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)] p-4 flex flex-col gap-4">
          {/* Header row */}
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium text-[var(--color-text)] flex items-center gap-2">
              <Mic size={16} className="text-[var(--color-accent)]" />
              Default Voice Channel
              {voiceChannels.length > 0 && (
                <span className="flex items-center gap-1 text-xs font-normal text-[var(--color-text-tertiary)]">
                  <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-success)] inline-block" />
                  {voiceChannels.length} available
                </span>
              )}
            </h3>
            {/* Inline save feedback */}
            <span
              className={clsx(
                "flex items-center gap-1.5 text-xs transition-opacity duration-300",
                savingVoice
                  ? "opacity-100 text-[var(--color-text-tertiary)]"
                  : voiceSaved
                    ? "opacity-100 text-[var(--color-success)]"
                    : "opacity-0 pointer-events-none",
              )}
              aria-live="polite"
            >
              {savingVoice ? (
                <>
                  <Loader2 size={12} className="animate-spin" />
                  Saving
                </>
              ) : (
                <>
                  <CheckCircle size={12} />
                  Saved
                </>
              )}
            </span>
          </div>

          <p className="text-xs text-[var(--color-text-tertiary)] -mt-1">
            Bot will auto-join this channel when playing from the web.
          </p>

          {voiceChannels.length > 0 ? (
            <Select
              value={defaultVoiceChannel ?? ""}
              onChange={async (val) => {
                setDefaultVoiceChannel(val || null);
                setSavingVoice(true);
                setVoiceSaved(false);
                try {
                  await api.setVoiceChannel(val);
                  setVoiceSaved(true);
                  setTimeout(() => setVoiceSaved(false), 2000);
                } catch {
                } finally {
                  setSavingVoice(false);
                }
              }}
              options={[
                { value: "", label: "None — manual join only" },
                ...voiceChannels.map((ch) => ({ value: ch.id, label: ch.name })),
              ]}
              placeholder="None — manual join only"
            />
          ) : (
            <div className="flex items-center gap-2 py-1">
              <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-text-tertiary)] inline-block flex-shrink-0" />
              <p className="text-xs text-[var(--color-text-tertiary)]">
                No voice channels available — bot may not be connected yet.
              </p>
            </div>
          )}
        </div>

        {/* yt-dlp */}
        <div className="rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)] p-4 flex flex-col gap-4">
          <h3 className="text-sm font-medium text-[var(--color-text)]">
            yt-dlp
          </h3>

          <div className="flex items-center justify-between">
            <span className="text-sm text-[var(--color-text-secondary)]">
              Current version
            </span>
            <span className="font-mono text-sm text-[var(--color-text)]">
              {info?.current_version ?? "not installed"}
            </span>
          </div>

          {info && !info.managed && info.current_version && (
            <p className="text-xs text-[var(--color-text-tertiary)]">
              Using system yt-dlp from PATH
            </p>
          )}

          <button
            onClick={handleCheck}
            disabled={checking}
            className="min-h-[44px] px-4 py-2 rounded-lg text-sm font-medium border border-[var(--color-border)] text-[var(--color-text-secondary)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-hover)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 cursor-pointer"
          >
            {checking && <Loader2 size={16} className="animate-spin" />}
            Check for updates
          </button>

          {latest && (
            <div className="flex items-center justify-between">
              <span className="text-sm text-[var(--color-text-secondary)]">
                Latest version
              </span>
              <span className="font-mono text-sm text-[var(--color-accent)]">
                {latest.latest_version}
              </span>
            </div>
          )}

          {latest &&
            (latest.update_available ? (
              <button
                onClick={handleUpdate}
                disabled={updating}
                className="min-h-[44px] px-4 py-2 rounded-lg text-sm font-medium bg-[var(--color-accent)] text-white hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 cursor-pointer"
              >
                {updating && <Loader2 size={16} className="animate-spin" />}
                Update to {latest.latest_version}
              </button>
            ) : (
              <div className="flex items-center gap-2 text-sm text-green-400">
                <CheckCircle size={16} />
                Up to date
              </div>
            ))}

          {adminError && (
            <div className="flex items-center gap-2 text-sm text-red-400">
              <AlertCircle size={16} className="flex-shrink-0" />
              {adminError}
            </div>
          )}
        </div>

        {/* YouTube API */}
        <div className="rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)] p-4 flex flex-col gap-4">
          <h3 className="text-sm font-medium text-[var(--color-text)]">
            YouTube API
          </h3>

          <div className="flex items-center justify-between">
            <span className="text-sm text-[var(--color-text-secondary)]">
              API Key
            </span>
            <span className="font-mono text-sm text-[var(--color-text)]">
              {ytInfo?.has_key ? ytInfo.key_masked : "not set"}
            </span>
          </div>

          <div className="flex gap-2">
            <input
              type="password"
              value={newKey}
              onChange={(e) => {
                setNewKey(e.target.value);
                setKeySaved(false);
                setYtError(null);
              }}
              placeholder="Enter new API key"
              className="flex-1 min-h-[44px] px-3 py-2 rounded-lg text-sm bg-[var(--color-bg)] border border-[var(--color-border)] text-[var(--color-text)] placeholder:text-[var(--color-text-tertiary)] outline-none focus:border-[var(--color-accent)]"
            />
            <button
              onClick={async () => {
                if (!newKey.trim()) return;
                setSavingKey(true);
                setYtError(null);
                try {
                  await api.setYoutubeKey(newKey.trim());
                  setKeySaved(true);
                  setNewKey("");
                  const info = await api.getYoutubeInfo();
                  setYtInfo(info);
                } catch (e) {
                  setYtError(e instanceof Error ? e.message : "Failed to save");
                } finally {
                  setSavingKey(false);
                }
              }}
              disabled={savingKey || !newKey.trim()}
              className="min-h-[44px] px-4 py-2 rounded-lg text-sm font-medium bg-[var(--color-accent)] text-white hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2 cursor-pointer"
            >
              {savingKey && <Loader2 size={16} className="animate-spin" />}
              Save
            </button>
          </div>

          {keySaved && (
            <div className="flex items-center gap-2 text-sm text-green-400">
              <CheckCircle size={16} className="flex-shrink-0" />
              API key saved successfully
            </div>
          )}

          {ytError && (
            <div className="flex items-center gap-2 text-sm text-red-400">
              <AlertCircle size={16} className="flex-shrink-0" />
              {ytError}
            </div>
          )}
        </div>

        {/* History Channel */}
        <div className="rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)] p-4 flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium text-[var(--color-text)] flex items-center gap-2">
              <Hash size={16} className="text-[var(--color-accent)]" />
              History Channel
              {textChannels.length > 0 && (
                <span className="flex items-center gap-1 text-xs font-normal text-[var(--color-text-tertiary)]">
                  <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-success)] inline-block" />
                  {textChannels.length} available
                </span>
              )}
            </h3>
            <span
              className={clsx(
                "flex items-center gap-1.5 text-xs transition-opacity duration-300",
                savingHistory
                  ? "opacity-100 text-[var(--color-text-tertiary)]"
                  : historySaved
                    ? "opacity-100 text-[var(--color-success)]"
                    : "opacity-0 pointer-events-none",
              )}
              aria-live="polite"
            >
              {savingHistory ? (
                <>
                  <Loader2 size={12} className="animate-spin" />
                  Saving
                </>
              ) : (
                <>
                  <CheckCircle size={12} />
                  Saved
                </>
              )}
            </span>
          </div>

          <p className="text-xs text-[var(--color-text-tertiary)] -mt-1">
            Track history embeds will be posted to this channel.
          </p>

          {textChannels.length > 0 ? (
            <Select
              value={historyChannelId ?? ""}
              onChange={async (val) => {
                setHistoryChannelId(val || null);
                setSavingHistory(true);
                setHistorySaved(false);
                try {
                  await api.setHistoryChannel(val);
                  setHistorySaved(true);
                  setTimeout(() => setHistorySaved(false), 2000);
                } catch {
                } finally {
                  setSavingHistory(false);
                }
              }}
              options={[
                { value: "", label: "None — disabled" },
                ...textChannels.map((ch) => ({
                  value: ch.id,
                  label: ch.name,
                  prefix: "#",
                })),
              ]}
              placeholder="None — disabled"
            />
          ) : (
            <div className="flex items-center gap-2 py-1">
              <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-text-tertiary)] inline-block flex-shrink-0" />
              <p className="text-xs text-[var(--color-text-tertiary)]">
                No text channels available — bot may not be connected yet.
              </p>
            </div>
          )}
        </div>

        {/* Timezone */}
        <div className="rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)] p-4 flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium text-[var(--color-text)] flex items-center gap-2">
              <Globe size={16} className="text-[var(--color-accent)]" />
              Timezone
            </h3>
            <span
              className={clsx(
                "flex items-center gap-1.5 text-xs transition-opacity duration-300",
                savingTz
                  ? "opacity-100 text-[var(--color-text-tertiary)]"
                  : tzSaved
                    ? "opacity-100 text-[var(--color-success)]"
                    : "opacity-0 pointer-events-none",
              )}
              aria-live="polite"
            >
              {savingTz ? (
                <>
                  <Loader2 size={12} className="animate-spin" />
                  Saving
                </>
              ) : (
                <>
                  <CheckCircle size={12} />
                  Saved
                </>
              )}
            </span>
          </div>

          <p className="text-xs text-[var(--color-text-tertiary)] -mt-1">
            Used for stats heatmap and trend date grouping.
          </p>

          <Select
            value={timezone}
            onChange={async (tz) => {
              setTimezone(tz);
              setSavingTz(true);
              setTzSaved(false);
              try {
                await api.setTimezone(tz);
                setTzSaved(true);
                setTimeout(() => setTzSaved(false), 2000);
              } catch {
              } finally {
                setSavingTz(false);
              }
            }}
            options={[
              "UTC",
              "Asia/Seoul",
              "Asia/Tokyo",
              "Asia/Shanghai",
              "Asia/Kolkata",
              "Europe/London",
              "Europe/Berlin",
              "Europe/Paris",
              "America/New_York",
              "America/Chicago",
              "America/Denver",
              "America/Los_Angeles",
              "America/Sao_Paulo",
              "Australia/Sydney",
              "Pacific/Auckland",
            ].map((tz) => ({ value: tz, label: tz.replace(/_/g, " ") }))}
          />
        </div>
      </section>}
    </div>
  );
}
