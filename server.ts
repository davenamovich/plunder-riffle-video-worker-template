import express from "express";
import {
  startRecordingJob,
  getJob,
  deleteJob,
  recorderDiagnostics,
  type RecordOptions,
} from "./src/recorder";
import path from "path";
import fs from "fs";

const app = express();
app.use(express.json());

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
    };
    console.log(`[worker] Starting recording for ${url}`);
    const job = await startRecordingJob(opts);
    // Both shapes the bot's client accepts (data.job.id / data.id).
    res.json({ id: job.id, job });
  } catch (error) {
    console.error("[worker] Error starting job:", error);
    res.status(500).json({ error: (error as Error).message });
  }
});

// Check job status — returns the JobRecord the bot's client reads straight
// off the body (status/message/error/result).
app.get("/api/record/:id", requireSecret, (req, res) => {
  const job = getJob(req.params.id);
  if (!job) {
    return res.status(404).json({ error: "Job not found" });
  }
  if (job.status === "done" && job.result) {
    const host = req.get("host");
    const protocol = req.protocol;
    job.result.mp4Url = `${protocol}://${host}/api/record/${job.id}/download`;
    job.result.thumbnailUrl = job.result.thumbnailPath
      ? `${protocol}://${host}/api/record/${job.id}/thumbnail`
      : undefined;
  }
  res.json(job);
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
    res.json({ success: true });
  } catch (error) {
    console.error("[worker] Error deleting job:", error);
    res.status(500).json({ error: (error as Error).message });
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
  res.json({ status: "ok", service: "video-worker", recorder });
});

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => {
  console.log(`Video Worker listening on port ${port}`);
});
