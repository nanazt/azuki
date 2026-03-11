export function isHttpUrl(text: string): boolean {
  try {
    return new URL(text).protocol.startsWith("http");
  } catch {
    return false;
  }
}
