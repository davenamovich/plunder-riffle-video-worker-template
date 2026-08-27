/**
 * here.now publisher for the video worker — mirrors packages/render-worker
 * src/herenow.ts (and bot/src/lib/herenow.ts).
 *
 * Finished MP4s are published to here.now so the bot can hand the user a
 * single durable shareable link instead of a transient Railway /download URL.
 * A minimal player page (index.html + ralph.mp4) wraps the video; the raw MP4
 * stays directly downloadable at <url>/ralph.mp4 for inline Telegram playback.
 *
 * Auth: anonymous by default (page expires in ~24h). When the job carries the
 * user's own here.now API key it is published authenticated (stays alive).
 *
 * Three-step flow:
 *   1. POST /api/v1/publish  — declare files, get upload instructions
 *   2. PUT  <signed-url>     — upload each file directly
 *   3. POST <finalizeUrl>    — finalize the version → live URL
 */
import { readFile } from "fs/promises";

const HERENOW_API = "https://here.now/api/v1";

export interface HereNowPublishResult {
  url: string;
  slug: string | null;
  authMode: "anonymous" | "authenticated";
}

interface HereNowFile {
  path: string;
  contentType: string;
  data: Uint8Array;
}

async function publishToHereNow(
  files: HereNowFile[],
  apiKey?: string,
): Promise<HereNowPublishResult> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-HereNow-Client": "PlunderAndRiffle/video-worker/1.0",
  };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

  // ── Step 1: Create site ──
  const createRes = await fetch(`${HERENOW_API}/publish`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      files: files.map((f) => ({
        path: f.path,
        size: f.data.length,
        contentType: f.contentType,
      })),
    }),
  });
  if (!createRes.ok) {
    const text = await createRes.text().catch(() => "");
    throw new Error(`here.now create failed (${createRes.status}): ${text.slice(0, 300)}`);
  }
  const createData = (await createRes.json()) as {
    siteUrl?: string;
    slug?: string;
    anonymous?: boolean;
    upload: {
      versionId: string;
      finalizeUrl: string;
      uploads: Array<{ path: string; url: string }>;
    };
  };
  const { upload, siteUrl, slug, anonymous } = createData;

  // ── Step 2: Upload files ──
  const byPath = new Map(files.map((f) => [f.path, f]));
  for (const instruction of upload.uploads) {
    const file = byPath.get(instruction.path);
    if (!file) continue;
    const uploadRes = await fetch(instruction.url, {
      method: "PUT",
      headers: { "Content-Type": file.contentType },
      body: new Uint8Array(file.data),
    });
    if (!uploadRes.ok) {
      const text = await uploadRes.text().catch(() => "");
      throw new Error(`here.now upload failed (${uploadRes.status}): ${text.slice(0, 300)}`);
    }
  }

  // ── Step 3: Finalize ──
  const finalizeHeaders: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) finalizeHeaders["Authorization"] = `Bearer ${apiKey}`;
  const finalizeRes = await fetch(upload.finalizeUrl, {
    method: "POST",
    headers: finalizeHeaders,
    body: JSON.stringify({ versionId: upload.versionId }),
  });
  if (!finalizeRes.ok) {
    const text = await finalizeRes.text().catch(() => "");
    throw new Error(`here.now finalize failed (${finalizeRes.status}): ${text.slice(0, 300)}`);
  }

  const finalUrl = siteUrl || (slug ? `https://${slug}.here.now/` : null);
  if (!finalUrl) throw new Error("here.now publish succeeded but no URL was returned.");

  return {
    url: finalUrl,
    slug: slug ?? null,
    authMode: anonymous ? "anonymous" : "authenticated",
  };
}

/**
 * Wrap a rendered MP4 (on disk) in a here.now player page. Returns the live
 * page URL. The video bytes are read once and streamed straight to here.now —
 * nothing is written to object storage.
 */
export async function publishMp4ToHereNow(
  mp4Path: string,
  opts: { title?: string; apiKey?: string } = {},
): Promise<HereNowPublishResult> {
  const mp4 = await readFile(mp4Path);
  const title = opts.title || "MP4 Video";
  const safeTitle = title.replace(/[<>&"]/g, "");
  // The page URL isn't known until after publish, so we use a relative path for
  // og:video. Telegram's crawler resolves relative URLs from the page origin.
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${safeTitle}</title>
<meta property="og:type" content="video.other">
<meta property="og:title" content="${safeTitle}">
<meta property="og:description" content="Watch on here.now">
<meta property="og:video" content="ralph.mp4">
<meta property="og:video:type" content="video/mp4">
<meta property="og:video:width" content="1080">
<meta property="og:video:height" content="1920">
<meta property="og:image" content="poster.jpg">
<meta name="twitter:card" content="player">
<meta name="twitter:title" content="${safeTitle}">
<meta name="twitter:player:width" content="1080">
<meta name="twitter:player:height" content="1920">
<style>
  html,body{margin:0;background:#000;height:100%;display:flex;align-items:center;justify-content:center}
  body{padding:12px;box-sizing:border-box}
  video{max-width:100%;max-height:92vh;border-radius:18px;background:#111;box-shadow:0 12px 40px rgba(0,0,0,.5)}
</style>
</head>
<body>
<video src="ralph.mp4" poster="poster.jpg" controls autoplay muted loop playsinline></video>
<script>
  // Unmute after the first user interaction so autoplay works everywhere.
  const v = document.querySelector('video');
  document.addEventListener('click', () => { v.muted = false; }, { once: true });
</script>
</body>
</html>`;

  return publishToHereNow(
    [
      { path: "index.html", contentType: "text/html", data: new TextEncoder().encode(html) },
      { path: "ralph.mp4", contentType: "video/mp4", data: new Uint8Array(mp4) },
    ],
    opts.apiKey,
  );
}

/** The direct-download MP4 URL for a published here.now player page. */
export function mediaUrlFor(pageUrl: string): string {
  return pageUrl.replace(/\/+$/, "") + "/ralph.mp4";
}
