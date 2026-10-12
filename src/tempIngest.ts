/**
 * Publish a finished MP4 to the bot's P&R-hosted temp-page ingest
 * (bot/src/lib/temp-publish/ingest.ts) instead of here.now.
 *
 * Active only when TEMP_PUBLISH_INGEST_URL (e.g. https://<bot>/internal/temp-publish)
 * and TEMP_PUBLISH_INGEST_SECRET are both set. Returns null on any failure so the
 * caller can fall back to here.now (no user-visible outage during migration).
 */
import { createHmac } from "crypto";

export interface TempIngestResult {
  url: string;
  slug: string | null;
  authMode: "anonymous";
}

export function tempIngestConfigured(): boolean {
  return Boolean(process.env["TEMP_PUBLISH_INGEST_URL"] && process.env["TEMP_PUBLISH_INGEST_SECRET"]);
}

export async function publishViaBotIngest(mp4: Uint8Array, title?: string): Promise<TempIngestResult | null> {
  const url = process.env["TEMP_PUBLISH_INGEST_URL"];
  const secret = process.env["TEMP_PUBLISH_INGEST_SECRET"];
  if (!url || !secret) return null;
  try {
    const body = Buffer.from(mp4.buffer, mp4.byteOffset, mp4.byteLength);
    const sig = createHmac("sha256", secret).update(body).digest("hex");
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "video/mp4",
        "X-Publish-Signature": sig,
        "X-Title": encodeURIComponent((title || "").slice(0, 200)),
      },
      body: new Uint8Array(body),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) throw new Error(`ingest returned ${res.status}`);
    const json = (await res.json()) as { id?: string; url?: string };
    if (!json.url) throw new Error("ingest returned no url");
    return { url: json.url, slug: json.id ?? null, authMode: "anonymous" };
  } catch (err) {
    console.warn("[temp-publish] bot ingest failed, falling back to here.now:", (err as Error).message);
    return null;
  }
}
