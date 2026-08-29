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
  opts: { title?: string; apiKey?: string; language?: string } = {},
): Promise<HereNowPublishResult> {
  const mp4 = await readFile(mp4Path);
  const title = opts.title || "MP4 Video";
  const safeTitle = title.replace(/[<>&"]/g, "");
  
  let tapText = '🔊 Tap for Sound';
  let dlText = 'Download Video';
  const lang = (opts.language || 'English').toLowerCase();
  if (lang === 'chinese') { tapText = '🔊 点击开启声音'; dlText = '下载视频'; }
  else if (lang === 'spanish') { tapText = '🔊 Toca para escuchar'; dlText = 'Descargar Video'; }
  else if (lang === 'french') { tapText = '🔊 Toucher pour le son'; dlText = 'Télécharger la vidéo'; }
  else if (lang === 'german') { tapText = '🔊 Tippen für Ton'; dlText = 'Video herunterladen'; }
  else if (lang === 'japanese') { tapText = '🔊 タップして音声をオン'; dlText = '動画をダウンロード'; }
  else if (lang === 'korean') { tapText = '🔊 탭하여 소리 켜기'; dlText = '동영상 다운로드'; }
  else if (lang === 'portuguese') { tapText = '🔊 Toque para ouvir'; dlText = 'Baixar Vídeo'; }
  else if (lang === 'russian') { tapText = '🔊 Нажмите для звука'; dlText = 'Скачать видео'; }

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
  html,body{margin:0;background:#000;height:100%;display:flex;align-items:center;justify-content:center;overflow:hidden;font-family:sans-serif;}
  body{padding:12px;box-sizing:border-box}
  .video-container { position: relative; max-width: 100%; max-height: 92vh; border-radius: 18px; box-shadow: 0 12px 40px rgba(0,0,0,.5); overflow: hidden; background:#111; }
  video{ width: 100%; height: 100%; display: block; }
  
  .overlay { 
    position: absolute; inset: 0; background: rgba(0,0,0,0.4); display: flex; 
    align-items: center; justify-content: center; opacity: 0; transition: opacity 0.2s ease;
    pointer-events: none; z-index: 10;
  }
  .overlay.active { opacity: 1; pointer-events: auto; }
  
  .download-btn {
    background: #fff; color: #000; text-decoration: none; padding: 14px 28px; 
    border-radius: 30px; font-weight: bold; font-size: 16px;
    box-shadow: 0 4px 15px rgba(0,0,0,0.3); transform: translateY(10px);
    transition: transform 0.2s ease, background 0.2s ease;
  }
  .overlay.active .download-btn { transform: translateY(0); }
  .download-btn:active { background: #eee; transform: scale(0.96); }

  .sound-btn {
    position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
    background: rgba(0,0,0,0.5); color: #fff; font-size: 1.2rem; font-weight: bold; cursor: pointer;
    z-index: 20; transition: opacity 0.3s;
  }
</style>
<body>
<div class="video-container" id="vc">
  <div class="sound-btn" id="soundBtn">${tapText}</div>
  <video src="ralph.mp4" poster="poster.jpg" playsinline loop muted autoplay></video>
  <div class="overlay" id="overlay">
    <a href="ralph.mp4" download class="download-btn" id="dl">${dlText}</a>
  </div>
</div>
<script>
  const vc = document.getElementById('vc');
  const overlay = document.getElementById('overlay');
  const vid = vc.querySelector('video');
  const soundBtn = document.getElementById('soundBtn');
  
  let hasInteracted = false;

  // Unmute and hide sound button on first tap
  soundBtn.addEventListener('click', (e) => {
    e.stopPropagation(); // prevent toggling the download overlay immediately
    vid.muted = false;
    vid.play();
    soundBtn.style.opacity = '0';
    setTimeout(() => soundBtn.style.display = 'none', 300);
    hasInteracted = true;
    vid.controls = true; // reveal native controls after they unlock audio
  });
  
  // Toggle overlay on subsequent clicks (only if unlocked via ?dl=1)
  vc.addEventListener('click', (e) => {
    if (!hasInteracted) return;
    if (e.target.id === 'dl') return;
    const params = new URLSearchParams(window.location.search);
    if (!params.has('dl') && !params.has('download')) return;
    overlay.classList.toggle('active');
  });
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
