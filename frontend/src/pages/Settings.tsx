import { useEffect, useState, useRef } from "react";
import { api } from "../lib/api";
import { useAuthStore } from "../stores/authStore";
import { useTheme } from "../hooks/useTheme";
import { useLocale, setLocale, t } from "../hooks/useLocale";
import type { Locale } from "../locales";
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
  HelpCircle,
  ChevronRight,
} from "lucide-react";
import { Link } from "react-router-dom";
import clsx from "clsx";

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
  const s = t();
  return (
    <div className="flex rounded-lg overflow-hidden border border-[var(--color-border)]">
      {options.map((opt) => (
        <button
          key={opt.value}
          onClick={() => !opt.disabled && onChange(opt.value)}
          disabled={opt.disabled}
          title={opt.disabled ? s.settings.comingSoon : undefined}
          className={clsx(
            "flex-1 py-2.5 min-h-[44px] text-sm font-medium transition-colors",
            value === opt.value
              ? "bg-[var(--color-accent)] text-[#1a1a1a]"
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
  const locale = useLocale();
  const s = t();
  const logout = useAuthStore((s) => s.logout);
  const isAdmin = useAuthStore((s) => s.isAdmin);
  const { theme, setTheme } = useTheme();

  // Preferences state (loading gate only)
  const [prefsLoaded, setPrefsLoaded] = useState(false);

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

  // Bot locale state
  const [botLocale, setBotLocale] = useState("ko");
  const [savingBotLocale, setSavingBotLocale] = useState(false);
  const [botLocaleSaved, setBotLocaleSaved] = useState(false);

  const [me, setMe] = useState<{
    id: string;
    username: string;
    avatar_url: string | null;
  } | null>(null);

  useEffect(() => {
    api
      .getMe()
      .then(setMe)
      .catch(() => {})
      .finally(() => setPrefsLoaded(true));
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
    api
      .getBotLocale()
      .then((data) => setBotLocale(data.locale))
      .catch(() => {});
  }, []);

  const handleCheck = async () => {
    setChecking(true);
    setAdminError(null);
    try {
      const result = await api.checkYtdlpUpdate();
      setLatest(result);
    } catch (e) {
      const s = t();
      setAdminError(
        e instanceof Error ? e.message : s.toast.failedToCheckForUpdates,
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
      const s = t();
      setAdminError(e instanceof Error ? e.message : s.toast.updateFailed);
    } finally {
      setUpdating(false);
    }
  };

  const handleLogout = async () => {
    setLoggingOut(true);
    await logout();
  };

  if (!prefsLoaded && adminLoading) {
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
        <SettingsIcon
          size={20}
          className="text-[var(--color-text-secondary)]"
        />
        {s.settings.title}
      </h1>

      {/* ACCOUNT */}
      <section className="flex flex-col gap-4">
        <h2 className="text-sm font-semibold text-[var(--color-text-secondary)] uppercase tracking-wide">
          {s.settings.account}
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
                {s.settings.discordConnected}
              </div>
            </div>
            {/* Desktop logout button */}
            <button
              onClick={handleLogout}
              disabled={loggingOut}
              className="hidden md:flex min-h-[44px] px-4 py-2 rounded-lg text-sm font-medium text-[var(--color-danger)] border border-[var(--color-border)] hover:bg-[var(--color-bg-hover)] transition-colors items-center gap-2 cursor-pointer disabled:opacity-50"
            >
              {loggingOut ? (
                <Loader2 size={16} className="animate-spin" />
              ) : (
                <LogOut size={16} />
              )}
              {s.settings.logOut}
            </button>
          </div>
          {/* Mobile logout button */}
          <button
            onClick={handleLogout}
            disabled={loggingOut}
            className="md:hidden min-h-[44px] w-full px-4 py-2 rounded-lg text-sm font-medium text-[var(--color-danger)] border border-[var(--color-border)] hover:bg-[var(--color-bg-hover)] transition-colors flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50"
          >
            {loggingOut ? (
              <Loader2 size={16} className="animate-spin" />
            ) : (
              <LogOut size={16} />
            )}
            {s.settings.logOut}
          </button>
          {/* Mobile help link */}
          <Link
            to="/help"
            className="md:hidden flex items-center gap-3 min-h-[44px] px-3 py-2 rounded-lg text-sm text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] transition-colors"
          >
            <HelpCircle size={16} />
            <span className="flex-1">{s.settings.help}</span>
            <ChevronRight
              size={16}
              className="text-[var(--color-text-tertiary)]"
            />
          </Link>
        </div>
      </section>

      {/* APPEARANCE */}
      <section className="flex flex-col gap-4">
        <h2 className="text-sm font-semibold text-[var(--color-text-secondary)] uppercase tracking-wide">
          {s.settings.appearance}
        </h2>
        <div className="rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)] p-4 flex flex-col gap-3">
          <span className="text-sm text-[var(--color-text-secondary)]">
            {s.settings.theme}
          </span>
          <SegmentedControl
            options={[
              { value: "dark", label: s.settings.dark },
              { value: "light", label: s.settings.light },
              { value: "system", label: s.settings.system },
            ]}
            value={theme}
            onChange={setTheme}
          />
        </div>
        {/* Language */}
        <div className="rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)] p-4 flex flex-col gap-3">
          <span className="text-sm text-[var(--color-text-secondary)]">
            {s.settings.language}
          </span>
          <SegmentedControl
            options={[
              { value: "ko", label: "\ud55c\uad6d\uc5b4" },
              { value: "en", label: "English" },
            ]}
            value={locale}
            onChange={(v) => setLocale(v as Locale)}
          />
        </div>
      </section>

      {/* SERVER (admin) */}
      {isAdmin && (
        <section className="flex flex-col gap-4">
          <h2 className="text-sm font-semibold text-[var(--color-text-secondary)] uppercase tracking-wide">
            {s.settings.server}
          </h2>

          {/* Bot Language */}
          <div className="rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)] p-4 flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-medium text-[var(--color-text)] flex items-center gap-2">
                <Globe
                  size={16}
                  className="text-[var(--color-text-secondary)]"
                />
                {s.settings.botLanguage}
              </h3>
              <span
                className={clsx(
                  "flex items-center gap-1.5 text-xs transition-opacity duration-300",
                  savingBotLocale
                    ? "opacity-100 text-[var(--color-text-tertiary)]"
                    : botLocaleSaved
                      ? "opacity-100 text-[var(--color-success)]"
                      : "opacity-0 pointer-events-none",
                )}
                aria-live="polite"
              >
                {savingBotLocale ? (
                  <>
                    <Loader2 size={12} className="animate-spin" />
                    {s.settings.saving}
                  </>
                ) : (
                  <>
                    <CheckCircle size={12} />
                    {s.settings.saved}
                  </>
                )}
              </span>
            </div>
            <p className="text-xs text-[var(--color-text-tertiary)] -mt-1">
              {s.settings.botLanguageDescription}
            </p>
            <SegmentedControl
              options={[
                { value: "ko", label: "\ud55c\uad6d\uc5b4" },
                { value: "en", label: "English" },
              ]}
              value={botLocale}
              onChange={async (v) => {
                setBotLocale(v);
                setSavingBotLocale(true);
                setBotLocaleSaved(false);
                try {
                  await api.setBotLocale(v);
                  setBotLocaleSaved(true);
                  setTimeout(() => setBotLocaleSaved(false), 2000);
                } catch {
                } finally {
                  setSavingBotLocale(false);
                }
              }}
            />
          </div>

          {/* Default Volume */}
          <div className="rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)] p-4 flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-medium text-[var(--color-text)] flex items-center gap-2">
                <Volume2
                  size={16}
                  className="text-[var(--color-text-secondary)]"
                />
                {s.settings.defaultVolume}
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
                    {s.settings.saving}
                  </>
                ) : (
                  <>
                    <CheckCircle size={12} />
                    {s.settings.saved}
                  </>
                )}
              </span>
            </div>
            <p className="text-xs text-[var(--color-text-tertiary)] -mt-1">
              {s.settings.defaultVolumeDescription}
            </p>
            <div className="flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <span className="text-sm text-[var(--color-text-secondary)]">
                  {s.settings.volume}
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
                <Mic size={16} className="text-[var(--color-text-secondary)]" />
                {s.settings.defaultVoiceChannel}
                {voiceChannels.length > 0 && (
                  <span className="flex items-center gap-1 text-xs font-normal text-[var(--color-text-tertiary)]">
                    <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-success)] inline-block" />
                    {s.settings.available.replace(
                      "{n}",
                      String(voiceChannels.length),
                    )}
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
                    {s.settings.saving}
                  </>
                ) : (
                  <>
                    <CheckCircle size={12} />
                    {s.settings.saved}
                  </>
                )}
              </span>
            </div>

            <p className="text-xs text-[var(--color-text-tertiary)] -mt-1">
              {s.settings.defaultVoiceChannelDescription}
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
                  { value: "", label: s.settings.noneManualJoinOnly },
                  ...voiceChannels.map((ch) => ({
                    value: ch.id,
                    label: ch.name,
                  })),
                ]}
                placeholder={s.settings.noneManualJoinOnly}
              />
            ) : (
              <div className="flex items-center gap-2 py-1">
                <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-text-tertiary)] inline-block flex-shrink-0" />
                <p className="text-xs text-[var(--color-text-tertiary)]">
                  {s.settings.noVoiceChannels}
                </p>
              </div>
            )}
          </div>

          {/* yt-dlp */}
          <div className="rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)] p-4 flex flex-col gap-4">
            <h3 className="text-sm font-medium text-[var(--color-text)]">
              {s.settings.ytdlp}
            </h3>

            <div className="flex items-center justify-between">
              <span className="text-sm text-[var(--color-text-secondary)]">
                {s.settings.currentVersion}
              </span>
              <span className="font-mono text-sm text-[var(--color-text)]">
                {info?.current_version ?? s.settings.notInstalled}
              </span>
            </div>

            {info && !info.managed && info.current_version && (
              <p className="text-xs text-[var(--color-text-tertiary)]">
                {s.settings.usingSystemYtdlp}
              </p>
            )}

            <button
              onClick={handleCheck}
              disabled={checking}
              className="min-h-[44px] px-4 py-2 rounded-lg text-sm font-medium border border-[var(--color-border)] text-[var(--color-text-secondary)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-hover)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 cursor-pointer"
            >
              {checking && <Loader2 size={16} className="animate-spin" />}
              {s.settings.checkForUpdates}
            </button>

            {latest && (
              <div className="flex items-center justify-between">
                <span className="text-sm text-[var(--color-text-secondary)]">
                  {s.settings.latestVersion}
                </span>
                <span className="font-mono text-sm text-[var(--color-text)]">
                  {latest.latest_version}
                </span>
              </div>
            )}

            {latest &&
              (latest.update_available ? (
                <button
                  onClick={handleUpdate}
                  disabled={updating}
                  className="min-h-[44px] px-4 py-2 rounded-lg text-sm font-medium bg-[var(--color-accent)] text-[#1a1a1a] hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 cursor-pointer"
                >
                  {updating && <Loader2 size={16} className="animate-spin" />}
                  {s.settings.updateTo.replace(
                    "{version}",
                    latest.latest_version,
                  )}
                </button>
              ) : (
                <div className="flex items-center gap-2 text-sm text-[var(--color-success)]">
                  <CheckCircle size={16} />
                  {s.settings.upToDate}
                </div>
              ))}

            {adminError && (
              <div className="flex items-center gap-2 text-sm text-[var(--color-danger)]">
                <AlertCircle size={16} className="flex-shrink-0" />
                {adminError}
              </div>
            )}
          </div>

          {/* YouTube API */}
          <div className="rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)] p-4 flex flex-col gap-4">
            <h3 className="text-sm font-medium text-[var(--color-text)]">
              {s.settings.youtubeApi}
            </h3>

            <div className="flex items-center justify-between">
              <span className="text-sm text-[var(--color-text-secondary)]">
                {s.settings.apiKey}
              </span>
              <span className="font-mono text-sm text-[var(--color-text)]">
                {ytInfo?.has_key ? ytInfo.key_masked : s.settings.notSet}
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
                placeholder={s.settings.enterNewApiKey}
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
                    const s = t();
                    setYtError(
                      e instanceof Error ? e.message : s.toast.failedToSave,
                    );
                  } finally {
                    setSavingKey(false);
                  }
                }}
                disabled={savingKey || !newKey.trim()}
                className="min-h-[44px] px-4 py-2 rounded-lg text-sm font-medium bg-[var(--color-accent)] text-[#1a1a1a] hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2 cursor-pointer"
              >
                {savingKey && <Loader2 size={16} className="animate-spin" />}
                {s.settings.save}
              </button>
            </div>

            {keySaved && (
              <div className="flex items-center gap-2 text-sm text-[var(--color-success)]">
                <CheckCircle size={16} className="flex-shrink-0" />
                {s.settings.apiKeySaved}
              </div>
            )}

            {ytError && (
              <div className="flex items-center gap-2 text-sm text-[var(--color-danger)]">
                <AlertCircle size={16} className="flex-shrink-0" />
                {ytError}
              </div>
            )}
          </div>

          {/* History Channel */}
          <div className="rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)] p-4 flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-medium text-[var(--color-text)] flex items-center gap-2">
                <Hash
                  size={16}
                  className="text-[var(--color-text-secondary)]"
                />
                {s.settings.historyChannel}
                {textChannels.length > 0 && (
                  <span className="flex items-center gap-1 text-xs font-normal text-[var(--color-text-tertiary)]">
                    <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-success)] inline-block" />
                    {s.settings.available.replace(
                      "{n}",
                      String(textChannels.length),
                    )}
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
                    {s.settings.saving}
                  </>
                ) : (
                  <>
                    <CheckCircle size={12} />
                    {s.settings.saved}
                  </>
                )}
              </span>
            </div>

            <p className="text-xs text-[var(--color-text-tertiary)] -mt-1">
              {s.settings.historyChannelDescription}
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
                  { value: "", label: s.settings.noneDisabled },
                  ...textChannels.map((ch) => ({
                    value: ch.id,
                    label: ch.name,
                    prefix: "#",
                  })),
                ]}
                placeholder={s.settings.noneDisabled}
              />
            ) : (
              <div className="flex items-center gap-2 py-1">
                <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-text-tertiary)] inline-block flex-shrink-0" />
                <p className="text-xs text-[var(--color-text-tertiary)]">
                  {s.settings.noTextChannels}
                </p>
              </div>
            )}
          </div>

          {/* Timezone */}
          <div className="rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)] p-4 flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-medium text-[var(--color-text)] flex items-center gap-2">
                <Globe
                  size={16}
                  className="text-[var(--color-text-secondary)]"
                />
                {s.settings.timezone}
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
                    {s.settings.saving}
                  </>
                ) : (
                  <>
                    <CheckCircle size={12} />
                    {s.settings.saved}
                  </>
                )}
              </span>
            </div>

            <p className="text-xs text-[var(--color-text-tertiary)] -mt-1">
              {s.settings.timezoneDescription}
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
        </section>
      )}
    </div>
  );
}
