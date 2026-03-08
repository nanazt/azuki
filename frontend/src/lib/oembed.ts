import { api } from "./api";

export interface OEmbedResult {
  title: string;
  thumbnailUrl: string;
  duration?: string;
  provider: string;
}

export async function fetchOEmbed(url: string): Promise<OEmbedResult | null> {
  try {
    const data = await api.fetchOEmbed(url);
    if (!data || !data.title) return null;

    const provider = data.provider_name || guessProvider(url);
    const thumbnailUrl = data.thumbnail_url || "";

    return {
      title: data.title,
      thumbnailUrl,
      provider,
    };
  } catch {
    return null;
  }
}

function guessProvider(url: string): string {
  try {
    const host = new URL(url).hostname;
    if (host.includes("youtube") || host.includes("youtu.be")) return "YouTube";
    if (host.includes("soundcloud")) return "SoundCloud";
    return host;
  } catch {
    return "";
  }
}

export function isSupportedOEmbedUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return (
      host.includes("youtube.com") ||
      host.includes("youtu.be") ||
      host.includes("soundcloud.com")
    );
  } catch {
    return false;
  }
}
