import { useEffect, useState } from "react";
import { Eye, EyeOff, RefreshCw, Loader2 } from "lucide-react";
import { useLocale, t } from "../hooks/useLocale";

interface SetupInfo {
  default_redirect_uri: string;
  is_reconfigure: boolean;
}

interface SetupConfig {
  discord_client_id: string;
  discord_guild_id: string;
  discord_redirect_uri: string;
  discord_token: string;
  discord_client_secret: string;
  jwt_secret: string;
  youtube_api_key: string | null;
}

function PasswordField({
  name,
  value,
  onChange,
  placeholder,
  masked,
}: {
  name: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  masked?: string;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="relative flex">
      <input
        type={visible ? "text" : "password"}
        name={name}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={masked || placeholder}
        autoComplete="off"
        className="w-full rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] px-3 py-2.5 text-sm text-[var(--color-text)] placeholder:text-[var(--color-text-tertiary)] outline-none focus:border-[var(--color-accent)] transition-colors"
      />
      <button
        type="button"
        tabIndex={-1}
        onClick={() => setVisible(!visible)}
        className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)] transition-colors p-1"
      >
        {visible ? <EyeOff size={16} /> : <Eye size={16} />}
      </button>
    </div>
  );
}

export function Setup() {
  useLocale();
  const s = t();

  const [info, setInfo] = useState<SetupInfo | null>(null);
  const [config, setConfig] = useState<SetupConfig | null>(null);

  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [redirectUri, setRedirectUri] = useState("");
  const [discordToken, setDiscordToken] = useState("");
  const [guildId, setGuildId] = useState("");
  const [jwtSecret, setJwtSecret] = useState("");
  const [youtubeApiKey, setYoutubeApiKey] = useState("");
  const [setupToken, setSetupToken] = useState("");

  const [submitting, setSubmitting] = useState(false);
  const [status, setStatus] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);

  // Fetch setup info on mount
  useEffect(() => {
    fetch("/setup/info")
      .then((r) => r.json())
      .then((data: SetupInfo) => {
        setInfo(data);
        setRedirectUri(data.default_redirect_uri);

        // If reconfigure mode, fetch existing config
        if (data.is_reconfigure) {
          fetch("/setup/config")
            .then((r) => r.json())
            .then((cfg: SetupConfig) => {
              setConfig(cfg);
              setClientId(cfg.discord_client_id);
              setGuildId(cfg.discord_guild_id);
              setRedirectUri(cfg.discord_redirect_uri);
            })
            .catch(() => {});
        }
      })
      .catch(() => {});
  }, []);

  const generateSecret = () => {
    const arr = new Uint8Array(32);
    crypto.getRandomValues(arr);
    const hex = Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join(
      "",
    );
    setJwtSecret(hex);
  };

  const handleClearYoutubeKey = () => {
    setYoutubeApiKey("CLEAR");
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setStatus(null);

    try {
      const res = await fetch("/setup/submit", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Requested-With": "XMLHttpRequest",
        },
        body: JSON.stringify({
          discord_token: discordToken,
          guild_id: guildId,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
          jwt_secret: jwtSecret,
          setup_token: setupToken,
          youtube_api_key: youtubeApiKey || null,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        setStatus({ type: "error", message: data.error || "Setup failed" });
        setSubmitting(false);
        return;
      }

      setStatus({ type: "success", message: s.setup.starting });

      // Wait 5 seconds for server to transition, then redirect
      setTimeout(() => {
        window.location.href = "/";
      }, 5000);
    } catch {
      setStatus({ type: "error", message: s.setup.connectionError });
      setSubmitting(false);
    }
  };

  const isReconfigure = info?.is_reconfigure ?? false;

  return (
    <div className="h-dvh overflow-y-auto px-4 py-8 bg-[var(--color-bg)]">
      <div className="mx-auto w-full max-w-md">
        <div className="rounded-2xl p-6 sm:p-8 bg-[var(--color-bg-secondary)] border border-[var(--color-border)]">
          {/* Header */}
          <div className="flex flex-col items-center gap-2 mb-6">
            <img
              src="/favicon.svg"
              alt="azuki"
              className="w-14 h-14 rounded-2xl select-none"
              draggable={false}
            />
            <h1 className="text-xl font-bold text-[var(--color-text)] tracking-tight">
              {isReconfigure ? s.setup.titleReconfigure : s.setup.title}
            </h1>
            <p className="text-sm text-[var(--color-text-tertiary)] text-center">
              {isReconfigure ? s.setup.subtitleReconfigure : s.setup.subtitle}
            </p>
          </div>

          <form onSubmit={handleSubmit} className="flex flex-col gap-5">
            {/* Discord Credentials */}
            <section>
              <h2 className="text-xs font-semibold text-[var(--color-text-tertiary)] uppercase tracking-wider mb-3">
                {s.setup.sectionDiscord}
              </h2>
              <div className="flex flex-col gap-3">
                <label className="flex flex-col gap-1">
                  <span className="text-xs text-[var(--color-text-secondary)] font-mono">
                    DISCORD_CLIENT_ID
                  </span>
                  <input
                    type="text"
                    value={clientId}
                    onChange={(e) => setClientId(e.target.value)}
                    placeholder={s.setup.placeholderClientId}
                    autoComplete="off"
                    className="w-full rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] px-3 py-2.5 text-sm text-[var(--color-text)] placeholder:text-[var(--color-text-tertiary)] outline-none focus:border-[var(--color-accent)] transition-colors"
                  />
                </label>

                <label className="flex flex-col gap-1">
                  <span className="text-xs text-[var(--color-text-secondary)] font-mono">
                    DISCORD_CLIENT_SECRET
                  </span>
                  <PasswordField
                    name="client_secret"
                    value={clientSecret}
                    onChange={setClientSecret}
                    placeholder={s.setup.placeholderClientSecret}
                    masked={
                      isReconfigure && !clientSecret
                        ? config?.discord_client_secret
                        : undefined
                    }
                  />
                </label>

                <label className="flex flex-col gap-1">
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-[var(--color-text-secondary)] font-mono">
                      DISCORD_REDIRECT_URI
                    </span>
                    {redirectUri === info?.default_redirect_uri && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--color-accent)]/15 text-[var(--color-accent)] font-medium">
                        auto-filled
                      </span>
                    )}
                  </div>
                  <input
                    type="text"
                    value={redirectUri}
                    onChange={(e) => setRedirectUri(e.target.value)}
                    autoComplete="off"
                    className="w-full rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] px-3 py-2.5 text-sm text-[var(--color-text)] placeholder:text-[var(--color-text-tertiary)] outline-none focus:border-[var(--color-accent)] transition-colors"
                  />
                </label>

                <label className="flex flex-col gap-1">
                  <span className="text-xs text-[var(--color-text-secondary)] font-mono">
                    DISCORD_TOKEN
                  </span>
                  <PasswordField
                    name="discord_token"
                    value={discordToken}
                    onChange={setDiscordToken}
                    placeholder={s.setup.placeholderToken}
                    masked={
                      isReconfigure && !discordToken
                        ? config?.discord_token
                        : undefined
                    }
                  />
                </label>

                <label className="flex flex-col gap-1">
                  <span className="text-xs text-[var(--color-text-secondary)] font-mono">
                    DISCORD_GUILD_ID
                  </span>
                  <input
                    type="text"
                    value={guildId}
                    onChange={(e) => setGuildId(e.target.value)}
                    placeholder={s.setup.placeholderGuildId}
                    autoComplete="off"
                    className="w-full rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] px-3 py-2.5 text-sm text-[var(--color-text)] placeholder:text-[var(--color-text-tertiary)] outline-none focus:border-[var(--color-accent)] transition-colors"
                  />
                </label>
              </div>
            </section>

            {/* Session Security */}
            <section>
              <h2 className="text-xs font-semibold text-[var(--color-text-tertiary)] uppercase tracking-wider mb-3">
                {s.setup.sectionSecurity}
              </h2>
              <label className="flex flex-col gap-1">
                <span className="text-xs text-[var(--color-text-secondary)] font-mono">
                  JWT_SECRET
                </span>
                <div className="flex gap-2">
                  <div className="flex-1">
                    <PasswordField
                      name="jwt_secret"
                      value={jwtSecret}
                      onChange={setJwtSecret}
                      placeholder={s.setup.placeholderJwtSecret}
                      masked={
                        isReconfigure && !jwtSecret
                          ? config?.jwt_secret
                          : undefined
                      }
                    />
                  </div>
                  <button
                    type="button"
                    onClick={generateSecret}
                    className="flex items-center gap-1.5 px-3 rounded-lg border border-[var(--color-border)] text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] transition-colors whitespace-nowrap"
                  >
                    <RefreshCw size={14} />
                    {s.setup.generate}
                  </button>
                </div>
              </label>
            </section>

            {/* YouTube API (Optional) */}
            <section>
              <h2 className="text-xs font-semibold text-[var(--color-text-tertiary)] uppercase tracking-wider mb-3">
                {s.setup.sectionYoutube}
              </h2>
              <label className="flex flex-col gap-1">
                <span className="text-xs text-[var(--color-text-secondary)] font-mono">
                  YOUTUBE_API_KEY
                </span>
                <div className="flex gap-2">
                  <div className="flex-1">
                    <PasswordField
                      name="youtube_api_key"
                      value={youtubeApiKey === "CLEAR" ? "" : youtubeApiKey}
                      onChange={(v) => setYoutubeApiKey(v)}
                      placeholder={s.setup.placeholderYoutubeKey}
                      masked={
                        isReconfigure &&
                        !youtubeApiKey &&
                        config?.youtube_api_key
                          ? config.youtube_api_key
                          : undefined
                      }
                    />
                  </div>
                  {isReconfigure && config?.youtube_api_key && (
                    <button
                      type="button"
                      onClick={handleClearYoutubeKey}
                      className="px-3 rounded-lg border border-red-400/30 text-xs text-red-400 hover:bg-red-400/10 transition-colors whitespace-nowrap"
                    >
                      {s.setup.remove}
                    </button>
                  )}
                </div>
                {youtubeApiKey === "CLEAR" && (
                  <p className="text-xs text-red-400 mt-1">
                    {s.setup.youtubeKeyWillBeRemoved}
                  </p>
                )}
              </label>
            </section>

            {/* Setup Token */}
            <div className="border-t border-[var(--color-border)] pt-4">
              <label className="flex flex-col gap-1">
                <span className="text-xs text-[var(--color-text-secondary)] font-mono">
                  {s.setup.setupTokenLabel}
                </span>
                <input
                  type="text"
                  value={setupToken}
                  onChange={(e) => setSetupToken(e.target.value)}
                  placeholder={s.setup.placeholderSetupToken}
                  autoComplete="off"
                  className="w-full rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] px-3 py-2.5 text-sm font-mono text-[var(--color-text)] placeholder:text-[var(--color-text-tertiary)] outline-none focus:border-[var(--color-accent)] transition-colors"
                />
              </label>
            </div>

            {/* Reconfigure hint */}
            {isReconfigure && (
              <p className="text-xs text-[var(--color-text-tertiary)] text-center">
                {s.setup.reconfigureHint}
              </p>
            )}

            {/* Submit */}
            <button
              type="submit"
              disabled={submitting}
              className="w-full py-3 rounded-xl font-semibold text-sm bg-[var(--color-accent)] text-[#1a1a1a] hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-opacity"
            >
              {submitting ? (
                <span className="flex items-center justify-center gap-2">
                  <Loader2 size={16} className="animate-spin" />
                  {s.setup.saving}
                </span>
              ) : isReconfigure ? (
                s.setup.submitReconfigure
              ) : (
                s.setup.submit
              )}
            </button>

            {/* Status message */}
            {status && (
              <div
                className={`text-sm text-center rounded-lg px-4 py-2 ${
                  status.type === "error"
                    ? "text-red-400 bg-red-400/10 border border-red-400/20"
                    : "text-emerald-400 bg-emerald-400/10 border border-emerald-400/20"
                }`}
              >
                {status.type === "success" && (
                  <Loader2
                    size={14}
                    className="inline-block animate-spin mr-2 align-text-bottom"
                  />
                )}
                {status.message}
              </div>
            )}
          </form>
        </div>
      </div>
    </div>
  );
}
