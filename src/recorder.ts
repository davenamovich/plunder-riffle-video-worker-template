/**
 * here.now ΓåÆ MP4 Recorder ΓÇö Core engine
 *
 * Records any live web page as a vertical 9:16 MP4 using Playwright + FFmpeg.
 * Ported and adapted from plunder's url-recorder so the output matches what
 * the plunder bot ships (blur-background phone canvas, crisp per-beat frames,
 * correct per-format duration, page-audio mix, thumbnail, encode health check).
 *
 * Two recording paths:
 *
 * 1. HIGH-FIDELITY VESSEL PATH ΓÇö when the target page exposes
 *    `window.__vessel = { ready: true, setBeat(n) }` (slideshow / confession /
 *    imessage builders ship this hook). The recorder drives the page beat by
 *    beat (n = -1 hero frame, 0..beatCount-1 beats, beatCount = CTA),
 *    screenshots each state supersampled (deviceScaleFactor 2), then FFmpeg
 *    assembles Ken Burns + crossfade frames into a phone-sized video, which is
 *    composited onto a blurred 1080├ù1920 canvas. No screencast = no dropped
 *    frames, no 390pxΓåÆ1080px upscale blur.
 *
 * 2. SCREENCAST PATH ΓÇö pages without the hook (blog posts, hot-take,
 *    news-ticker, ranked-list, before/after, fake-dm, audio-letter, or any
 *    arbitrary URL). Playwright recordVideo captures a webm while the page
 *    auto-plays; duration comes from the page's VESSEL declaration
 *    (beatMs ├ù beats) or the beat count; scrollable pages are scrolled at a
 *    comfortable pace with intro/outro holds and idle detection (matches
 *    plunder's closed-loop timing). The webm is trimmed to the show and
 *    composited onto the same blurred canvas.
 *
 * Both paths:
 *   - mix in the page's own <audio> track (bgm / bedSrc / any <audio>)
 *   - emit a thumbnail JPEG
 *   - sniff the finished MP4 for a moov/ftyp box so a truncated encode fails
 *     loud instead of reporting "done" with an unplayable file
 *   - clean up interim webm/audio files
 *
 * Key design decisions:
 *   - Never use ffmpeg-static: install system ffmpeg or set FFMPEG_PATH
 *   - Lazy-import playwright-core so the module loads when it's not installed
 *   - globalThis job registry survives hot reloads
 */
import { spawn, spawnSync } from "child_process";
import { mkdir, stat, unlink, readdir, writeFile, open } from "fs/promises";
import { existsSync } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";

// ΓöÇΓöÇ Types ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

export type ViewportPreset = "vertical" | "iphone14" | "iphone-se" | "pixel-7" | "galaxy-s22";
export type AspectRatio = "native" | "9:16";
export type BackgroundStyle = "blur" | "gradient" | "solid";

export interface RecordOptions {
  url: string;
  durationMs?: number;
  autoDuration?: boolean;
  viewport?: ViewportPreset;
  aspectRatio?: AspectRatio;
  background?: BackgroundStyle;
  waitUntil?: "load" | "domcontentloaded" | "networkidle";
  extraWaitMs?: number;
  /** Optional music/song to mix over the recording (matches plunder's songUrl). */
  songUrl?: string;
}

export interface RecordResult {
  id: string;
  mp4Path: string;
  mp4Url: string;
  durationMs: number;
  success: true;
  thumbnailPath?: string;
  thumbnailUrl?: string;
  mp4SizeBytes?: number;
  output?: { width: number; height: number; aspectRatio: AspectRatio };
  frameColor?: string;
  viewport?: { width: number; height: number; name: string };
}

export interface JobRecord {
  id: string;
  url: string;
  status: "queued" | "recording" | "done" | "error";
  progress: number;
  message: string;
  startedAt: string;
  finishedAt?: string;
  result?: RecordResult;
  error?: string;
  /** Buyer-owned marketplace render ΓÇö exempt from the idle sweep until the
   *  listing is purged (deleteJob is what finally removes the file). */
  retain?: boolean;
}

// ΓöÇΓöÇ Constants ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

const RECORDINGS_DIR = join(process.cwd(), "download", "recordings");

const VIEWPORTS: Record<ViewportPreset, { width: number; height: number; name: string }> = {
  // Exactly 9:16 (432/768 = 0.5625). Recording the page at the SAME aspect as
  // the output means the finished video is edge-to-edge page instead of a
  // narrow phone screenshot floating in blurred filler.
  vertical: { width: 432, height: 768, name: "Vertical 9:16" },
  iphone14: { width: 390, height: 844, name: "iPhone 14" },
  "iphone-se": { width: 375, height: 667, name: "iPhone SE" },
  "pixel-7": { width: 412, height: 915, name: "Pixel 7" },
  "galaxy-s22": { width: 360, height: 780, name: "Galaxy S22" },
};

const VERTICAL_OUT_W = 1080;
const VERTICAL_OUT_H = 1920; // 9:16 vertical

const FPS = 30;
const TRANSITION_SEC = 0.4; // crossfade between beats
const SUPERSAMPLE = 2; // per-beat PNG deviceScaleFactor (crisp upscale)

// Closed-loop ("scroll drives length") timing ΓÇö ported from plunder.
const SCROLL_PX_PER_SEC = 240;
const INTRO_HOLD_MS = 1000;
const OUTRO_HOLD_MS = 1000;
/**
 * Extra trim taken PAST the show-start mark, on top of the blank lead.
 *
 * This was previously SUBTRACTED from showStartMs, which rewound the cut a full
 * second BEFORE the show began and pulled the white navigation frames it was
 * named for straight back into the video — the cause of the white opening
 * second, and therefore of the white poster frame. It is now added, which is
 * what the name always claimed it did.
 */
const WHITE_GUARD_MS = 1500;
/**
 * How long the first clean frame is held before the show starts moving.
 *
 * Platforms sample the poster frame from the very start of the file, so the
 * opening frame has to be both clean AND still long enough to be picked up.
 * Cloned with ffmpeg `tpad`, so it costs no extra recording time.
 *
 * This was set to 0 in commit 5c32f80 because turning it on (900ms) didn't
 * remove the white flash — it made it worse. The reason: the frame `tpad`
 * clones is whatever sits at `leadSec`, and `leadSec` used to be picked by a
 * JS-timer guess (page readyState + a fixed guard band) with no check that the
 * frame there was actually painted. If the page reported "ready" before it
 * finished rendering, the cloned frame was still blank — so holding it just
 * held the white for longer. `leadSec` is now verified against the actual
 * pixels first (see `findCleanTrimSec`), so the hold is safe to re-enable.
 */
const HOLD_FIRST_FRAME_MS = 6500;
const POST_ROLL_MS = 2200; // cut 2s from end to remove white — small tail kept after the show when trimming
const AUTO_LEN_CAP_MS = 180_000;

const DEFAULT_BEAT_MS = 5250; // FIXED: 5.25s per slide for all formats

// ΓöÇΓöÇ In-memory job registry ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
// Stored on globalThis so it survives Node.js module hot reloads in dev.

const globalAny = globalThis as any;
if (!globalAny.__RALPH_RECORD_JOBS__)
  globalAny.__RALPH_RECORD_JOBS__ = new Map<string, JobRecord>();
const jobs: Map<string, JobRecord> = globalAny.__RALPH_RECORD_JOBS__;

// ΓöÇΓöÇ FFmpeg resolution ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
// DO NOT bundle ffmpeg-static ΓÇö the binary path breaks in production builds.
// Install system-wide: `apt-get install ffmpeg` (Railway/Docker)
// or set the FFMPEG_PATH env var.

function resolveFfmpeg(): string {
  const ffmpegPath = process.env["FFMPEG_PATH"];
  if (ffmpegPath) return ffmpegPath;
  for (const p of ["/usr/bin/ffmpeg", "/usr/local/bin/ffmpeg"]) {
    if (existsSync(p)) return p;
  }
  return "ffmpeg"; // trust PATH
}

// ΓöÇΓöÇ FFmpeg runner ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

/**
 * Hard ceiling on a single FFmpeg invocation.
 *
 * Renders are serialised (MAX_CONCURRENT_JOBS = 1), so an FFmpeg that never
 * exits does not just lose one video — it holds the only render slot forever
 * and every later MP4 sits at "waiting in queue" until the process restarts.
 * Kill it instead. Override with RECORD_FFMPEG_TIMEOUT_MS.
 */
function ffmpegTimeoutMs(): number {
  const raw = Number(process.env["RECORD_FFMPEG_TIMEOUT_MS"]);
  return Number.isFinite(raw) && raw > 0 ? raw : 300_000;
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn(resolveFfmpeg(), args, {
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32",
    });
    const limitMs = ffmpegTimeoutMs();
    let timedOut = false;
    const killer = setTimeout(() => {
      timedOut = true;
      ffmpeg.kill("SIGKILL");
    }, limitMs);
    if ((killer as any).unref) (killer as any).unref();
    const stderrChunks: Buffer[] = [];
    ffmpeg.stderr.on("data", (d: Buffer) => {
      stderrChunks.push(d);
      if (stderrChunks.length > 300) stderrChunks.shift();
    });
    ffmpeg.on("close", (code) => {
      clearTimeout(killer);
      if (timedOut) {
        return reject(new Error(`FFmpeg killed after ${Math.round(limitMs / 1000)}s (timeout)`));
      }
      if (code === 0) return resolve();
      const stderr = Buffer.concat(stderrChunks).toString().slice(-3000);
      reject(new Error(`FFmpeg exited ${code}: ${stderr}`));
    });
    ffmpeg.on("error", (e) => {
      clearTimeout(killer);
      reject(e);
    });
  });
}

async function probeDuration(p: string): Promise<number | null> {
  return new Promise((resolve) => {
    const { spawn } = require("child_process");
    const proc = spawn("ffmpeg", ["-i", p, "-f", "null", "-"]);
    let out = "";
    proc.stderr.on("data", (d: Buffer) => (out += d));
    proc.on("close", () => {
      const matches = out.match(/time=(\d+):(\d+):(\d+\.\d+)/g);
      if (matches && matches.length > 0) {
        const last = matches[matches.length - 1];
        const parts = last.replace("time=", "").split(":");
        const h = parseInt(parts[0], 10);
        const m = parseInt(parts[1], 10);
        const s = parseFloat(parts[2]);
        resolve(h * 3600 + m * 60 + s);
      } else {
        resolve(null);
      }
    });
    proc.on("error", () => resolve(null));
  });
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Post-encode validity check (ported from plunder's url-recorder): ffmpeg's
 * `-movflags +faststart` rewrites the moov box to the front of the file; if
 * that pass is interrupted the mp4 ends up with the stream but NO moov atom ΓÇö
 * ffprobe reports "0 duration / unplayable" even though ffmpeg exited 0. Sniff
 * the first chunk for "moov" (and "ftyp" sanity) so we fail loud instead of
 * shipping a corrupt file.
 */
async function assertMp4Healthy(p: string): Promise<void> {
  const s = await stat(p);
  if (s.size === 0) throw new Error("FFmpeg produced an empty MP4");
  const SNIFF = Math.min(s.size, 4 * 1024 * 1024);
  const fh = await open(p, "r");
  try {
    const buf = Buffer.alloc(SNIFF);
    await fh.read(buf, 0, SNIFF, 0);
    const hasMoov = buf.indexOf(Buffer.from("moov", "ascii")) >= 0;
    const hasFtyp = buf.indexOf(Buffer.from("ftyp", "ascii")) >= 0;
    if (!hasMoov || !hasFtyp) {
      throw new Error(
        `ffmpeg wrote a non-MP4 file at ${p} (${s.size} bytes; moov=${hasMoov} ftyp=${hasFtyp}). Check the filter graph for malformed filters.`,
      );
    }
  } finally {
    await fh.close();
  }
}

// ΓöÇΓöÇ Blur-background 9:16 composite ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
// The phone-sized recording is scaled to a 160px-margin center column on a
// 1080├ù1920 canvas whose background is a blurred, darkened zoom of the video
// itself (matches plunder's default `background: blur` look).

/**
 * True when the recorded page is already the output aspect, so it can fill the
 * canvas edge-to-edge instead of being letterboxed into blurred filler.
 *
 * Recording at 390x844 (iPhone 14) and fitting that into 1080x1920 leaves the
 * page covering only ~57% of the frame, with the other ~43% blurred bars. A
 * 9:16 source covers 100%.
 */
function fillsOutputAspect(phoneW: number, phoneH: number): boolean {
  const target = VERTICAL_OUT_W / VERTICAL_OUT_H;
  return Math.abs(phoneW / phoneH - target) < 0.01;
}

/**
 * Where the phone screen sits inside the 1080x1920 canvas. Shared by the
 * composite filter and the thumbnail's blank-frame check, which has to measure
 * the page pixels rather than the whole canvas.
 */
function phoneRect(phoneW: number, phoneH: number) {
  const margin = 160;
  const targetH = VERTICAL_OUT_H - margin * 2;
  const scaledWBase = Math.round((targetH * phoneW) / phoneH);
  const scaledW = scaledWBase % 2 === 0 ? scaledWBase : scaledWBase + 1;
  const x = Math.round((VERTICAL_OUT_W - scaledW) / 2);
  return { margin, targetH, scaledW, x };
}

/**
 * ffmpeg crop expression isolating the page pixels in the finished MP4.
 * Undefined when the page already fills the frame — there is nothing to crop
 * away, and the whole frame IS the page.
 */
function phoneCropFilter(phoneW: number, phoneH: number): string | undefined {
  if (fillsOutputAspect(phoneW, phoneH)) return undefined;
  const { margin, targetH, scaledW, x } = phoneRect(phoneW, phoneH);
  return `crop=${scaledW}:${targetH}:${x}:${margin}`;
}

/**
 * @param holdSec When > 0, clone the first frame for this long before the show
 *   moves, and skip the fade-up. Used by the screencast path so the poster
 *   frame is a solid, fully-lit hero rather than a black-to-hero blend.
 *   The frames/slideshow path passes 0 and keeps its original fade.
 */
function buildCompositeFilter(
  background: BackgroundStyle,
  phoneW: number,
  phoneH: number,
  holdSec = 0,
  trimSec = 0,
): string {
  const chains: string[] = [];
  const trim = trimSec > 0 ? `trim=start=${trimSec.toFixed(3)},setpts=PTS-STARTPTS,` : "";
  // tpad clones the FIRST frame of the (already trimmed) input, so the hold is
  // built from the clean hero rather than from whatever preceded it.
  const hold =
    holdSec > 0 ? `tpad=start_duration=${holdSec.toFixed(3)}:start_mode=clone,` : "";

  // ── Full-bleed path ──
  // When the page was recorded at the output aspect there is nothing to letterbox:
  // scale to cover and crop off the rounding, so the video is 100% page. The
  // blurred-bezel treatment below only exists to fill space a non-9:16 source
  // leaves behind, and running it on a 9:16 source would shrink the page for
  // no reason.
  if (fillsOutputAspect(phoneW, phoneH)) {
    const tail = holdSec > 0 ? "" : ",fade=t=in:st=0:d=0.2";
    chains.push(
      `[0:v]${trim}${hold}scale=${VERTICAL_OUT_W}:${VERTICAL_OUT_H}:force_original_aspect_ratio=increase,` +
        `crop=${VERTICAL_OUT_W}:${VERTICAL_OUT_H},setsar=1${tail}[out]`,
    );
    return chains.join(";");
  }

  chains.push(
    `[0:v]${trim}${hold}scale=${phoneW}:${phoneH}:force_original_aspect_ratio=decrease,pad=${phoneW}:${phoneH}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1[screen]`,
  );

  // A fade-up from black is exactly what ruins a poster frame, so it is only
  // applied when we are NOT holding the opening frame for the thumbnail.
  const finish = holdSec > 0 ? `[ovr]null[out]` : `[ovr]fade=t=in:st=0:d=0.2[out]`;

  const { margin, targetH, scaledW, x } = phoneRect(phoneW, phoneH);

  if (background === "blur") {
    chains.push("[screen]split=2[src_bg][src_fg]");
    chains.push(
      `[src_bg]scale=${VERTICAL_OUT_W}:${VERTICAL_OUT_H}:force_original_aspect_ratio=increase,crop=${VERTICAL_OUT_W}:${VERTICAL_OUT_H},gblur=sigma=40,eq=brightness=-0.3[bg]`,
    );
    chains.push(`[src_fg]scale=${scaledW}:${targetH},setsar=1[fg]`);
    chains.push(`[bg][fg]overlay=${x}:${margin}:format=auto[ovr]`);
    chains.push(finish);
  } else if (background === "gradient") {
    chains.push(`color=c=0x1a1a2e:s=${VERTICAL_OUT_W}x${VERTICAL_OUT_H}[gradbase]`);
    chains.push(
      `[gradbase]geq=r='r(X,Y)*(1-(Y/H)*0.6)':g='g(X,Y)*(1-(Y/H)*0.6)':b='b(X,Y)*(1-(Y/H)*0.6)+30'[bg]`,
    );
    chains.push(`[screen]scale=${scaledW}:${targetH},setsar=1[fg]`);
    chains.push(`[bg][fg]overlay=${x}:${margin}:format=auto[ovr]`);
    chains.push(finish);
  } else {
    chains.push(`color=c=0x000000:s=${VERTICAL_OUT_W}x${VERTICAL_OUT_H}[bg]`);
    chains.push(`[screen]scale=${scaledW}:${targetH},setsar=1[fg]`);
    chains.push(`[bg][fg]overlay=${x}:${margin}:format=auto[ovr]`);
    chains.push(finish);
  }
  return chains.join(";");
}

/** Run ffmpeg and return whatever it wrote to stdout. */
function runFfmpegCapture(args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn(resolveFfmpeg(), args, {
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32",
    });
    const limitMs = ffmpegTimeoutMs();
    let timedOut = false;
    const killer = setTimeout(() => {
      timedOut = true;
      ffmpeg.kill("SIGKILL");
    }, limitMs);
    if ((killer as any).unref) (killer as any).unref();
    const out: Buffer[] = [];
    const errChunks: Buffer[] = [];
    ffmpeg.stdout.on("data", (d: Buffer) => out.push(d));
    ffmpeg.stderr.on("data", (d: Buffer) => {
      errChunks.push(d);
      if (errChunks.length > 100) errChunks.shift();
    });
    ffmpeg.on("close", (code) => {
      clearTimeout(killer);
      if (timedOut) {
        return reject(new Error(`FFmpeg killed after ${Math.round(limitMs / 1000)}s (timeout)`));
      }
      if (code === 0) return resolve(Buffer.concat(out));
      reject(new Error(`FFmpeg exited ${code}: ${Buffer.concat(errChunks).toString().slice(-1500)}`));
    });
    ffmpeg.on("error", (e) => {
      clearTimeout(killer);
      reject(e);
    });
  });
}

/**
 * A frame counts as blank only when it is BOTH very bright AND almost
 * completely flat.
 *
 * Brightness alone is not enough, and assuming it was is how a naive check
 * would break real pages: measured on the composited canvas, a genuine blank
 * lead reads mean 255 / sd 0, while a perfectly good white-background page
 * with text reads mean 216 / sd 63. Testing brightness on its own would throw
 * away the second one. The flatness test is what separates them.
 */
const BLANK_MEAN_MIN = 235;
const BLANK_SD_MAX = 6;

/**
 * Mean + standard deviation of the frame at `atSec`, measured over the PHONE
 * SCREEN only.
 *
 * Cropping first matters: measured across the whole 1080x1920 canvas even a
 * blank frame shows sd ~37, purely from the edge between the phone rect and
 * the blurred bezel, which masks the flatness we're looking for. Cropping to
 * the page pixels takes that blank frame to sd 0.
 */
async function frameStats(
  mp4Path: string,
  atSec: number,
  crop?: string,
): Promise<{ mean: number; sd: number } | null> {
  try {
    // Decode ONE frame down to 8x8 greyscale raw bytes — 64 values to measure.
    const raw = await runFfmpegCapture([
      "-v",
      "error",
      "-ss",
      atSec.toFixed(3),
      "-i",
      mp4Path,
      "-vframes",
      "1",
      "-vf",
      crop ? `${crop},scale=8:8` : "scale=8:8",
      "-pix_fmt",
      "gray",
      "-f",
      "rawvideo",
      "-",
    ]);
    if (raw.length === 0) return null;
    let sum = 0;
    for (const b of raw) sum += b;
    const mean = sum / raw.length;
    let varSum = 0;
    for (const b of raw) varSum += (b - mean) ** 2;
    return { mean, sd: Math.sqrt(varSum / raw.length) };
  } catch {
    return null;
  }
}

function isBlankFrame(s: { mean: number; sd: number }): boolean {
  return s.mean >= BLANK_MEAN_MIN && s.sd <= BLANK_SD_MAX;
}

/**
 * Finds a lead-trim point at/after `baseSec` whose frame is not blank, scanned
 * on the RAW webm before compositing (no crop needed — at that stage the whole
 * frame is already just the page, there's no blurred bezel around it yet).
 *
 * This is the frame `HOLD_FIRST_FRAME_MS` clones via `tpad`, so if this lands
 * on white, the hold just holds the white for longer instead of fixing it —
 * that's exactly what happened before this existed (see the note on
 * `HOLD_FIRST_FRAME_MS`). Reuses the same mean/sd blank test as the thumbnail
 * picker below, just applied to picking the video's own frame 0 instead of a
 * separate JPEG.
 *
 * Falls back to `baseSec` unmoved if every candidate reads as blank (or is
 * unreadable) — better to ship the original timer-based guess than trim away
 * real show content searching for a frame that was never going to show up.
 */
async function findCleanTrimSec(
  rawPath: string,
  baseSec: number,
  ceilingSec: number,
): Promise<number> {
  const offsets = [0, 0.3, 0.6, 1.0, 1.5, 2.5];
  for (const off of offsets) {
    const t = baseSec + off;
    if (t >= ceilingSec) break;
    const s = await frameStats(rawPath, t, undefined);
    if (s === null) continue;
    if (!isBlankFrame(s)) return t;
    console.warn(
      `[recorder] lead-trim candidate at ${t.toFixed(2)}s is blank ` +
        `(mean ${s.mean.toFixed(0)}, sd ${s.sd.toFixed(1)}) — trying later`,
    );
  }
  return baseSec;
}

/**
 * Generate the poster frame from the finished MP4.
 *
 * The timestamp alone is not trustworthy: a slow-painting page, a stalled font
 * load, or any regression in the lead-trim maths puts a white frame exactly
 * where the thumbnail is sampled — which is what shipped white thumbnails to
 * Telegram and YouTube. So each candidate is decoded and its brightness
 * checked, and near-white frames are rejected in favour of a later one.
 *
 * Returns the path, or undefined when it fails — a missing thumbnail never
 * fails the job.
 */
async function makeThumbnail(
  mp4Path: string,
  thumbPath: string,
  preferSec = 0.45,
  crop?: string,
): Promise<string | undefined> {
  // Preferred moment first, then progressively deeper into the show.
  const candidates = [preferSec, preferSec + 0.5, 1.5, 2.5, 4, 6];
  let fallback: number | null = null;

  for (const t of candidates) {
    const s = await frameStats(mp4Path, t, crop);
    if (s === null) continue;
    if (fallback === null) fallback = t;
    if (isBlankFrame(s)) {
      console.warn(
        `[recorder] thumbnail candidate at ${t}s is blank ` +
          `(mean ${s.mean.toFixed(0)}, sd ${s.sd.toFixed(1)}) — trying later`,
      );
      continue;
    }
    try {
      await runFfmpeg(["-y", "-ss", t.toFixed(3), "-i", mp4Path, "-vframes", "1", "-q:v", "2", thumbPath]);
      if (await fileExists(thumbPath)) return thumbPath;
    } catch (e) {
      console.warn("[recorder] thumbnail write failed:", (e as Error).message);
    }
  }

  // Every candidate read as blank (or none were readable). Still emit something
  // rather than shipping no thumbnail at all.
  try {
    await runFfmpeg([
      "-y",
      "-ss",
      (fallback ?? preferSec).toFixed(3),
      "-i",
      mp4Path,
      "-vframes",
      "1",
      "-q:v",
      "2",
      thumbPath,
    ]);
    if (await fileExists(thumbPath)) return thumbPath;
  } catch (e) {
    console.warn("[recorder] thumbnail failed:", (e as Error).message);
  }
  return undefined;
}

/**
 * Resolve an audio file to mix into the MP4: opts.songUrl > the page's own
 * detected audio (bgm / bedSrc / any <audio src>). Returns a local path or null.
 */
async function resolveAudioForMix(
  songUrl: string | undefined,
  pageAudioSrc: string | null,
  pageUrl: string,
  id: string,
): Promise<string | null> {
  const src = songUrl || pageAudioSrc;
  if (!src) return null;
  try {
    if (src.startsWith("data:audio/")) {
      const m = /^data:audio\/([\w.+-]+);base64,(.+)$/.exec(src);
      if (!m) return null;
      const ext = m[1] === "mpeg" ? "mp3" : m[1].split(".")[0] || "mp3";
      const target = join(tmpdir(), `rec-audio-${id}.${ext}`);
      await writeFile(target, Buffer.from(m[2], "base64"));
      return target;
    }
    const abs = new URL(src, pageUrl).toString();
    const res = await fetch(abs);
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0) return null;
    const extMatch = /\.([a-z0-9]+)(?:$|\?)/i.exec(abs);
    const ext = extMatch ? extMatch[1].toLowerCase() : "mp3";
    const target = join(tmpdir(), `rec-audio-${id}.${ext}`);
    await writeFile(target, buf);
    return target;
  } catch (e) {
    console.warn("[recorder] audio fetch failed ΓÇö MP4 will be silent:", (e as Error).message);
    return null;
  }
}

// ΓöÇΓöÇ Per-beat capture (HIGH-FIDELITY vessel path) ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
// Drives the page's `__vessel.setBeat(n)` contract:
//   n === -1        ΓåÆ hero / landing frame (when hasLanding)
//   0..beatCount-1  ΓåÆ beat n
//   n === beatCount ΓåÆ CTA screen
// Screenshots each state supersampled so the final upscale stays crisp.



// ΓöÇΓöÇ Scroll driver (screencast path) ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
// Ported from plunder's closed-loop timing: intro hold ΓåÆ constant-pace scroll
// (240px/s) with idle detection ΓåÆ outro hold. Fixed-position pages (no scroll)
// just wait out totalMs, breaking early on an explicit __vesselDone signal.
// Serialized as a string because it must run INSIDE the page (page.evaluate).

const SCROLL_DRIVER_SRC = `async (cfg) => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const maxScroll =
    Math.max(document.body.scrollHeight, document.documentElement.scrollHeight) - window.innerHeight;
  let lastFrameChangeTime = Date.now();

  if (maxScroll <= 0) {
    const startMs = Date.now();
    while (Date.now() - startMs < cfg.totalMs) {
      const isDone =
        window.__vesselDone === true ||
        window.__recordingFinished === true ||
        window.__slideshowDone === true;
      if (isDone) break;
      await sleep(200);
    }
    return;
  }

  await sleep(cfg.introMs);
  lastFrameChangeTime = Date.now();

  if (cfg.mode === 'auto') {
    await new Promise((resolve) => {
      let last = performance.now();
      let y = 0;
      const step = () => {
        const now = performance.now();
        const dt = (now - last) / 1000;
        last = now;
        const prevY = y;
        y = Math.min(maxScroll, y + cfg.pxPerSec * dt);
        window.scrollTo(0, Math.round(y));
        if (Math.round(y) !== Math.round(prevY)) lastFrameChangeTime = Date.now();
        if (Date.now() - lastFrameChangeTime >= cfg.maxIdleMs) return resolve();
        if (y < maxScroll) requestAnimationFrame(step);
        else resolve();
      };
      requestAnimationFrame(step);
    });
  } else {
    const scrollMs = Math.max(500, cfg.totalMs - cfg.introMs - cfg.outroMs);
    await new Promise((resolve) => {
      const start = performance.now();
      const tick = () => {
        const elapsed = performance.now() - start;
        const t = Math.min(1, elapsed / scrollMs);
        const eased = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
        window.scrollTo(0, Math.round(eased * maxScroll));
        if (Date.now() - lastFrameChangeTime >= cfg.maxIdleMs) return resolve();
        if (t < 1) requestAnimationFrame(tick);
        else resolve();
      };
      requestAnimationFrame(tick);
    });
  }

  const outroStart = Date.now();
  while (Date.now() - outroStart < cfg.outroMs) {
    if (Date.now() - lastFrameChangeTime >= cfg.maxIdleMs) break;
    await sleep(200);
  }
}`;

// ΓöÇΓöÇ Core recorder ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

async function recordPage(opts: RecordOptions, id: string): Promise<RecordResult> {
  // Lazy import playwright-core so the module loads fine even if the package
  // is not installed (graceful degradation when the feature isn't available).
  let chromium: any, devices: any;
  try {
    ({ chromium, devices } = await import("playwright-core"));
  } catch {
    throw new Error("playwright-core is not installed. Run: npm install playwright-core");
  }
  await mkdir(RECORDINGS_DIR, { recursive: true });
  const workDir = join(tmpdir(), `rec-${id}`);
  await mkdir(workDir, { recursive: true });

  const mp4Path = join(RECORDINGS_DIR, `${id}.mp4`);
  const thumbPath = join(RECORDINGS_DIR, `${id}-thumb.jpg`);

  const viewport = VIEWPORTS[opts.viewport || "vertical"];
  const background = opts.background || "blur";
  const aspectRatio = opts.aspectRatio || "9:16";
  const autoDuration = opts.autoDuration !== false;

  const baseUrl = (process.env["PUBLIC_BASE_URL"] || "http://localhost:8080").replace(/\/$/, "");

  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env["PLAYWRIGHT_CHROMIUM_PATH"] || undefined,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--autoplay-policy=no-user-gesture-required",
      "--font-render-hinting=none",
    ],
  });

  try {
    const context = await browser.newContext({
      ...devices["iPhone 14"],
      viewport: { width: viewport.width, height: viewport.height },
      recordVideo: { dir: workDir, size: { width: viewport.width, height: viewport.height } },
    });

    // Stamp the clock exactly when Playwright starts the webm recording.
    // This allows the ffmpeg trimmer to accurately slice off the page load white screen.
    const recordClockStart = Date.now();
    const page = await context.newPage();
    await page
      .goto(opts.url, { waitUntil: opts.waitUntil || "load", timeout: 30_000 })
      .catch(() => {});
    await page.waitForTimeout(opts.extraWaitMs ?? 400);

    // Live media-readiness wait: never measure duration while an embedded
    // <audio>/<video> still reads 0/NaN.
    try {
      await page.waitForFunction(
        () => {
          const all = Array.from(document.querySelectorAll("audio, video")) as HTMLMediaElement[];
          if (all.length === 0) return true;
          return all.every((m) => m.readyState >= 1 && m.duration > 0 && isFinite(m.duration));
        },
        { timeout: 2500, polling: 100 },
      );
    } catch {}

    // Detect beats, per-format VESSEL timing, vessel hook and page audio.
    const pageInfo = await page
      .evaluate(() => {
        const beats = document.querySelectorAll(".beat");
        const dataBeats = document.querySelectorAll("[data-beat]");
        const takes = document.querySelectorAll(".take, [data-take]");
        const confessions = document.querySelectorAll(".confession, [data-confession]");
        const reports = document.querySelectorAll(".report, [data-report]");
        const slides = document.querySelectorAll(
          ".slide, .frame, [data-slide], .card, .report-card",
        );
        const vessel = (window as any).VESSEL || {};
        const vesselHook = (window as any).__vessel || {};
        const anyAudio = document.querySelector("audio") as HTMLAudioElement | null;
        const audioSrc =
          document.getElementById("bgm")?.getAttribute("src") ||
          document.getElementById("bedSrc")?.getAttribute("src") ||
          (anyAudio ? anyAudio.currentSrc || anyAudio.getAttribute("src") : null);
        let audioDurationSec = 0;
        if (anyAudio && anyAudio.duration && isFinite(anyAudio.duration) && anyAudio.duration > 0) {
          audioDurationSec = anyAudio.duration;
        } // Hybrid pages expose the iMessage conversation as leading vessel
        // frames: __hybridMsgCount message beats + 1 link-card beat + the
        // slideshow beats. Count them so the capture includes the
        // conversation (the actual ad) — not just the slideshow — and the
        // last slideshow beat + CTA land on the right frames (the +1 is
        // the link card).
        const msgs = document.querySelectorAll(".msg-row");
        const hybridMsgCount = Number((window as any).__hybridMsgCount || 0);
        const vesselBeats = Math.max(beats.length, dataBeats.length);
        return {
          beatCount: Math.max(
            beats.length,
            dataBeats.length,
            takes.length,
            confessions.length,
            reports.length,
            slides.length,
            msgs.length,
          ),
          vesselBeatCount: vesselBeats + hybridMsgCount + (hybridMsgCount > 0 ? 1 : 0),
          beatMs: Number(vessel.beatMs) || 0,
          declaredBeats: Number(vessel.beats) || 0,
          hasVesselHook: typeof vesselHook.setBeat === "function",
          hasLanding: vesselHook.hasLanding === true,
          audioSrc: audioSrc || null,
          audioDurationSec,
          isImessage: msgs.length > 0,
        };
      })
      .catch(() => ({
        beatCount: 0,
        vesselBeatCount: 0,
        beatMs: 0,
        declaredBeats: 0,
        hasVesselHook: false,
        hasLanding: false,
        audioSrc: null as string | null,
        audioDurationSec: 0,
        isImessage: false,
      }));

    const beatMs = pageInfo.beatMs || DEFAULT_BEAT_MS;
    const audioPath = await resolveAudioForMix(opts.songUrl, pageInfo.audioSrc, opts.url, id);



    // ΓöÇΓöÇ SCREENCAST PATH ΓöÇΓöÇ
    // (recordClockStart was stamped at newPage)

    // Wait for page ready signal before capturing the opening shot.
    try {
      await page.waitForFunction(
        () =>
          (window as any).__vesselReady === true ||
          (window as any).__vessel?.ready === true ||
          document.readyState === "complete",
        { timeout: 5000 },
      );
    } catch {}
    // Scroll to top and hold for one more short settle before marking show start.
    try {
      await page.evaluate(() => window.scrollTo(0, 0));
    } catch {}
    await page.waitForTimeout(600);

    const showStartMs = Date.now() - recordClockStart;

    // Auto-start is handled natively by the page's own setTimeout (2000ms hero hold),
    // or by hybrid mode's autoTimer. We no longer force startShow() here so the
    // first frame (hero) is held long enough to be visible in the video.
    await page
      .evaluate(() => {
        if (typeof (window as any).startShow === "function") {
          (window as any).startShow();
        } else if (typeof (window as any).startTransmission === "function") {
          (window as any).startTransmission();
        } else {
          const btn = document.querySelector(
            ".landing-cta, .open-btn, [data-start]",
          ) as HTMLElement | null;
          if (btn) btn.click();
        }
      })
      .catch(() => {});

    // Duration: declared beats > DOM beat count > default.
    let durationMs = opts.durationMs || 0;
    if (autoDuration && !durationMs) {
      if (pageInfo.declaredBeats > 0) {
        durationMs = Math.round(pageInfo.declaredBeats * beatMs);
      } else if (pageInfo.beatCount > 0) {
        durationMs = pageInfo.beatCount * beatMs + 5000;
      } else {
        durationMs = DEFAULT_BEAT_MS * 3;
      }
      if (pageInfo.audioDurationSec > 0) {
        durationMs = Math.max(durationMs, Math.round(pageInfo.audioDurationSec * 1000) + 1500);
      }
    }
    durationMs = Math.min(durationMs || DEFAULT_BEAT_MS * 3, AUTO_LEN_CAP_MS);

    await page.waitForTimeout(durationMs);

    const showEndMs = Date.now() - recordClockStart;
    await page.waitForTimeout(300);

    await page.close();
    await context.close(); // triggers Playwright to flush the .webm

    // Find the .webm written by Playwright.
    const webmFiles = (await readdir(workDir)).filter((f) => f.endsWith(".webm"));
    if (!webmFiles.length)
      throw new Error("No webm file recorded — Playwright may not have flushed it");
    const webmPath = join(workDir, webmFiles[0]);

    // Trim the blank lead, hold the first clean frame, then composite onto the
    // blurred 9:16 canvas.
    //
    const totalRecordedSec = Math.max(0.5, showEndMs / 1000);
    const probedSec = await probeDuration(webmPath);
    const videoLenSec = probedSec ?? totalRecordedSec;

    const tailSec = 0.35; // 300ms wait + ~50ms page.close overhead
    const endTrim = 0;
    
    const estShowMs = durationMs;
    const targetDurSec = Math.min(
      AUTO_LEN_CAP_MS / 1000,
      Math.max(0.5, (estShowMs + POST_ROLL_MS) / 1000 - endTrim)
    );

    const FRONT_BUFFER_SEC = 0.5;
    const actualLeadIn = Math.max(0, videoLenSec - targetDurSec - tailSec);
    const baseStartSec = Math.max(0, actualLeadIn - FRONT_BUFFER_SEC);
    const startSec = baseStartSec;
    
    const appliedFrontBuffer = actualLeadIn - baseStartSec;
    const targetDurSecWithBuffer = targetDurSec + appliedFrontBuffer;
    const maxAvailableSec = Math.max(0.5, videoLenSec - startSec - endTrim);
    const showDurSec = Math.min(targetDurSecWithBuffer, maxAvailableSec);

    const filter = buildCompositeFilter(background, viewport.width, viewport.height, 0, 0);
    const audioFilter = audioPath
      ? `[1:a]aresample=44100,aloop=loop=-1:size=2e9,atrim=0:${Math.max(0, showDurSec - 5).toFixed(3)},volume=0.5,afade=t=out:st=${Math.max(0, showDurSec - 6.2).toFixed(2)}:d=1.2,apad,atrim=0:${showDurSec.toFixed(3)},alimiter=limit=0.95[aout]`
      : null;

    const trimArgs = [
      "-ss", startSec.toFixed(3),
      "-t", showDurSec.toFixed(3),
    ];

    const finalArgs: string[] = [
      "-y",
      "-i",
      webmPath,
      ...(audioPath ? ["-stream_loop", "-1", "-i", audioPath] : []),
      "-filter_complex",
      audioFilter ? `${filter};${audioFilter}` : filter,
      "-map",
      "[out]",
      ...(audioFilter ? ["-map", "[aout]"] : []),
      ...trimArgs,
      "-c:v",
      "libx264",
      "-preset",
      "fast",
      "-crf",
      "23",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      "-vsync",
      "vfr",
      ...(audioPath ? ["-c:a", "aac", "-b:a", "192k", "-ar", "44100", "-ac", "2"] : ["-an"]),
      mp4Path,
    ];
    await runFfmpeg(finalArgs);
    await assertMp4Healthy(mp4Path);

    // Clean up the interim webm + audio.
    try {
      await unlink(webmPath);
    } catch {}
    if (audioPath) {
      try {
        await unlink(audioPath);
      } catch {}
    }

    const thumb = await makeThumbnail(
      mp4Path,
      thumbPath,
      Math.min(1.0, showDurSec / 2),
      phoneCropFilter(viewport.width, viewport.height),
    );
    const mp4Stat = await stat(mp4Path);
    return {
      id,
      mp4Path,
      mp4Url: `${baseUrl}/api/record/${id}/download`,
      thumbnailPath: thumb,
      thumbnailUrl: thumb ? `${baseUrl}/api/record/${id}/thumbnail` : undefined,
      mp4SizeBytes: mp4Stat.size,
      // Report the ENCODED length, which includes the held opening frame —
      // callers use this for upload metadata and progress, so it has to match
      // the file rather than the pre-hold show duration.
      durationMs: Math.round(showDurSec * 1000),
      success: true,
      output: { width: VERTICAL_OUT_W, height: VERTICAL_OUT_H, aspectRatio },
      frameColor: "none",
      viewport: { width: viewport.width, height: viewport.height, name: viewport.name },
    };
  } finally {
    await browser.close();
  }
}

// ── Job Queue ──
const MAX_CONCURRENT_JOBS = 1;
let runningJobsCount = 0;
const jobQueue: Array<() => void> = [];

async function acquireJobSlot(): Promise<void> {
  if (runningJobsCount < MAX_CONCURRENT_JOBS) {
    runningJobsCount++;
    return Promise.resolve();
  }
  return new Promise((resolve) => jobQueue.push(resolve));
}

function releaseJobSlot(): void {
  if (jobQueue.length > 0) {
    const next = jobQueue.shift()!;
    next();
  } else {
    runningJobsCount--;
  }
}

// ┌────────────────────────────────────────────────────────────────────────────
// │ Public API
// └────────────────────────────────────────────────────────────────────────────

/**
 * Hard ceiling on one render, start to finish. Sized above the worst legitimate
 * case (AUTO_LEN_CAP_MS of page time + browser launch + encode) so it only
 * ever fires on a genuinely stuck job. Override with RECORD_JOB_TIMEOUT_MS.
 */
function jobTimeoutMs(): number {
  const raw = Number(process.env["RECORD_JOB_TIMEOUT_MS"]);
  return Number.isFinite(raw) && raw > 0 ? raw : 480_000;
}

/** Start a recording job asynchronously. Returns immediately with the job record. */
export async function startRecordingJob(opts: RecordOptions): Promise<JobRecord> {
  const id = randomUUID();
  const job: JobRecord = {
    id,
    url: opts.url,
    status: "queued",
    progress: 0,
    message: "Waiting in queue...",
    startedAt: new Date().toISOString(),
  };
  jobs.set(id, job);

  // Fire-and-forget — callers poll via getJob()
  void (async () => {
    await acquireJobSlot();
    
    // Check if job was cancelled while waiting
    const jCheck = jobs.get(id);
    if (!jCheck) {
      releaseJobSlot();
      return;
    }
    
    jCheck.status = "recording";
    jCheck.progress = 5;
    jCheck.message = "Launching browser...";
    
    const totalDuration = opts.durationMs || 30000;
    const startTime = Date.now();
    const ticker = setInterval(() => {
      const elapsed = Date.now() - startTime;
      const pct = Math.min(85, 5 + Math.round((elapsed / (totalDuration + 8000)) * 80));
      const j = jobs.get(id);
      if (j && j.status === "recording") {
        j.progress = pct;
        j.message = `RecordingΓÇª ${Math.floor(elapsed / 1000)}s elapsed`;
      }
    }, 500);
    if ((ticker as any).unref) (ticker as any).unref();

    const limitMs = jobTimeoutMs();
    let watchdog: ReturnType<typeof setTimeout> | null = null;
    const guarded = new Promise<never>((_, reject) => {
      watchdog = setTimeout(
        () => reject(new Error(`Render exceeded ${Math.round(limitMs / 1000)}s and was abandoned`)),
        limitMs,
      );
      if ((watchdog as any).unref) (watchdog as any).unref();
    });

    try {
      // Pass the job id through so result.id === job.id (callers use the job
      // id for retainRecording/deleteJob ΓÇö keeping them aligned avoids the
      // classic "delete the wrong key" footgun).
      const result = await Promise.race([recordPage(opts, id), guarded]);
      clearInterval(ticker);
      if (watchdog) clearTimeout(watchdog);
      const j = jobs.get(id)!;
      j.status = "done";
      j.progress = 100;
      j.message = "Done";
      j.finishedAt = new Date().toISOString();
      j.result = result;
    } catch (err: any) {
      clearInterval(ticker);
      if (watchdog) clearTimeout(watchdog);
      const j = jobs.get(id)!;
      j.status = "error";
      j.progress = 0;
      j.message = (err as Error).message;
      j.error = (err as Error).message;
      j.finishedAt = new Date().toISOString();
      console.error(`[recorder] job ${id} failed:`, (err as Error).message);
    } finally {
      releaseJobSlot();
    }
  })();

  return job;
}

export const getJob = (id: string): JobRecord | undefined => jobs.get(id);
export const listJobs = (): JobRecord[] =>
  Array.from(jobs.values()).sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));

/**
 * The HTTP layer's name for getJob: returns the JobRecord (status/message/
 * error/result) the bot's external client reads straight off the JSON body.
 */
export const getRecordingStatus = getJob;

/**
 * Render-binary diagnostics for /health: ffmpeg + chromium presence.
 * Fail-open — a missing binary reports found:false instead of throwing, so the
 * health probe always answers even on a half-built image.
 */
export async function recorderDiagnostics(): Promise<{
  ffmpeg: { found: boolean; path: string };
  chromium: { found: boolean; source: string };
}> {
  const ffmpegPath = resolveFfmpeg();
  let ffmpegFound = false;
  try {
    const probe = spawnSync(ffmpegPath, ["-version"], { stdio: "ignore", timeout: 5000 });
    ffmpegFound = probe.status === 0;
  } catch {
    ffmpegFound = false;
  }

  const explicit = process.env["PLAYWRIGHT_CHROMIUM_PATH"];
  if (explicit) {
    return {
      ffmpeg: { found: ffmpegFound, path: ffmpegPath },
      chromium: { found: existsSync(explicit), source: explicit },
    };
  }
  const browsersPath =
    process.env["PLAYWRIGHT_BROWSERS_PATH"] || join(homedir(), ".cache", "ms-playwright");
  const source = `${browsersPath}/chromium-*/{chrome-linux,chrome-headless-shell-linux64}/*`;
  // Both browser layouts ship across playwright versions: the classic
  // `chrome-linux/chrome` + `chrome-linux/headless_shell`, and (1.49+) the
  // headless shell moved to `chrome-headless-shell-linux64/chrome-headless-shell`.
  const REL_BINARIES = [
    "chrome-linux/chrome",
    "chrome-linux/headless_shell",
    "chrome-headless-shell-linux64/chrome-headless-shell",
  ];
  try {
    const entries = await readdir(browsersPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^chromium/.test(entry.name)) continue;
      for (const rel of REL_BINARIES) {
        const p = join(browsersPath, entry.name, rel);
        if (existsSync(p)) {
          return {
            ffmpeg: { found: ffmpegFound, path: ffmpegPath },
            chromium: { found: true, source: p },
          };
        }
      }
    }
  } catch {
    /* browsers dir missing */
  }
  return { ffmpeg: { found: ffmpegFound, path: ffmpegPath }, chromium: { found: false, source } };
}

// ΓöÇΓöÇ Job TTL eviction ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
// Sweep completed/errored jobs older than 1 hour so the Map never grows
// without bound. Active jobs (status='recording') are never evicted.

const JOB_TTL_MS = 60 * 60 * 1000; // 1 hour

function sweepStaleJobs(): void {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (job.status === "recording") continue; // never evict in-flight jobs
    if (job.retain) continue; // buyer-owned ΓÇö removed via deleteJob on listing purge
    const finishedAt = job.finishedAt ? new Date(job.finishedAt).getTime() : 0;
    if (finishedAt && now - finishedAt > JOB_TTL_MS) {
      // Best-effort file cleanup ΓÇö don't await here
      if (job.result?.mp4Path) {
        unlink(job.result.mp4Path).catch(() => {});
      }
      if (job.result?.thumbnailPath) {
        unlink(job.result.thumbnailPath).catch(() => {});
      }
      jobs.delete(id);
    }
  }
}

// Run sweep every 15 minutes. Attach to globalThis so hot reloads don't
// spawn duplicate intervals.
const globalAny2 = globalThis as any;
if (!globalAny2.__RALPH_RECORD_SWEEP__) {
  const sweep = setInterval(sweepStaleJobs, 15 * 60 * 1000);
  // Unref so the sweep never holds the process open (matches the marketplace
  // and scheduler background jobs) ΓÇö otherwise importing this module in
  // tests would keep the Node event loop alive forever.
  if ((sweep as any).unref) (sweep as any).unref();
  globalAny2.__RALPH_RECORD_SWEEP__ = sweep;
}

/**
 * Delete a finished job's MP4 file and remove it from the registry.
 * Safe to call even if the file is already gone ΓÇö always clears the job entry.
 */
export async function deleteJob(id: string): Promise<void> {
  const job = jobs.get(id);
  if (job?.result?.mp4Path) {
    try {
      await unlink(job.result.mp4Path);
    } catch {
      /* already gone ΓÇö fine */
    }
  }
  if (job?.result?.thumbnailPath) {
    try {
      await unlink(job.result.thumbnailPath);
    } catch {
      /* already gone ΓÇö fine */
    }
  }
  jobs.delete(id);
}

/**
 * Mark a finished recording as buyer-owned so the idle sweep never evicts it.
 * The file then lives until deleteJob() is called (the marketplace TTL purge
 * after the sold retention window). Returns false when the job is already
 * gone ΓÇö e.g. a restart wiped the in-memory registry ΓÇö in which case callers
 * should treat the file as possibly dead.
 */
export async function retainRecording(id: string): Promise<boolean> {
  const job = jobs.get(id);
  if (!job) return false;
  job.retain = true;
  return true;
}

/**
 * Age-based sweep of the recordings directory ΓÇö unlinks any MP4 older than
 * maxAgeMs. Safety net for orphan files whose job-registry entries were lost
 * (e.g. a bot restart clears the in-memory job map while files survive on
 * disk). Called by the marketplace TTL job; returns how many files removed.
 */
export async function deleteOldRecordings(
  maxAgeMs: number,
  protectedIds?: Set<string>,
): Promise<number> {
  const cutoff = Date.now() - maxAgeMs;
  let removed = 0;
  try {
    const entries = await readdir(RECORDINGS_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith(".mp4") && !entry.name.endsWith("-thumb.jpg")) continue;
      // Buyer-owned renders still within the sold retention window are exempt
      // (their job registry entries may be lost on restart, but the paid
      // deliverable must survive). The marketplace TTL passes them in.
      if (protectedIds?.has(entry.name.replace("-thumb.jpg", "").slice(0, -4))) continue;
      const filePath = join(RECORDINGS_DIR, entry.name);
      try {
        const s = await stat(filePath);
        if (s.mtimeMs < cutoff) {
          await unlink(filePath);
          removed++;
        }
      } catch {
        /* file may have vanished mid-sweep ΓÇö fine */
      }
    }
  } catch {
    /* directory missing ΓÇö nothing to clean */
  }
  return removed;
}

