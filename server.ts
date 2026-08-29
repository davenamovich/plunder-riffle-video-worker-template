import express from "express";
import {
  startRecordingJob,
  getJob,
  deleteJob,
  recorderDiagnostics,
  getRenderQueueStatus,
  resolveChromium,
  collectPageInfo,
  type RecordOptions,
} from "./src/recorder";
import path from "path";
import fs from "fs";
import { publishMp4ToHereNow, mediaUrlFor } from "./src/herenow";

function isValidPublicUrl(u: string): boolean {
  try {
    if (u.length > 2048) return false;
    const parsed = new URL(u);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    const host = parsed.hostname.toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return false;
    if (host.startsWith('192.168.') || host.startsWith('10.') || host.match(/^172\.(1[6-9]|2[0-9]|3[0-1])\./)) return false;
    if (host === '169.254.169.254') return false;
    if (host.endsWith('.internal') || host.endsWith('.railway.internal')) return false;
    return true;
  } catch {
    return false;
  }
}

const app = express();
app.use(express.json({ limit: "100mb" }));

// ── here.now publish-on-completion ───────────────────────────────────────────
// Finished renders are published to here.now so the bot hands the user a
// durable link instead of a transient Railway /download URL. The publish
// state lives HERE (server layer), not in the engine — src/recorder.ts is
// sync-guarded against bot/src/lib/video/recorder.ts and must stay untouched.
//
// The bot forwards its own here.now API key (or the user's) in the POST body;
// per-job keys are kept in `herenowKeys`. Without any key the publish is
// anonymous (page expires ~24h) — the worker's HERENOW_API_KEY env var is
// the fallback for authenticated (permanent) publishes.
const herenowKeys = new Map<string, string>(); // jobId → here.now API key from the render request
const herenowLanguages = new Map<string, string>(); // jobId → language from the render request
const publishState = new Map<string, { started: boolean; url?: string }>();

/**
 * Publish a finished job's MP4 to here.now exactly once. Await it before
 * responding to a status poll so the durable link is ready in the response.
 * Safe to call from every status poll: in-flight publishes are skipped, and
 * a failed publish clears `started` so the next poll retries.
 */
async function ensurePublished(jobId: string): Promise<void> {
  const st = publishState.get(jobId);
  if (st?.url || st?.started) return;
  const job = getJob(jobId);
  if (!job || job.status !== "done" || !job.result?.mp4Path) return;
  publishState.set(jobId, { started: true });
  try {
    const apiKey = herenowKeys.get(jobId) || process.env["HERENOW_API_KEY"] || undefined;
    const language = herenowLanguages.get(jobId);
    const res = await publishMp4ToHereNow(job.result.mp4Path, { apiKey, language });
    // The job may have been deleted mid-publish — don't re-add a stale entry.
    if (!getJob(jobId)) {
      console.log(`[worker] published ${jobId} to here.now but job was deleted: ${res.url}`);
      herenowKeys.delete(jobId);
      herenowLanguages.delete(jobId);
      return;
    }
    publishState.set(jobId, { started: false, url: res.url });
    herenowKeys.delete(jobId);
    herenowLanguages.delete(jobId);
    console.log(`[worker] published ${jobId} to here.now: ${res.url} (${res.authMode})`);
  } catch (err) {
    console.error(`[worker] here.now publish failed for ${jobId}:`, (err as Error).message);
    publishState.delete(jobId); // retry on the next status poll
  }
}

// ── Auth guard ──────────────────────────────────────────────────────────────
// The bot sends `x-operator-secret: <TELEGRAM_WEBHOOK_SECRET>` on every render
// request (bot/src/lib/recorder.ts externalAuthHeaders). Setting WORKER_SECRET
// to that same value locks the render-control routes to the bot. Download and
// thumbnail stay open: job ids are unguessable UUIDs and the bot's MP4 fetch
// (fetchMp4Buffer) carries no headers, so guarding them would 401 every render.
const workerSecret = process.env["WORKER_SECRET"] || "";
function requireSecret(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): void {
  if (!workerSecret) return next();
  if (req.get("x-operator-secret") === workerSecret) return next();
  res.status(401).json({ error: "Missing or invalid x-operator-secret" });
}

// Expose the recordings directory so direct file access still works
app.use("/download/recordings", express.static(path.join(process.cwd(), "download/recordings")));

// Start a recording job. Accepts the full record payload the bot sends
// (url, autoDuration, viewport, aspectRatio, background, waitUntil,
// extraWaitMs, songUrl) and forwards it to the engine.
app.post("/api/record", requireSecret, async (req, res) => {
  try {
    const { url } = req.body;
    if (!url || typeof url !== "string") {
      return res.status(400).json({ error: "Missing 'url' parameter" });
    }
    if (!isValidPublicUrl(url)) {
      return res.status(400).json({ error: "Invalid, internal, or unsupported URL" });
    }
    const opts: RecordOptions = {
      url,
      durationMs: typeof req.body.durationMs === "number" ? req.body.durationMs : undefined,
      autoDuration: req.body.autoDuration !== false,
      viewport: req.body.viewport,
      aspectRatio: req.body.aspectRatio,
      background: req.body.background,
      waitUntil: req.body.waitUntil,
      extraWaitMs: req.body.extraWaitMs,
      songUrl: req.body.songUrl,
      primaryAudioRole: req.body?.primaryAudioRole === "narration" ? "narration" : "music",
      musicUrl: typeof req.body?.musicUrl === "string" ? req.body.musicUrl : undefined,
      outWidth: typeof req.body?.outWidth === "number" ? req.body.outWidth : undefined,
      outHeight: typeof req.body?.outHeight === "number" ? req.body.outHeight : undefined,
      audioVolume: typeof req.body?.audioVolume === "number" ? req.body.audioVolume : undefined,
      musicVolume: typeof req.body?.musicVolume === "number" ? req.body.musicVolume : undefined,
      timeoutMs: typeof req.body?.timeoutMs === "number" ? req.body.timeoutMs : undefined,
    };
    console.log(`[worker] Starting recording for ${url}`);
    const job = await startRecordingJob(opts);
    if (typeof req.body?.herenowApiKey === "string" && req.body.herenowApiKey.trim()) {
      herenowKeys.set(job.id, req.body.herenowApiKey.trim());
    }
    if (typeof req.body?.language === "string" && req.body.language.trim()) {
      herenowLanguages.set(job.id, req.body.language.trim());
    }
    // Both shapes the bot's client accepts (data.job.id / data.id).
    res.json({ id: job.id, job });
  } catch (error) {
    console.error("[worker] Error starting job:", error);
    res.status(500).json({ error: (error as Error).message });
  }
});

// Check job status — returns the JobRecord the bot's client reads straight
// off the body (status/message/error/result).
app.get("/api/record/:id", requireSecret, async (req, res) => {
  const job = getJob(req.params.id);
  if (!job) {
    return res.status(404).json({ error: "Job not found" });
  }
  const payload: any = { ...job };
  if (job.status === "done" && job.result) {
    const host = req.get("host");
    const protocol = req.protocol;
    payload.result = { ...job.result };
    payload.result.mp4Url = `${protocol}://${host}/api/record/${job.id}/download`;
    payload.result.thumbnailUrl = payload.result.thumbnailPath
      ? `${protocol}://${host}/api/record/${job.id}/thumbnail`
      : undefined;
    // Publish to here.now and wait for it so the durable link is ready in
    // THIS response — the bot returns on its first done poll, so a fire-and-
    // forget publish would always lose that race and the bot would re-publish
    // from its own side (double upload). Idempotent: later polls short-circuit
    // on the stored URL. The bot's recorder client reads data.result.url as
    // hereNowUrl and prefers it over the transient /download URL.
    await ensurePublished(job.id);
    const url = publishState.get(job.id)?.url;
    if (url) {
      payload.result.url = url;
      payload.result.mediaUrl = mediaUrlFor(url);
    }
  }
  res.json(payload);
});

// Download the finished MP4. The bot's external client constructs this exact
// URL (`${endpoint}/${jobId}/download`) and fetches it with no headers.
app.get("/api/record/:id/download", (req, res) => {
  const job = getJob(req.params.id);
  if (!job || job.status !== "done" || !job.result?.mp4Path) {
    return res.status(404).json({ error: "Recording not found" });
  }
  if (!fs.existsSync(job.result.mp4Path)) {
    return res.status(404).json({ error: "Recording file missing" });
  }
  res.download(job.result.mp4Path, `${job.id}.mp4`);
});

// Download the finished JPEG thumbnail.
app.get("/api/record/:id/thumbnail", (req, res) => {
  const job = getJob(req.params.id);
  if (!job || job.status !== "done" || !job.result?.thumbnailPath) {
    return res.status(404).json({ error: "Thumbnail not found" });
  }
  if (!fs.existsSync(job.result.thumbnailPath)) {
    return res.status(404).json({ error: "Thumbnail file missing" });
  }
  res.sendFile(job.result.thumbnailPath);
});

// Delete a job (frees its MP4/thumbnail files).
app.delete("/api/record/:id", requireSecret, async (req, res) => {
  try {
    await deleteJob(req.params.id);
    // Job is gone — drop its here.now publish state and per-job API key so
    // the maps don't accumulate entries for transient jobs.
    publishState.delete(req.params.id);
    herenowKeys.delete(req.params.id);
    herenowLanguages.delete(req.params.id);
    res.json({ success: true });
  } catch (error) {
    console.error("[worker] Error deleting job:", error);
    res.status(500).json({ error: (error as Error).message });
  }
});

// ── POST /api/stills — capture vessel page beats as base64 PNG frames ─────
// The bot's /slides carousel path calls this when the bot container has no
// local Chromium. This worker HAS Chromium and already drives vessel pages
// beat-by-beat for MP4 recording — the same pipeline screenshots each beat
// and returns the frames as base64 data URLs, no disk writes.
app.post("/api/stills", requireSecret, async (req, res) => {
  try {
    const url = typeof req.body?.url === "string" ? req.body.url.trim() : "";
    if (!url) return res.status(400).json({ error: "url is required" });
    if (!/^https?:\/\//i.test(url)) return res.status(400).json({ error: "url must be a public http(s) URL" });

    const { chromium, devices } = await import("playwright-core");
    const vp = { width: 540, height: 960 };
    const browser = await chromium.launch({
      headless: true,
      executablePath: resolveChromium(),
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
    });
    try {
      const ctx = await browser.newContext({
        ...devices["iPhone 14"],
        viewport: vp,
        deviceScaleFactor: 2,
        reducedMotion: "reduce" as const,
      });
      const page = await ctx.newPage();
      const pageUrl = new URL(url);
      pageUrl.searchParams.set("mode", "frame");
      await page.goto(pageUrl.toString(), { waitUntil: "load", timeout: 30_000 }).catch(() => {});
      await page.evaluate(() => (document as any).fonts?.ready).catch(() => {});
      await page.waitForFunction(() => (window as any).__vessel?.ready === true, { timeout: 10_000 }).catch(() => {});

      const pageInfo = await collectPageInfo(page);
      if (pageInfo.beatCount < 1) {
        return res.status(422).json({ error: "No beats found on page — not a vessel slideshow" });
      }
      const msgCount = pageInfo.hasLanding
        ? Math.max(0, pageInfo.vesselBeatCount - pageInfo.beatCount - 1)
        : 0;
      const ctaFrame = pageInfo.beatCount + msgCount + 1;

      const frames: Array<{ index: number; dataUrl: string }> = [];
      for (let i = 0; i < pageInfo.beatCount; i++) {
        const n = msgCount + 1 + i;
        await page.evaluate((idx: number) => (window as any).__vessel?.setBeat(idx), n).catch(() => {});
        await page.waitForTimeout(i === 0 ? 1400 : 1000);
        const buf = await page.screenshot({ type: "png" });
        frames.push({ index: i, dataUrl: `data:image/png;base64,${buf.toString("base64")}` });
      }
      await page.evaluate((idx: number) => (window as any).__vessel?.setBeat(idx), ctaFrame).catch(() => {});
      await page.waitForTimeout(1000);
      const ctaBuf = await page.screenshot({ type: "png" });
      frames.push({ index: pageInfo.beatCount, dataUrl: `data:image/png;base64,${ctaBuf.toString("base64")}` });

      await ctx.close().catch(() => {});
      console.log(`[worker] stills captured: ${pageInfo.beatCount} beats → ${frames.length} frames from ${url.slice(0, 80)}`);
      res.json({ beatCount: pageInfo.beatCount, slideCount: frames.length, frames });
    } finally {
      await browser.close().catch(() => {});
    }
  } catch (err) {
    console.error("[worker] stills capture failed:", (err as Error).message);
    res.status(500).json({ error: "stills capture failed" });
  }
});

// Health check with render-binary diagnostics — one probe answers "is the
// worker up AND can it actually render?" (ffmpeg + chromium presence).
app.get("/health", async (_req, res) => {
  let recorder: Awaited<ReturnType<typeof recorderDiagnostics>> | null = null;
  try {
    recorder = await recorderDiagnostics();
  } catch (error) {
    console.warn("[worker] health diagnostic failed:", (error as Error).message);
  }
  // Flat fields consumed by the bot's ops daemon (bot/src/lib/ops-daemon.ts).
  // Without them every worker rendered as "0 running, browser not ready" on
  // the /ops dashboard regardless of what it was actually doing.
  const queue = getRenderQueueStatus();
  res.json({
    status: "ok",
    service: "video-worker",
    replicaId:
      process.env["RAILWAY_REPLICA_ID"] ||
      process.env["RAILWAY_DEPLOYMENT_ID"] ||
      require("os").hostname(),
    uptimeSeconds: Math.round(process.uptime()),
    running: queue.running,
    queued: queue.queued,
    capacity: queue.capacity,
    browser: recorder?.chromium?.found ? "ok" : "missing",
    ffmpeg: recorder?.ffmpeg?.found ? "ok" : "missing",
    queue,
    recorder,
  });
});

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => {
  console.log(`Video Worker listening on port ${port}`);
});
