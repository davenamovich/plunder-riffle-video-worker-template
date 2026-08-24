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
import { mkdir, stat, unlink, readdir, writeFile, open, rename, rm } from "fs/promises";
import { existsSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";
// === worker-only BEGIN: getEnv shim (bot imports { getEnv } from "../env") ===
// Standalone worker has no ../env module — inline the same fail-open reader so
// the engine below stays byte-identical to bot/src/lib/video/recorder.ts.
function getEnv(key: string, fallback: string = ""): string {
  const v = process.env[key];
  return v && v.trim().length > 0 ? v : fallback;
}
// === worker-only END: getEnv shim ===

// ΓöÇΓöÇ Types ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

export type ViewportPreset = "vertical" | "iphone14" | "iphone-se" | "pixel-7" | "galaxy-s22" | "landscape";
export type AspectRatio = "native" | "9:16" | "16:9";
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
  /** Role of the primary page/song audio. Legacy callers default to music, which loops. */
  primaryAudioRole?: "narration" | "music";
  /**
   * Second track: background music that DUCKS under the primary track
   * (narration). Falls back to the page's `<audio id="score">` element when
   * not passed. Browserless mode ignores it — that recorder bakes the page's
   * own audio into the webm, so mixing a copy would double it.
   */
  musicUrl?: string;
  /**
   * Landscape output — the default is 1080×1920 (9:16 vertical, matching the
   * old hardcoded canvas). Story Mode passes 1920×1080 for its long-form
   * documentary default. The recorded viewport should share the output aspect
   * so the page fills the frame edge-to-edge (fillsOutputAspect).
   */
  outWidth?: number;
  outHeight?: number;
  /**
   * Volume of the mixed audio track. The existing BGM mix is 0.5 (background
   * music under silence); narration wants full volume — Story Mode passes 1.0.
   * Undefined keeps the legacy 0.5 behavior.
   */
  audioVolume?: number;
  /** Bed level for the ducked music track before sidechain compression.
   *  Defaults to 0.16 — well under the narration, dipped further by the
   *  sidechain whenever the voice is present. */
  musicVolume?: number;
  /** Per-job watchdog override (defaults to jobTimeoutMs()). 5–6 min story
   *  renders need more than the 8-minute default once capture + encode are
   *  counted. */
  timeoutMs?: number;
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

export function recordingsDir(): string {
  return RECORDINGS_DIR;
}

const VIEWPORTS: Record<ViewportPreset, { width: number; height: number; name: string }> = {
  // Exactly 9:16 (432/768 = 0.5625). Recording the page at the SAME aspect as
  // the output means the finished video is edge-to-edge page instead of a
  // narrow phone screenshot floating in blurred filler.
  vertical: { width: 432, height: 768, name: "Vertical 9:16" },
  iphone14: { width: 390, height: 844, name: "iPhone 14" },
  "iphone-se": { width: 375, height: 667, name: "iPhone SE" },
  "pixel-7": { width: 412, height: 915, name: "Pixel 7" },
  "galaxy-s22": { width: 360, height: 780, name: "Galaxy S22" },
  // Exactly 16:9 (1280/720 = 1.777...). Story Mode's long-form documentary
  // default records at this aspect and composites to 1920×1080 edge-to-edge.
  landscape: { width: 1280, height: 720, name: "Landscape 16:9" },
};

export function viewportDims(preset: ViewportPreset): { width: number; height: number; name: string } {
  // Never return undefined: an unknown/legacy preset (e.g. "landscape" on a
  // worker build that predates it) would crash every render with
  // "Cannot read properties of undefined (reading 'width')". Falling back to
  // vertical keeps the job alive; outWidth/outHeight still drive the output.
  return VIEWPORTS[preset] || VIEWPORTS.vertical;
}

const VERTICAL_OUT_W = 1080;
const VERTICAL_OUT_H = 1920; // 9:16 vertical

export const OUTPUT_DIMS = { width: VERTICAL_OUT_W, height: VERTICAL_OUT_H };

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
const HOLD_FIRST_FRAME_MS = 6500;const POST_ROLL_MS = 2200; // cut 2s from end to remove white — small tail kept after the show when trimming
/**
 * Ceiling for AUTO-computed durations (3 min). Story Mode passes an explicit
 * durationMs (measured from the narration audio, up to ~6 min), which bypasses
 * this cap — the old Math.min() applied it to EVERY duration, so a 5–6 minute
 * story was silently cut to 3:00. Override with RECORD_AUTO_LEN_CAP_MS.
 */
function autoLenCapMs(): number {
  const raw = Number(getEnv("RECORD_AUTO_LEN_CAP_MS"));
  return Number.isFinite(raw) && raw > 0 ? raw : 180_000;
}
/** Hard ceiling for EXPLICIT durations — sanity guard only (15 min). */
const EXPLICIT_DURATION_CAP_MS = 900_000;
const DEFAULT_BEAT_MS = 5250; // FIXED: 5.25s per slide for all formats

// The closing CTA screen (the final `__vessel.setBeat(beatCount)` state, per
// the vessel contract above) used to be held for the SAME duration as every
// other beat — 6s for confession, 5.25s default, etc. Cap its recording
// window on its own so a long per-beat duration doesn't bloat the outro.
const LAST_FRAME_HOLD_MS = 5000;
// When a page carries spoken narration (TTS reused as the page's "bgm"
// element, or a real music bed), the mix below fades it out and pads with
// silence so the video always ends on a clean beat, not mid-word. This is
// the size of that trailing silent buffer — it must match the trim/fade
// points in the ffmpeg filter AND the audio-driven duration floor below, or
// the two disagree and the tail either truncates real speech or leaves dead
// air longer than intended.
const VOICE_TAIL_MS = 400;

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
  const ffmpegPath = getEnv("FFMPEG_PATH");
  if (ffmpegPath) return ffmpegPath;
  for (const p of ["/usr/bin/ffmpeg", "/usr/local/bin/ffmpeg"]) {
    if (existsSync(p)) return p;
  }
  return "ffmpeg"; // trust PATH
}

/**
 * Resolve a Chromium executable for Playwright.
 *
 * Priority: PLAYWRIGHT_CHROMIUM_PATH (only when the file actually exists — a
 * configured-but-missing binary is the #1 "MP4 not rendering" cause, so it
 * falls through to the fallbacks instead of crashing the launch) → common
 * system paths → undefined (let playwright-core use its own downloaded
 * browser — bot/Dockerfile installs it with `npx playwright-core install
 * chromium`, pinned to the same revision this module imports).
 */
export function resolveChromium(): string | undefined {
  const configured = getEnv("PLAYWRIGHT_CHROMIUM_PATH");
  if (configured) {
    if (existsSync(configured)) return configured;
    console.warn(
      `[recorder] PLAYWRIGHT_CHROMIUM_PATH points to a missing binary (${configured}) — ` +
        "falling back to Playwright's bundled browser",
    );
  }
  for (const p of ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/local/bin/chromium"]) {
    if (existsSync(p)) return p;
  }
  return undefined;
}

/**
 * True when a Playwright-managed chromium revision is installed in the usual
 * cache locations (Linux/macOS: ~/.cache/ms-playwright, Windows:
 * %LOCALAPPDATA%\ms-playwright). bot/Dockerfile installs it via `npx
 * playwright-core install chromium`.
 */
function playwrightBrowserPresent(): boolean {
  const candidates = [
    join(process.env.HOME || ".", ".cache", "ms-playwright"),
    join(process.env.LOCALAPPDATA || "", "ms-playwright"),
  ].filter((p) => p.length > 0);
  try {
    for (const dir of candidates) {
      const entries = readdirSync(dir, { withFileTypes: true });
      if (entries.some((e) => e.isDirectory() && e.name.toLowerCase().includes("chrom"))) {
        return true;
      }
    }
  } catch {
    /* one or both dirs missing — not installed */
  }
  return false;
}

/**
 * Boot-time health check for the recorder — surfaces a broken ffmpeg/chromium
 * setup the moment the server starts instead of discovering it from the first
 * failed MP4 render (see warnIfRecorderMisconfigured in lib/recorder.ts).
 */
export function diagnoseRecorderEnvironment(): {
  ffmpegPath: string;
  ffmpegFound: boolean;
  chromiumSource: string;
  chromiumFound: boolean;
} {
  const ffmpegPath = resolveFfmpeg();
  let ffmpegFound: boolean;
  if (ffmpegPath === "ffmpeg") {
    // PATH fallback — probe it for real rather than assuming. The timeout
    // keeps a wedged probe from hanging /health (spawnSync blocks the event
    // loop while it runs).
    const probe = spawnSync("ffmpeg", ["-version"], { stdio: "ignore", timeout: 5000 });
    ffmpegFound = !probe.error && probe.status === 0;
  } else {
    ffmpegFound = existsSync(ffmpegPath);
  }
  const configured = getEnv("PLAYWRIGHT_CHROMIUM_PATH");
  let chromiumFound: boolean;
  let chromiumSource: string;
  if (configured) {
    chromiumSource = configured;
    chromiumFound = existsSync(configured);
  } else {
    chromiumSource = "playwright-managed browser (~/.cache/ms-playwright)";
    chromiumFound = playwrightBrowserPresent();
  }
  return { ffmpegPath, ffmpegFound, chromiumSource, chromiumFound };
}

export type RecorderHealth = ReturnType<typeof diagnoseRecorderEnvironment>;

let recorderDiagCache: { at: number; diag: RecorderHealth } | null = null;
const RECORDER_DIAG_TTL_MS = 60_000;

/**
 * Cached recorder health — for /health and any monitoring surface. The raw
 * diagnostic spawns `ffmpeg -version` (a subprocess probe); health checks hit
 * this endpoint every few seconds, so the result is cached for a minute.
 */
export function getRecorderHealth(): RecorderHealth {
  const now = Date.now();
  if (recorderDiagCache && now - recorderDiagCache.at < RECORDER_DIAG_TTL_MS) {
    return recorderDiagCache.diag;
  }
  const diag = diagnoseRecorderEnvironment();
  recorderDiagCache = { at: now, diag };
  return diag;
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
  const raw = Number(getEnv("RECORD_FFMPEG_TIMEOUT_MS"));
  return Number.isFinite(raw) && raw > 0 ? raw : 300_000;
}

/**
 * Run ffmpeg to completion. Robust where child_process `exec` is not: spawn
 * streams stderr through a ring buffer instead of the 1MB maxBuffer cap that
 * kills long re-encodes (the Superhybrid stitch), and SIGKILLs after
 * ffmpegTimeoutMs() so a wedged encode can't hang the caller forever.
 * Rejects with the tail of stderr on a non-zero exit.
 */
export function runFfmpeg(args: string[]): Promise<void> {
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
      const fullStderr = Buffer.concat(stderrChunks).toString();
      if (process.env.DEBUG_FFMPEG) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const { writeFileSync } = require("fs") as typeof import("fs");
          const dump = join(tmpdir(), `ffmpeg-debug-${Date.now()}.log`);
          writeFileSync(dump, fullStderr);
          console.log(`[recorder] full stderr dumped to ${dump}`);
        } catch {}
      }
      const stderr = fullStderr.slice(-3000);
      reject(new Error(`FFmpeg exited ${code}: ${stderr}`));
    });
    ffmpeg.on("error", (e) => {
      clearTimeout(killer);
      reject(e);
    });
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
function fillsOutputAspect(phoneW: number, phoneH: number, outW: number, outH: number): boolean {
  const target = outW / outH;
  return Math.abs(phoneW / phoneH - target) < 0.01;
}

/**
 * Where the phone screen sits inside the output canvas. Shared by the
 * composite filter and the thumbnail's blank-frame check, which has to measure
 * the page pixels rather than the whole canvas. Default output is the legacy
 * 1080×1920 canvas; Story Mode passes 1920×1080.
 */
function phoneRect(phoneW: number, phoneH: number, outW: number, outH: number) {
  const margin = 160;
  const targetH = outH - margin * 2;
  const scaledWBase = Math.round((targetH * phoneW) / phoneH);
  const scaledW = scaledWBase % 2 === 0 ? scaledWBase : scaledWBase + 1;
  const x = Math.round((outW - scaledW) / 2);
  return { margin, targetH, scaledW, x };
}

/**
 * ffmpeg crop expression isolating the page pixels in the finished MP4.
 * Undefined when the page already fills the frame — there is nothing to crop
 * away, and the whole frame IS the page.
 */
function phoneCropFilter(phoneW: number, phoneH: number, outW: number, outH: number): string | undefined {
  if (fillsOutputAspect(phoneW, phoneH, outW, outH)) return undefined;
  const { margin, targetH, scaledW, x } = phoneRect(phoneW, phoneH, outW, outH);
  return `crop=${scaledW}:${targetH}:${x}:${margin}`;
}

/**
 * @param holdSec When > 0, clone the first frame for this long before the show
 *   moves, and skip the fade-up. Used by the screencast path so the poster
 *   frame is a solid, fully-lit hero rather than a black-to-hero blend.
 *   The frames/slideshow path passes 0 and keeps its original fade.
 * @param noFade Skip the fade-up independently of `holdSec`. Interactive
 *   (slideshow) pages MUST keep holdSec at 0 — a tpad clone shifts the video
 *   timeline later while the mixed narration still starts at t=0, which is
 *   the audio-desync bug `computeScreencastTrim` exists to avoid — but they
 *   still ship the trimmed frame 0 as the file's own poster frame (platforms
 *   sample frame 0 of the delivered MP4 directly), so that frame can't be
 *   allowed to fade up from black either. Pass true there to get a clean,
 *   immediately-visible opening frame with zero effect on duration/sync.
 */
function buildCompositeFilter(
  background: BackgroundStyle,
  phoneW: number,
  phoneH: number,
  holdSec = 0,
  trimSec = 0,
  outW = VERTICAL_OUT_W,
  outH = VERTICAL_OUT_H,
  noFade = false,
): string {
  const chains: string[] = [];
  const trim = trimSec > 0 ? `trim=start=${trimSec.toFixed(3)},setpts=PTS-STARTPTS,` : "";
  // tpad clones the FIRST frame of the (already trimmed) input, so the hold is
  // built from the clean hero rather than from whatever preceded it.
  const hold =
    holdSec > 0 ? `tpad=start_duration=${holdSec.toFixed(3)}:start_mode=clone,` : "";
  const skipFade = holdSec > 0 || noFade;

  // ── Full-bleed path ──
  // When the page was recorded at the output aspect there is nothing to letterbox:
  // scale to cover and crop off the rounding, so the video is 100% page. The
  // blurred-bezel treatment below only exists to fill space a non-9:16 source
  // leaves behind, and running it on a 9:16 source would shrink the page for
  // no reason.
  if (fillsOutputAspect(phoneW, phoneH, outW, outH)) {
    const tail = skipFade ? "" : ",fade=t=in:st=0:d=0.2";
    chains.push(
      `[0:v]${trim}${hold}scale=${outW}:${outH}:force_original_aspect_ratio=increase,` +
        `crop=${outW}:${outH},setsar=1${tail}[out]`,
    );
    return chains.join(";");
  }

  chains.push(
    `[0:v]${trim}${hold}scale=${phoneW}:${phoneH}:force_original_aspect_ratio=decrease,pad=${phoneW}:${phoneH}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1[screen]`,
  );

  // A fade-up from black is exactly what ruins a poster frame, so it is
  // skipped whenever we're holding the opening frame OR the caller has
  // otherwise flagged this frame as poster-critical (noFade).
  const finish = skipFade ? `[ovr]null[out]` : `[ovr]fade=t=in:st=0:d=0.2[out]`;

  const { margin, targetH, scaledW, x } = phoneRect(phoneW, phoneH, outW, outH);

  if (background === "blur") {
    chains.push("[screen]split=2[src_bg][src_fg]");
    // Downscale background to 270x480 first to make gblur 16x faster, then upscale back to outW:outH.
    // Reducing sigma to 10 on the smaller canvas produces the same visual blur radius as sigma 40 on the full canvas.
    chains.push(
      `[src_bg]scale=270:480:force_original_aspect_ratio=increase,crop=270:480,gblur=sigma=10,eq=brightness=-0.3,scale=${outW}:${outH}[bg]`,
    );
    chains.push(`[src_fg]scale=${scaledW}:${targetH},setsar=1[fg]`);
    chains.push(`[bg][fg]overlay=${x}:${margin}:format=auto[ovr]`);
    chains.push(finish);
  } else if (background === "gradient") {
    chains.push(`color=c=0x1a1a2e:s=${outW}x${outH}[gradbase]`);
    chains.push(
      `[gradbase]geq=r='r(X,Y)*(1-(Y/H)*0.6)':g='g(X,Y)*(1-(Y/H)*0.6)':b='b(X,Y)*(1-(Y/H)*0.6)+30'[bg]`,
    );
    chains.push(`[screen]scale=${scaledW}:${targetH},setsar=1[fg]`);
    chains.push(`[bg][fg]overlay=${x}:${margin}:format=auto[ovr]`);
    chains.push(finish);
  } else {
    chains.push(`color=c=0x000000:s=${outW}x${outH}[bg]`);
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
    // Same reasoning as runFfmpeg: a probe that hangs would pin the render slot.
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
  // A frame is blank if it is almost completely flat (uniform color), regardless of 
  // whether it is white, grey, or black. 
  return s.sd <= BLANK_SD_MAX;
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
      await runFfmpeg(["-y", "-ss", t.toFixed(3), "-i", mp4Path, "-vframes", "1", "-vf", "scale=-1:320", "-q:v", "2", thumbPath]);
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
      "-vf",
      "scale=-1:320",
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
export async function resolveAudioForMix(
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

  const startMs = Date.now();

  // Pages that declare their own recording length (VESSEL.recordDurationMs)
  // set waitFullDuration: their CTA screen is the FINAL FRAME of the show and
  // must stay on screen for the rest of the budget, so the driver ignores the
  // page's "show finished" signals and records the full window. Without this,
  // a beat-driven page that looks even slightly scrollable (full-bleed beats
  // overflow body.locked by a few px) gets scroll-cut to ~2-4s instead of the
  // declared 30-60s.
  const isDone = () =>
    cfg.waitFullDuration
      ? Date.now() - startMs >= cfg.totalMs
      : window.__vesselDone === true ||
        window.__recordingFinished === true ||
        window.__slideshowDone === true ||
        Date.now() - startMs >= cfg.totalMs;

  // Self-animating (interactive) pages must NEVER be scrolled, even when
  // maxScroll is a small positive number. Slideshow/whiteboard/story layouts
  // routinely overflow body by a few px (full-bleed beats, caption overlays),
  // and previously that was enough to send the driver into the scroll branch
  // below: it ramps window.scrollTo(0, y) up to that small maxScroll over
  // SCROLL_PX_PER_SEC, which is exactly the "first frame moves down like
  // auto-scroll and becomes off-centered" bug — the recording starts
  // centered, visibly nudges down a few px right after the intro hold, then
  // sits shifted for the rest of the show once y clamps at maxScroll. The
  // isInteractive flag used to only change the isDone()/exit condition below,
  // not whether to scroll at all, so it didn't prevent this. Treat any
  // self-animating page the same as a genuinely non-scrollable one: just wait
  // the show out.
  if (maxScroll <= 0 || cfg.isInteractive) {
    while (!isDone()) {
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
        if (cfg.isInteractive && isDone()) return resolve();
        const now = performance.now();
        const dt = (now - last) / 1000;
        last = now;
        const prevY = y;
        y = Math.min(maxScroll, y + cfg.pxPerSec * dt);
        window.scrollTo(0, Math.round(y));
        if (Math.round(y) !== Math.round(prevY)) lastFrameChangeTime = Date.now();
        
        if (cfg.isInteractive) {
          requestAnimationFrame(step);
        } else {
          if (Date.now() - lastFrameChangeTime >= cfg.maxIdleMs) return resolve();
          if (y < maxScroll) requestAnimationFrame(step);
          else resolve();
        }
      };
      requestAnimationFrame(step);
    });
  } else {
    const scrollMs = Math.max(500, cfg.totalMs - cfg.introMs - cfg.outroMs);
    await new Promise((resolve) => {
      const start = performance.now();
      const tick = () => {
        if (cfg.isInteractive && isDone()) return resolve();
        const elapsed = performance.now() - start;
        const t = Math.min(1, elapsed / scrollMs);
        const eased = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
        window.scrollTo(0, Math.round(eased * maxScroll));
        
        if (cfg.isInteractive) {
          requestAnimationFrame(tick);
        } else {
          if (Date.now() - lastFrameChangeTime >= cfg.maxIdleMs) return resolve();
          if (t < 1) requestAnimationFrame(tick);
          else resolve();
        }
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

/**
 * The page contract shared by both recorders: vessel/beats/audio detection
 * from the generated page. One source of truth (the self-hosted engine's
 * inline version was extracted into this so the Browserless adapter behaves
 * identically).
 */
export interface PageInfoForRecording {
  beatCount: number;
  vesselBeatCount: number;
  beatMs: number;
  declaredBeats: number;
  hasVesselHook: boolean;
  hasLanding: boolean;
  audioSrc: string | null;
  /** Background-music element (`<audio id="score">`) — ducked under audioSrc. */
  musicSrc: string | null;
  audioDurationSec: number;
  /**
   * Authoritative recording duration (ms) baked into the page by the HTML
   * builder via `window.VESSEL.recordDurationMs`. When present it overrides
   * every beat-counting heuristic in computeScreencastDurationMs so the
   * recorder captures exactly as much as the page was designed to fill.
   */
  recordDurationMs: number;
  /** Whether the page is interactive and the scroll driver should wait for it */
  isInteractive?: boolean;
  /** AppSlides fast path: the page exposes __vessel.appslides + setBeat. */
  appslidesVessel: boolean;
  /** CTA slide hold duration (ms) — appslides keeps its CTA on screen longer. */
  ctaMs: number;
  /** 0-indexed position of the CTA slide within the beat sequence. */
  ctaIndex: number;
}

export async function collectPageInfo(page: any): Promise<PageInfoForRecording> {
  return page
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
      // Story Mode's music bed — played under the narration on the page, and
      // mixed (ducked) into the MP4 by the recorder.
      const musicSrc =
        document.getElementById("score")?.getAttribute("src") ||
        document.getElementById("music")?.getAttribute("src") ||
        null;
      let audioDurationSec = 0;
      if (anyAudio && anyAudio.duration && isFinite(anyAudio.duration) && anyAudio.duration > 0) {
        audioDurationSec = anyAudio.duration;
      }
      // Hybrid pages expose the iMessage conversation as leading vessel
      // frames: __hybridMsgCount message beats + 1 link-card beat + the
      // slideshow beats. Count them so the capture includes the conversation
      // (the actual ad), not just the slideshow, and the last slideshow beat
      // + CTA land on the right frames (the +1 is the link card).
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
        ),
        vesselBeatCount: vesselBeats + hybridMsgCount + (hybridMsgCount > 0 ? 1 : 0),
        beatMs: Number(vessel.beatMs) || 0,
        declaredBeats: Number(vessel.beats) || 0,
        hasVesselHook: typeof vesselHook.setBeat === "function",
        hasLanding: vesselHook.hasLanding === true,
        audioSrc: audioSrc || null,
        musicSrc: musicSrc || null,
        audioDurationSec,
        recordDurationMs: Number(vessel.recordDurationMs) || 0,
        isInteractive: vessel.isInteractive === true,
        appslidesVessel: vesselHook.appslides === true,
        ctaMs: Number(vessel.ctaMs) || 0,
        ctaIndex: Number.isFinite(Number(vessel.ctaIndex)) ? Number(vessel.ctaIndex) : -1,
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
      musicSrc: null as string | null,
      audioDurationSec: 0,
      recordDurationMs: 0,
      isInteractive: false,
      appslidesVessel: false,
      ctaMs: 0,
      ctaIndex: -1,
    }));
}

// AppSlides fast path (faster-than-realtime) — appslides is a deck of static
// full-bleed slides (no hyperframes, no chat animation), so it can be rendered
// by screenshotting each settled slide and crossfading the stills instead of
// recording the page playing out in real time. This is the one format where the
// screenshot approach is safe; the legacy Vessel path was removed (8c36199)
// because it broke live recording for the animated formats, so this stays
// scoped to appslides only (pageInfo.appslidesVessel).

const APPSLIDE_OUTRO_SEC = 1.5; // matches app-slideshow-html.ts OUTRO_MS (final-slide hold)

async function captureAppSlidesFrames(
  browser: any,
  pageUrl: string,
  opts: RecordOptions,
  beatCount: number,
  dir: string,
): Promise<string[]> {
  const vp = VIEWPORTS[opts.viewport || "vertical"];
  const { devices } = await import("playwright-core");
  const ctx = await browser.newContext({
    ...devices["iPhone 14"],
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: SUPERSAMPLE,
    reducedMotion: "reduce" as const,
  });
  const page = await ctx.newPage();

  const url = new URL(pageUrl);
  url.searchParams.set("mode", "frame");
  try {
    await page.goto(url.toString(), { waitUntil: opts.waitUntil || "load", timeout: 30_000 });
  } catch (err: any) {
    console.warn(`[recorder] appslides capture goto warning: ${err?.message ?? err}`);
  }

  // Fonts must settle before the first screenshot, then wait for the hook.
  try {
    await page.evaluate(() => (document as any).fonts?.ready).catch(() => {});
  } catch {}
  try {
    await page.waitForFunction(() => (window as any).__vessel?.ready === true, {
      timeout: 10_000,
    });
  } catch {}

  const paths: string[] = [];
  for (let n = 0; n < beatCount; n++) {
    await page
      .evaluate((idx: number) => {
        const v = (window as any).__vessel;
        if (v && typeof v.setBeat === "function") v.setBeat(idx);
      }, n)
      .catch(() => {});
    await page.waitForTimeout(n === 0 ? 1800 : 350);
    // JPEG, not PNG: ffmpeg 8.x's PNG decoder intermittently fails with
    // "inflate returned error -3" on looped still inputs; JPEG decode is solid
    // and the slight loss is invisible after the x264 pass.
    const p = join(dir, `appslide-${n}.jpg`);
    await page.screenshot({ path: p, type: "jpeg", quality: 95 });
    paths.push(p);
  }

  await ctx.close().catch(() => {});
  return paths;
}

/**
 * Wait for the currently-visible beat/CTA screen to actually be paint-ready
 * before a still is captured: every <img> and CSS background-image inside it
 * loaded, and any CSS animation running on it (the beat fade-in, the
 * hyperframe burst/flash) has finished. Bounded by maxMs so a broken/404
 * image can never hang the capture — it just falls through to whatever
 * state the page is in once the deadline passes, same as the old blind
 * timeout did every time.
 *
 * This replaces a fixed page.waitForTimeout() that assumed a beat's assets
 * were always ready well inside the window. They aren't guaranteed to be:
 * background-image on an element inside a display:none ancestor isn't
 * fetched by the browser until that ancestor becomes visible, so a beat's
 * gif only starts downloading the moment setBeat() reveals it — a genuine
 * network fetch racing a fixed 1000ms clock. Waiting for real readiness
 * instead of guessing a duration is what actually fixes an intermittent
 * black/half-loaded frame, whichever beat it happens to land on.
 */
async function waitForBeatReady(page: any, maxMs: number): Promise<void> {
  await page
    .evaluate(async (maxWaitMs: number) => {
      function visibleRoot(): Element {
        const beats = document.querySelectorAll(".beat");
        for (let i = 0; i < beats.length; i++) {
          const b = beats[i] as HTMLElement;
          if (getComputedStyle(b).display !== "none") return b;
        }
        const cta = document.querySelector("#cta-screen.active");
        return cta || document.body;
      }
      const root = visibleRoot();
      const waits: Promise<unknown>[] = [];

      root.querySelectorAll("img").forEach((img) => {
        const el = img as HTMLImageElement;
        if (!el.complete) {
          waits.push(new Promise((res) => { el.onload = res; el.onerror = res; }));
        }
      });

      root.querySelectorAll("*").forEach((el) => {
        const bg = getComputedStyle(el as Element).backgroundImage;
        const m = bg && /url\(["']?(.*?)["']?\)/.exec(bg);
        const src = m && m[1];
        if (src) {
          const probe = new Image();
          waits.push(new Promise((res) => { probe.onload = res; probe.onerror = res; probe.src = src; }));
        }
      });

      if (typeof (document as any).getAnimations === "function") {
        for (const anim of (document as any).getAnimations() as any[]) {
          const target = anim.effect && anim.effect.target;
          if (target && root.contains(target)) {
            waits.push((anim.finished as Promise<unknown>).catch(() => {}));
          }
        }
      }

      const deadline = new Promise((res) => setTimeout(res, maxWaitMs));
      await Promise.race([Promise.all(waits), deadline]);
      // One extra rAF round-trip so the browser has actually painted
      // whatever just finished loading/animating before we screenshot.
      await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
    }, maxMs)
    .catch(() => {});
}

/**
 * Screenshot each content beat + the CTA screen of a viral-framework /
 * hybrid-slideshow page as static PNGs, for TikTok/Instagram photo-carousel
 * posting (postSlideshowCarousel in ../slideshow-carousel-post.ts). Mirrors
 * captureAppSlidesFrames's setBeat()-driven approach but:
 *   - returns Buffers (no ffmpeg downstream, no temp files, PNG not JPEG)
 *   - waits for each beat's images/animations to actually settle (see
 *     waitForBeatReady) instead of a fixed guess — these pages have real
 *     CSS entrance animations and lazily-fetched background gifs that
 *     captureAppSlidesFrames's target file does not
 *   - derives msgCount/CTA index itself from collectPageInfo() so callers
 *     never have to know the beat-index math
 *
 * v1 is local-chromium only (same as captureAppSlidesFrames's own scope) —
 * callers should gate on getRecorderHealth().chromiumFound first and fall
 * back to the normal MP4 path when it's false (Browserless/external-only
 * deployments). Wiring Browserless support here would require importing
 * browserlessConfig from ../video/browserless, which itself imports FROM
 * this file — a circular import — so that's left as a future follow-up.
 */
export async function captureSlideshowStillFrames(
  pageUrl: string,
  opts: { viewport?: { width: number; height: number } } = {},
): Promise<Buffer[]> {
  const { chromium, devices } = await import("playwright-core");
  const vp = opts.viewport || { width: 540, height: 960 }; // ×2 supersample = 1080×1920, matches appslides output
  const browser = await chromium.launch({
    headless: true,
    executablePath: resolveChromium(),
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
  });
  try {
    const ctx = await browser.newContext({
      ...devices["iPhone 14"],
      viewport: vp,
      deviceScaleFactor: SUPERSAMPLE,
      reducedMotion: "reduce" as const,
    });
    const page = await ctx.newPage();
    const url = new URL(pageUrl);
    url.searchParams.set("mode", "frame");
    await page.goto(url.toString(), { waitUntil: "load", timeout: 30_000 }).catch(() => {});
    await page.evaluate(() => (document as any).fonts?.ready).catch(() => {});
    await page
      .waitForFunction(() => (window as any).__vessel?.ready === true, { timeout: 10_000 })
      .catch(() => {});

    const pageInfo = await collectPageInfo(page);
    if (pageInfo.beatCount < 1) throw new Error("Slideshow capture: no beats found on page");
    // hasLanding is only true for hybrid pages with a leading iMessage
    // conversation; msgCount is not a direct field on PageInfoForRecording
    // but is exactly derivable from the two counts collectPageInfo does
    // expose (see the doc comment on PageInfoForRecording.vesselBeatCount).
    const msgCount = pageInfo.hasLanding
      ? Math.max(0, pageInfo.vesselBeatCount - pageInfo.beatCount - 1)
      : 0;
    const ctaFrame = pageInfo.beatCount + msgCount + 1;

    const frames: Buffer[] = [];
    for (let i = 0; i < pageInfo.beatCount; i++) {
      // __vessel.setBeat()'s index contract only applies the
      // "msgCount+1" message/link-card offset on hybrid pages
      // (isHybrid && msgCount > 0 in ralph/slideshow-html.ts — the exact
      // condition mirrored by pageInfo.hasLanding here). Plain (non-hybrid)
      // Viral Framework pages map setBeat(n) straight to beat index n, so
      // applying the hybrid +1 offset there shifted every capture forward
      // by one beat: beat 0 (the hook) was never screenshotted, and the
      // last iteration asked for an out-of-range beat index, which
      // showBeat() renders as all-beats-hidden — a solid black frame at a
      // fixed, deterministic position in every non-hybrid carousel.
      const n = pageInfo.hasLanding ? msgCount + 1 + i : i;
      await page.evaluate((idx: number) => (window as any).__vessel?.setBeat(idx), n).catch(() => {});
      // These pages fade each beat in via real CSS animation and lazily
      // fetch each beat's background gif the instant it becomes visible
      // (unlike app-slideshow-html.ts, which captureAppSlidesFrames's fixed
      // 350ms wait is tuned for) — wait for actual readiness, bounded by a
      // generous ceiling, instead of guessing a fixed duration.
      await waitForBeatReady(page, i === 0 ? 2400 : 1800);
      frames.push(await page.screenshot({ type: "jpeg", quality: 95 }));
    }
    await page
      .evaluate((idx: number) => (window as any).__vessel?.setBeat(idx), ctaFrame)
      .catch(() => {});
    await waitForBeatReady(page, 1800);
    frames.push(await page.screenshot({ type: "jpeg", quality: 95 })); // CTA slide, last

    await ctx.close().catch(() => {});
    return frames;
  } finally {
    await browser.close().catch(() => {});
  }
}

async function assembleAppSlidesVideo(
  frames: string[],
  durationsSec: number[],
  outPath: string,
  outW: number,
  outH: number,
): Promise<number> {
  const n = frames.length;
  if (n < 1) throw new Error("assembleAppSlidesVideo: need >= 1 frame");
  const T = TRANSITION_SEC;

  const args: string[] = ["-y"];
  for (const f of frames) args.push("-loop", "1", "-framerate", String(FPS), "-i", f);

  const parts: string[] = [];
  for (let i = 0; i < n; i++) {
    parts.push(
      `[${i}:v]trim=duration=${durationsSec[i].toFixed(3)},setpts=PTS-STARTPTS,` +
        `scale=${outW}:${outH}:force_original_aspect_ratio=increase,crop=${outW}:${outH},` +
        `setsar=1,fps=${FPS}[v${i}]`,
    );
  }

  let prev = "[v0]";
  let finalLabel = "[v0]";
  let acc = 0;
  for (let k = 1; k < n; k++) {
    acc += durationsSec[k - 1];
    const offset = (acc - k * T).toFixed(3);
    const out = k === n - 1 ? "[vout]" : `[x${k}]`;
    parts.push(`${prev}[v${k}]xfade=transition=fade:duration=${T}:offset=${offset}${out}`);
    prev = out;
    finalLabel = out;
  }

  // Outro: clone the final slide for APPSLIDE_OUTRO_SEC so the tail matches the
  // live deck's OUTRO_MS (the page holds the last slide a beat longer).
  parts.push(
    `${finalLabel}tpad=stop_duration=${APPSLIDE_OUTRO_SEC.toFixed(3)}:stop_mode=clone[vfinal]`,
  );
  finalLabel = "[vfinal]";

  const total = durationsSec.reduce((s, d) => s + d, 0) - (n - 1) * T + APPSLIDE_OUTRO_SEC;

  args.push("-filter_complex", parts.join(";"));
  args.push("-map", finalLabel);
  args.push(
    "-c:v", "libx264", "-profile:v", "high", "-level", "4.0", "-preset", "medium",
    "-crf", "19", "-pix_fmt", "yuv420p", "-r", String(FPS), "-g", String(FPS * 2),
    "-movflags", "+faststart", "-t", total.toFixed(3), outPath,
  );
  await runFfmpeg(args);
  return total;
}

/**
 * Screencast duration. Priority order:
 *  1. `opts.durationMs` (explicit caller override — e.g. Story Mode narration length)
 *  2. `pageInfo.recordDurationMs` (baked into the page by the HTML builder via
 *     `window.VESSEL.recordDurationMs`) — the authoritative per-format target so
 *     the recorder captures exactly what the page was designed to fill
 *  3. Beat-counting heuristics (declared beats > DOM count > default)
 *
 * Shared with the Browserless adapter so both recorders make the same-length videos.
 */
export function computeScreencastDurationMs(
  pageInfo: PageInfoForRecording,
  opts: { durationMs?: number; autoDuration: boolean },
): number {
  const beatMs = pageInfo.beatMs || DEFAULT_BEAT_MS;
  let durationMs = opts.durationMs || 0;
  const explicit = !opts.autoDuration && opts.durationMs;

  if (explicit) {
    // Caller-supplied explicit duration — pass through with sanity ceiling.
    return Math.min(durationMs, EXPLICIT_DURATION_CAP_MS);
  }

  if (opts.autoDuration && !durationMs) {
    // ── Priority 2: page-declared target duration ─────────────────────────
    if (pageInfo.recordDurationMs > 0) {
      console.log(`[recorder] Using page-declared recordDurationMs: ${pageInfo.recordDurationMs}ms`);
      durationMs = pageInfo.recordDurationMs;
    } else if (pageInfo.declaredBeats > 0) {
      // Every beat up to the last gets its normal per-format pace; the final
      // beat (the CTA screen) is capped at LAST_FRAME_HOLD_MS regardless of
      // beatMs — see the constant's comment above.
      const bodyBeats = Math.max(0, pageInfo.declaredBeats - 1);
      durationMs = Math.round(bodyBeats * beatMs + LAST_FRAME_HOLD_MS);
    } else if (pageInfo.beatCount > 0) {
      durationMs = pageInfo.beatCount * beatMs + LAST_FRAME_HOLD_MS;
    } else {
      durationMs = DEFAULT_BEAT_MS * 3;
    }
    if (pageInfo.audioDurationSec > 0) {
      // Floor must be at least as large as the VOICE_TAIL_MS the ffmpeg mix
      // trims/fades off the end, or that trim eats into real speech instead
      // of the silent buffer it's meant to be.
      durationMs = Math.max(durationMs, Math.round(pageInfo.audioDurationSec * 1000) + VOICE_TAIL_MS);
    }
  }

  // Auto-computed durations respect the (env-overridable) cap.
  return Math.min(durationMs || DEFAULT_BEAT_MS * 3, autoLenCapMs());
}

/**
 * The config handed to the in-page scroll driver. Pure + exported so the flag
 * wiring (waitFullDuration / isInteractive / totalMs) is unit-testable — the
 * string-embedded driver itself can't be, and a dropped flag here is exactly
 * the kind of regression that would silently re-shorten every slideshow.
 */
export function buildDriverConfig(opts: {
  autoDuration: boolean;
  durationMs: number;
  isInteractive?: boolean;
  waitFullDuration?: boolean;
}) {
  return {
    mode: opts.autoDuration ? "auto" : "fixed",
    pxPerSec: SCROLL_PX_PER_SEC,
    introMs: INTRO_HOLD_MS,
    outroMs: OUTRO_HOLD_MS,
    totalMs: opts.durationMs,
    isInteractive: !!opts.isInteractive,
    waitFullDuration: !!opts.waitFullDuration,
    maxIdleMs: 4000,
  };
}

/**
 * Auto-start fallback + scroll driver, shared with the Browserless adapter.
 * Scrollable pages scroll at a comfortable pace with intro/outro holds; fixed
 * pages wait out the duration.
 */
export async function drivePageForRecording(
  page: any,
  opts: {
    autoDuration: boolean;
    durationMs: number;
    isInteractive?: boolean;
    /** True when the page declares VESSEL.recordDurationMs — record the full
     *  window, ignoring the page's own __vesselDone/__recordingFinished. */
    waitFullDuration?: boolean;
  },
): Promise<void> {
  // Auto-start playback
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

  await page
    .evaluate(`(${SCROLL_DRIVER_SRC})(${JSON.stringify(buildDriverConfig(opts))})`)
    .catch(() => {});

  await page.waitForTimeout(300);
}

export interface ScreencastTrimResult {
  /** ffmpeg `-ss` into the webm (seconds). */
  startSec: number;
  /** tpad clone hold for the opening frame (seconds; 0 = none). */
  holdSec: number;
  /** Encoded show length (seconds) — the `-t` for the output. */
  showDurSec: number;
  /** Poster-frame moment inside the finished MP4 (seconds). */
  thumbSec: number;
}

/**
 * Where a screencast MP4 should start, hold, and end. Pure math so the
 * recorder's timing is unit-testable without ffmpeg.
 *
 *  - INTERACTIVE pages (audio-driven Story Mode, slideshows that animate
 *    themselves): trim EXACTLY at the stamped show start. Pages that carry a
 *    separately-mixed narration track (`hasVoice`) hold NOTHING — a `tpad`
 *    clone of the first frame shifts the video later while the narration
 *    still runs from t=0, so the voice drifts ~1.5s ahead of the scenes.
 *    Silent beat-driven pages keep a short 1.5s hold so the opening frame
 *    never shows an animation/font-load glitch. The legacy path applied a
 *    6.5s `tpad` clone of the webm's FIRST frame (the pre-render blank) then
 *    trimmed past the show start with a blind +1.5s hack — the clone pushed
 *    real content 6.5s later while the mixed audio ran from t=0, which is
 *    the blank-opening / narration-out-of-sync bug.
 *  - STATIC pages (scrolled blog posts): legacy behavior — blind trim past
 *    the lead + a held first frame for a stable poster.
 */
export function computeScreencastTrim(input: {
  showStartMs: number;
  showEndMs: number;
  durationMs: number;
  videoLenSec: number | null;
  isInteractive: boolean;
  /** True when the page's narration is mixed in as a separate track (Story
   *  Mode's <audio id="bgm">). Suppresses the opening frame hold so the
   *  video and the narration stay in lock-step. */
  hasVoice?: boolean;
}): ScreencastTrimResult {
  const totalRecordedSec = Math.max(0.5, input.showEndMs / 1000);
  const videoLenSec = input.videoLenSec ?? totalRecordedSec;

  // Explicit durations pass through up to the 15-min safety ceiling; auto ones
  // are capped at autoLenCapMs() upstream.
  const targetDurSec = Math.min(
    EXPLICIT_DURATION_CAP_MS / 1000,
    Math.max(0.5, (input.durationMs + POST_ROLL_MS) / 1000),
  );

  if (input.isInteractive) {
    const startSec = Math.max(0, input.showStartMs / 1000);
    const maxAvailableSec = Math.max(0.5, videoLenSec - startSec);
    return {
      startSec,
      // Narration is mixed separately at t=0, so a held opening frame would
      // leave the voice running ~1.5s ahead of the visuals. Only silent
      // beat-driven pages get the glitch-free hold.
      holdSec: input.hasVoice ? 0 : 1.5,
      showDurSec: Math.min(targetDurSec, maxAvailableSec),
      // Poster moment after the entrance fade so the thumbnail isn't a dark
      // just-started frame (the page's title fades in over ~0.65s).
      thumbSec: 1.0,
    };
  }

  const FRONT_BUFFER_SEC = 0.5;
  const tailSec = 0.35; // 300ms wait + ~50ms page.close overhead
  const actualLeadIn = Math.max(0, videoLenSec - targetDurSec - tailSec);
  const baseStartSec = Math.max(0, actualLeadIn - FRONT_BUFFER_SEC);
  // We explicitly extended the HTML intro by 1.5s (e.g. 3000ms -> 4500ms)
  // so we can blindly trim an extra 1.5s here to guarantee we skip any
  // Chromium white-screen/loading flashes, landing squarely on the rendered frame.
  const startSec = baseStartSec + 1.5;

  const appliedFrontBuffer = actualLeadIn - baseStartSec;
  const targetDurSecWithBuffer = targetDurSec + appliedFrontBuffer;
  const maxAvailableSec = Math.max(0.5, videoLenSec - startSec);
  return {
    startSec,
    holdSec: HOLD_FIRST_FRAME_MS / 1000,
    showDurSec: Math.min(targetDurSecWithBuffer, maxAvailableSec),
    thumbSec: 0.0,
  };
}

export interface ComposeScreencastInput {
  webmPath: string;
  mp4Path: string;
  thumbPath: string;
  /** Recorded offset (ms) of the show start — cut point for the blank lead. */
  showStartMs: number;
  /** Total recorded length (ms) — bounds the encoded file. */
  showEndMs: number;
  durationMs: number;
  viewport: { width: number; height: number; name: string };
  background: BackgroundStyle;
  audioPath?: string | null;
  /** Background music track (ducked under audioPath). */
  musicPath?: string | null;
  /** Role of audioPath: narration is finite; music/song remains loopable. */
  primaryAudioRole?: "narration" | "music";
  /** True when the webm already starts on the settled show (Browserless
   *  starts recording after navigation + settle) — no white lead to guard. */
  cleanLead?: boolean;
  /** True if the page drives its own animations (slideshow/imessage). 
   *  Disables the initial frame hold so the video doesn't look like a static picture. */
  isInteractive?: boolean;
  /** True if the video duration automatically matched the audio */
  autoDuration?: boolean;
  /** Output canvas dims — default 1080×1920 (legacy 9:16). Story Mode passes
   *  1920×1080. Must match RecordOptions.outWidth/outHeight. */
  outWidth?: number;
  outHeight?: number;
  /** Volume of the mixed audio track (default 0.5 — legacy BGM behavior).
   *  Narration passes 1.0. */
  audioVolume?: number;
  /** Bed level for the ducked music track before sidechain compression. */
  musicVolume?: number;
}

/**
 * The audio section of the compositing filter graph. Pure so the ducking
 * math is unit-testable without ffmpeg:
 *
 *  - voice only    → the legacy single-track chain (unchanged behavior)
 *  - music only    → the bed at musicVolume with fades
 *  - voice + music → narration at audioVolume, music sidechain-ducked under
 *                    it, mixed with amix(normalize=0) and limited to 0.95
 *                    (the "normalize the final mix" step)
 *
 * Input mapping: [0:v] webm, [1:a] primary voice, [2:a] music bed. When only
 * music exists it lands on [1:a].
 */
export function buildAudioMixFilter(o: {
  hasVoice: boolean;
  hasMusic: boolean;
  autoDuration: boolean;
  showDurSec: number;
  audioVolume: number;
  musicVolume?: number;
  voiceTailSec: number;
  fadeDurSec: number;
  /** Whether the primary [1:a] track should repeat to fill the video. */
  primaryAudioLoops?: boolean;
}): string | null {
  const dur = o.showDurSec;
  const primaryLoop = o.primaryAudioLoops === false ? "" : ",aloop=loop=-1:size=2e9";
  const voiceTail = Math.max(0, dur - o.voiceTailSec);
  const voiceVol = o.audioVolume > 0 ? o.audioVolume : 1.0;
  const musicVol = o.musicVolume ?? 0.16;
  if (!o.hasVoice && !o.hasMusic) return null;

  const musicIdx = o.hasVoice ? 2 : 1;
  const musicChain = `[${musicIdx}:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo,aloop=loop=-1:size=2e9,atrim=0:${dur.toFixed(3)},volume=${musicVol.toFixed(2)},afade=t=out:st=${Math.max(0, dur - o.fadeDurSec).toFixed(2)}:d=${o.fadeDurSec},apad,atrim=0:${dur.toFixed(3)}`;

  if (o.hasVoice && o.hasMusic) {
    // The voice label feeds BOTH the sidechain compressor and the final amix.
    // This ffmpeg build rejects a reused label as a second input, so the
    // voice is duplicated with asplit — the sidechain only DIPS the bed.
    const voice = `[1:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo${primaryLoop},atrim=0:${voiceTail.toFixed(3)},volume=${voiceVol.toFixed(2)},afade=t=out:st=${Math.max(0, voiceTail - o.fadeDurSec).toFixed(2)}:d=${o.fadeDurSec},apad,atrim=0:${dur.toFixed(3)},asplit=2[voice][voice2]`;
    return `${voice};${musicChain}[music];[music][voice]sidechaincompress=threshold=0.04:ratio=12:attack=30:release=350[duck];[duck][voice2]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.95[aout]`;
  }
  if (o.hasMusic) {
    return `${musicChain},alimiter=limit=0.95[aout]`;
  }
  // Single-track voice path. The narration plays ONCE (no `aloop` — looping
  // it made a story's opening repeat during the silent outro tail), then
  // apad fills the rest with silence. The autoDuration variant keeps the
  // legacy plain-apad chain.
  if (o.autoDuration) {
    return `[1:a]aresample=44100${primaryLoop},apad,atrim=0:${dur.toFixed(3)},alimiter=limit=0.95[aout]`;
  }
  return `[1:a]aresample=44100${primaryLoop},atrim=0:${voiceTail.toFixed(3)},volume=${voiceVol.toFixed(2)},afade=t=out:st=${Math.max(0, voiceTail - o.fadeDurSec).toFixed(2)}:d=${o.fadeDurSec},apad,atrim=0:${dur.toFixed(3)},alimiter=limit=0.95[aout]`;
}

/**
 * ffmpeg args for the AppSlides fast path's single-track audio mix.
 * Pure so the loop decision is unit-testable without ffmpeg.
 *
 * Music loops (`-stream_loop -1`) to fill a video longer than the track;
 * narration plays ONCE — looping it would repeat a story's opening during
 * the silent outro, the same bug the screencast path guards against.
 */
export function buildAppSlidesAudioMix(opts: {
  videoDurSec: number;
  primaryAudioRole?: "narration" | "music";
  audioVolume?: number;
}): { inputArgs: string[]; filter: string } {
  const { videoDurSec } = opts;
  const loopPrimary = opts.primaryAudioRole !== "narration";
  const audioVol = opts.audioVolume ?? 0.5;
  return {
    inputArgs: loopPrimary ? ["-stream_loop", "-1"] : [],
    filter:
      `[1:a]aresample=44100,atrim=0:${videoDurSec.toFixed(3)},volume=${audioVol.toFixed(2)},` +
      `afade=t=out:st=${Math.max(0, videoDurSec - 1.2).toFixed(2)}:d=1.2,alimiter=limit=0.95[aout]`,
  };
}

/**
 * Shared WebM → MP4 post-processing (self-hosted screencast AND Browserless):
 * trim the blank lead (unless cleanLead), hold the first clean frame so the
 * poster is a settled hero, composite onto the blurred 9:16 canvas, mix the
 * audio track, then extract the thumbnail. Fails loud on a corrupt encode
 * (moov/ftyp sniff) instead of shipping an unplayable file.
 */
export async function composeScreencastToMp4(
  input: ComposeScreencastInput,
): Promise<{ durationMs: number; thumbnailPath?: string }> {
  const {
    webmPath,
    mp4Path,
    thumbPath,
    showStartMs,
    showEndMs,
    durationMs,
    viewport,
    background,
    audioPath,
    musicPath,
    outWidth = VERTICAL_OUT_W,
    outHeight = VERTICAL_OUT_H,
    audioVolume = 0.5,
    musicVolume,
  } = input;

  const probedSec = await probeDuration(webmPath);

  // Where the file starts, how long the opening frame is held, and the
  // poster-frame moment. Interactive pages (story/audio-driven) trim exactly
  // at the stamped show start; audio-driven pages get NO frame hold so the
  // separately-mixed narration stays in sync; silent beat-driven pages keep a
  // short 1.5s hold. Static pages keep the legacy lead-trim + poster hold.
  const trim = computeScreencastTrim({
    showStartMs,
    showEndMs,
    durationMs,
    videoLenSec: probedSec,
    isInteractive: input.isInteractive === true,
    hasVoice: !!audioPath && input.primaryAudioRole === "narration",
  });
  const { startSec, holdSec, showDurSec, thumbSec } = trim;

  // Audio-driven interactive pages get holdSec=0 (see computeScreencastTrim)
  // to protect narration sync, but the trimmed frame 0 still ships as this
  // file's own poster frame — pass noFade so it doesn't fade up from black
  // regardless.
  const filter = buildCompositeFilter(
    background,
    viewport.width,
    viewport.height,
    holdSec,
    0,
    outWidth,
    outHeight,
    input.isInteractive === true,
  );
  // Voice/music cuts VOICE_TAIL_MS before the video ends, fading out over
  // fadeDurSec just before that cut point, then pads with silence to the
  // true end — the video always finishes on quiet, not mid-word.
  // audioVolume defaults to 0.5 (legacy BGM behavior); narration passes 1.0.
  const voiceTailSec = VOICE_TAIL_MS / 1000;
  const fadeDurSec = 1.2;
  const audioFilter = buildAudioMixFilter({
    hasVoice: !!audioPath,
    hasMusic: !!musicPath,
    autoDuration: !!input.autoDuration,
    showDurSec,
    audioVolume,
    musicVolume,
    primaryAudioLoops: input.primaryAudioRole !== "narration",
    voiceTailSec,
    fadeDurSec,
  });

  // Interactive (audio-driven) pages seek the webm INPUT — the webm carries no
  // audio, so only the video is trimmed to the show start while the narration
  // track below stays at t=0. The legacy OUTPUT-side -ss would discard the
  // first `startSec` seconds of the mixed audio too, leaving the voice ahead
  // of the visuals (the audio-out-of-sync bug).
  const interactiveTrim = input.isInteractive === true;
  const inputSeekArgs = interactiveTrim ? ["-ss", startSec.toFixed(3)] : [];
  const outputTrimArgs = interactiveTrim
    ? ["-t", showDurSec.toFixed(3)]
    : ["-ss", startSec.toFixed(3), "-t", showDurSec.toFixed(3)];

  const anyAudio = audioPath || musicPath;

  // Encode codec — CPU libx264 by default. Set FFMPEG_ENCODER=h264_nvenc (or
  // hevc_nvenc) to use an NVIDIA GPU encoder; requires GPU passthrough into
  // the container (nvidia-container-toolkit) or ffmpeg will fail to launch.
  const encoder = process.env.FFMPEG_ENCODER || "libx264";
  const nvenc = encoder === "h264_nvenc" || encoder === "hevc_nvenc";
  const videoCodecArgs = nvenc
    ? ["-c:v", encoder, "-preset", "p4", "-cq", "23", "-rc", "vbr", "-b:v", "0"]
    : ["-c:v", "libx264", "-preset", "fast", "-crf", "23"];

  const finalArgs = [
    "-y",
    ...inputSeekArgs,
    "-i",
    webmPath,
    // Narration is NOT looped — it plays once and apad fills the tail with
    // silence. Looping it (the old `-stream_loop -1`) made a story's opening
    // repeat during the silent outro. The music bed is the only track that
    // loops.
    ...(audioPath ? ["-i", audioPath] : []),
    ...(musicPath ? ["-stream_loop", "-1", "-i", musicPath] : []),
    "-filter_complex",
    audioFilter ? `${filter};${audioFilter}` : filter,
    "-map",
    "[out]",
    ...(audioFilter ? ["-map", "[aout]"] : []),
    ...outputTrimArgs,
    ...videoCodecArgs,
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    "-vsync",
    "vfr",
    ...(anyAudio ? ["-c:a", "aac", "-b:a", "192k", "-ar", "44100", "-ac", "2"] : ["-an"]),
    mp4Path,
  ];
  if (process.env.DEBUG_FFMPEG) {
    console.log("[recorder] filter_complex=", audioFilter ? `${filter};${audioFilter}` : filter);
    console.log("[recorder] inputs=", [webmPath, audioPath, musicPath].filter(Boolean).join(" | "));
    console.log("[recorder] input seek=", inputSeekArgs.join(" "));
    console.log("[recorder] output trim=", outputTrimArgs.join(" "));
  }

  await runFfmpeg(finalArgs);
  await assertMp4Healthy(mp4Path);

  // Clean up the interim webm + audio.
  try {
    await unlink(webmPath);
  } catch {}
  for (const p of [audioPath, musicPath]) {
    if (p) {
      try {
        await unlink(p);
      } catch {}
    }
  }

  // The -44 phone-screen crop only makes sense on the 9:16 canvas (it trims
  // the rounded-bezel row); a 16:9 full-bleed frame has nothing to crop.
  const thumbCrop =
    outHeight / outWidth > 1
      ? phoneCropFilter(viewport.width, viewport.height, outWidth, outHeight) || "crop=iw:ih-44:0:44"
      : phoneCropFilter(viewport.width, viewport.height, outWidth, outHeight);
  const thumb = await makeThumbnail(mp4Path, thumbPath, thumbSec, thumbCrop);
  
  return { durationMs: Math.round(showDurSec * 1000), thumbnailPath: thumb };
}

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

  const baseUrl = (getEnv("PUBLIC_BASE_URL") || "http://localhost:8080").replace(/\/$/, "");

  const browser = await chromium.launch({
    headless: true,
    executablePath: resolveChromium(),
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
    // Tag the render with ?record=1: pages that would otherwise auto-start on
    // their own timer (Story Mode's 1s delay) skip it and let the recorder's
    // startShow() call — stamped at showStartMs — own the exact start moment,
    // so the mixed narration and the on-screen scenes stay in sync.
    const renderUrl = opts.url.includes("?") ? `${opts.url}&record=1` : `${opts.url}?record=1`;
    await page
      .goto(renderUrl, { waitUntil: opts.waitUntil || "load", timeout: 30_000 })
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
    const pageInfo = await collectPageInfo(page);

    const beatMs = pageInfo.beatMs || DEFAULT_BEAT_MS;
    const audioPath = await resolveAudioForMix(opts.songUrl, pageInfo.audioSrc, opts.url, id);
    // Second track (ducked bed): explicit musicUrl > page's own <audio id="score">.
    // Never resolves when the page already bakes narration into the webm.
    const musicPath = await resolveAudioForMix(
      opts.musicUrl,
      pageInfo.musicSrc,
      opts.url,
      `${id}-music`,
    );

    // APPSLIDES FAST PATH (faster-than-realtime). appslides is a deck of static
    // full-bleed slides, so screenshot each settled slide and crossfade the
    // stills instead of recording the page playing out in real time. Scoped to
    // appslides only; the animated formats keep the live screencast below.
    if (pageInfo.appslidesVessel && pageInfo.beatCount >= 1) {
      console.log(`[recorder] AppSlides fast path — ${pageInfo.beatCount} slides`);
      await page.close().catch(() => {});
      await context.close().catch(() => {});

      const outWidth = opts.outWidth || VERTICAL_OUT_W;
      const outHeight = opts.outHeight || VERTICAL_OUT_H;
      const beatCount = pageInfo.beatCount;
      const ctaIndex = pageInfo.ctaIndex >= 0 ? pageInfo.ctaIndex : -1;
      const slideMs = Math.max(1200, pageInfo.beatMs || DEFAULT_BEAT_MS);
      const ctaMs = Math.max(1200, pageInfo.ctaMs || slideMs);

      const frames = await captureAppSlidesFrames(browser, opts.url, opts, beatCount, workDir);
      if (frames.length < 1) throw new Error("AppSlides capture produced no frames");

      const durations = frames.map((_, i) => (i === ctaIndex ? ctaMs : slideMs) / 1000);
      const videoDurSec = await assembleAppSlidesVideo(frames, durations, mp4Path, outWidth, outHeight);

      // Mix the optional song if one was passed. Music loops to fill the
      // video; narration (should there ever be any here) plays once, exactly
      // like the screencast path (see buildAppSlidesAudioMix).
      if (audioPath) {
        const mixedPath = join(workDir, "appslides-mixed.mp4");
        const mix = buildAppSlidesAudioMix({
          videoDurSec,
          primaryAudioRole: opts.primaryAudioRole,
          audioVolume: opts.audioVolume,
        });
        await runFfmpeg([
          "-y",
          "-i", mp4Path,
          ...mix.inputArgs,
          "-i", audioPath as string,
          "-filter_complex", mix.filter,
          "-map", "0:v", "-map", "[aout]",
          "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-ar", "44100", "-ac", "2",
          "-movflags", "+faststart", mixedPath,
        ]);
        await rename(mixedPath, mp4Path);
      }

      await assertMp4Healthy(mp4Path);
      const thumb = await makeThumbnail(mp4Path, thumbPath, 0.45);
      const mp4Stat = await stat(mp4Path);
      return {
        id,
        mp4Path,
        mp4Url: `${baseUrl}/api/record/${id}/download`,
        thumbnailPath: thumb,
        thumbnailUrl: thumb ? `${baseUrl}/api/record/${id}/thumbnail` : undefined,
        mp4SizeBytes: mp4Stat.size,
        durationMs: Math.round(videoDurSec * 1000),
        success: true,
        output: { width: outWidth, height: outHeight, aspectRatio },
        frameColor: "none",
        viewport: { width: viewport.width, height: viewport.height, name: viewport.name },
      };
    }



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

    // Duration: declared beats > DOM beat count > default (shared with the
    // Browserless adapter so both recorders make the same length videos).
    // Story Mode passes an explicit durationMs (measured narration length).
    const outWidth = opts.outWidth || VERTICAL_OUT_W;
    const outHeight = opts.outHeight || VERTICAL_OUT_H;
    const durationMs = computeScreencastDurationMs(pageInfo, {
      durationMs: opts.durationMs,
      autoDuration,
    });

    // Auto-start + drive the recording: scrollable pages scroll at a
    // comfortable pace with intro/outro holds; fixed pages wait out the
    // duration (shared with the Browserless adapter).
    //
    // isInteractive: any page with beats is a self-animating show — the driver
    // must keep polling until the show ends, not scroll-cut it at ~2s (a
    // slideshow's full-bleed beats overflow body.locked by a few px, which
    // used to make the driver take the scroll path and finish almost
    // immediately). waitFullDuration: when the page declares its own recording
    // length, capture exactly that window so the CTA end-card holds.
    const isInteractive =
      pageInfo.beatCount > 0 || pageInfo.vesselBeatCount > 0 || pageInfo.isInteractive;
    await drivePageForRecording(page, {
      autoDuration,
      durationMs,
      isInteractive,
      waitFullDuration: pageInfo.recordDurationMs > 0,
    });

    const showEndMs = Date.now() - recordClockStart;
    await page.waitForTimeout(300);

    await page.close();
    await context.close(); // triggers Playwright to flush the .webm

    // Find the .webm written by Playwright.
    const webmFiles = (await readdir(workDir)).filter((f) => f.endsWith(".webm"));
    if (!webmFiles.length)
      throw new Error("No webm file recorded ΓÇö Playwright may not have flushed it");
    const webmPath = join(workDir, webmFiles[0]);

    // Post-process the raw screencast: trim the blank lead, hold the first
    // clean frame, composite onto the blurred output canvas, mix the audio and
    // extract the poster frame. Shared with the Browserless adapter (whose
    // webm starts on the settled show and passes cleanLead).
    const composed = await composeScreencastToMp4({
      webmPath,
      mp4Path,
      thumbPath,
      showStartMs,
      showEndMs,
      durationMs,
      viewport: { width: viewport.width, height: viewport.height, name: viewport.name },
      background,
      audioPath,
      musicPath,
      primaryAudioRole: opts.primaryAudioRole,
      // Must match the `isInteractive` computed above for drivePageForRecording
      // (line ~1821) — this was missing `|| pageInfo.isInteractive`, so a
      // self-animating page with no discrete .beat DOM (e.g. whiteboard scenes)
      // was driven as interactive during recording but composed with the
      // legacy STATIC trim math (blind lead-trim + 6.5s hold), landing the
      // held opening frame on the wrong point in the webm.
      isInteractive:
        pageInfo.beatCount > 0 || pageInfo.vesselBeatCount > 0 || pageInfo.isInteractive,
      autoDuration,
      outWidth,
      outHeight,
      audioVolume: opts.audioVolume,
      musicVolume: opts.musicVolume,
    });
    const mp4Stat = await stat(mp4Path);
    return {
      id,
      mp4Path,
      mp4Url: `${baseUrl}/api/record/${id}/download`,
      thumbnailPath: composed.thumbnailPath,
      thumbnailUrl: composed.thumbnailPath ? `${baseUrl}/api/record/${id}/thumbnail` : undefined,
      mp4SizeBytes: mp4Stat.size,
      // Report the ENCODED length, which includes the held opening frame —
      // callers use this for upload metadata and progress, so it has to match
      // the file rather than the pre-hold show duration.
      durationMs: composed.durationMs,
      success: true,
      output: { width: outWidth, height: outHeight, aspectRatio },
      frameColor: "none",
      viewport: { width: viewport.width, height: viewport.height, name: viewport.name },
    };
  } finally {
    await browser.close();
  }
}

// ── Job Queue ───────────────────────────────────────────────────────────────
// Renders are serialised because two overlapping Chromium + FFmpeg runs OOM the
// Railway container. Serialising them, though, makes ONE stuck render fatal for
// every render after it: the slot is only ever handed on by the job holding it.
// So the queue needs three things the first version lacked —
//   1. a hard timeout per job, so a hung render cannot own the slot forever,
//   2. a release that runs exactly once per job, even on a double-fault,
//   3. a queue position on the job record, so a waiting caller can tell
//      "third in line" apart from "broken".
const MAX_CONCURRENT_JOBS = 1;
let runningJobsCount = 0;

interface QueueWaiter {
  id: string;
  resolve: () => void;
}
const jobQueue: QueueWaiter[] = [];

/**
 * Hard ceiling on one render, start to finish. Sized above the worst legitimate
 * case (AUTO_LEN_CAP_MS of page time + browser launch + encode) so it only ever
 * fires on a genuinely stuck job. Override with RECORD_JOB_TIMEOUT_MS.
 */
export function jobTimeoutMs(): number {
  const raw = Number(getEnv("RECORD_JOB_TIMEOUT_MS"));
  return Number.isFinite(raw) && raw > 0 ? raw : 480_000;
}

/** Refresh the "n renders ahead of you" message on every waiting job. */
function updateQueuePositions(): void {
  jobQueue.forEach((waiter, i) => {
    const j = jobs.get(waiter.id);
    if (!j || j.status !== "queued") return;
    j.message =
      i === 0
        ? "Next in line — waiting for the renderer…"
        : `Waiting in queue — ${i} render${i === 1 ? "" : "s"} ahead`;
  });
}

function acquireJobSlot(id: string): Promise<void> {
  if (runningJobsCount < MAX_CONCURRENT_JOBS) {
    runningJobsCount++;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    jobQueue.push({ id, resolve });
    updateQueuePositions();
  });
}

function releaseJobSlot(): void {
  const next = jobQueue.shift();
  if (next) {
    // Hand the slot straight over — runningJobsCount stays as it is.
    next.resolve();
    updateQueuePositions();
  } else {
    // Floor at 0: a stray double-release must never drive the count negative,
    // which would let two renders run at once and reintroduce the OOM.
    runningJobsCount = Math.max(0, runningJobsCount - 1);
  }
}

/** Live queue depth — surfaced by /api/record so the UI can show the backlog. */
export function getRenderQueueStatus(): { running: number; queued: number; capacity: number } {
  return { running: runningJobsCount, queued: jobQueue.length, capacity: MAX_CONCURRENT_JOBS };
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

// └────────────────────────────────────────────────────────────────────────────

/** Start a recording job asynchronously. Returns immediately with the job record. */
type JobRunner = (opts: RecordOptions, id: string) => Promise<RecordResult>;

/**
 * Start a recording job asynchronously (self-hosted Playwright + FFmpeg
 * engine). Returns immediately with the job record; poll via getJob().
 */
export function startRecordingJob(opts: RecordOptions): Promise<JobRecord> {
  return runJob(opts, recordPage);
}

/**
 * Shared job driver: queue slot, progress ticker, watchdog, done/error
 * transitions. Both the self-hosted engine (recordPage) and the Browserless
 * adapter (lib/video/browserless.ts) run through here, so every render shares
 * ONE serialised slot (MAX_CONCURRENT_JOBS = 1 — two overlapping Chromium +
 * FFmpeg runs OOM the container) and the same lifecycle.
 */
export async function runJob(opts: RecordOptions, runner: JobRunner): Promise<JobRecord> {
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
    await acquireJobSlot(id);

    // Release exactly once. Without the guard, a fault inside the catch block
    // (e.g. the job record was swept while recording, so `jobs.get(id)!` throws
    // a second time) could reach releaseJobSlot twice and hand out two slots.
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      releaseJobSlot();
    };

    // Check if job was cancelled while waiting
    const jCheck = jobs.get(id);
    if (!jCheck) {
      release();
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

    // Watchdog: the slot is released the moment this fires, whether or not
    // recordPage ever settles. FFmpeg has its own SIGKILL timeout, and
    // recordPage closes the browser in its own finally, so an abandoned job
    // winds itself down instead of leaking a Chromium into the container.
    // Story Mode passes its own timeoutMs (capture is real-time for a 5–6 min
    // video, plus encode — more than the 8-minute default).
    const limitMs = opts.timeoutMs || jobTimeoutMs();
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
      const result = await Promise.race([runner(opts, id), guarded]);
      const j = jobs.get(id);
      if (j) {
        j.status = "done";
        j.progress = 100;
        j.message = "Done";
        j.finishedAt = new Date().toISOString();
        j.result = result;
      }
    } catch (err: any) {
      // `jobs.get(id)` is checked rather than asserted: the record can be gone
      // (deleteJob / sweep) and throwing here used to escape as an unhandled
      // rejection instead of failing the job cleanly.
      const j = jobs.get(id);
      if (j) {
        j.status = "error";
        j.progress = 0;
        j.message = (err as Error).message;
        j.error = (err as Error).message;
        j.finishedAt = new Date().toISOString();
      }
      console.error(`[recorder] job ${id} failed:`, (err as Error).message);
    } finally {
      clearInterval(ticker);
      if (watchdog) clearTimeout(watchdog);
      release();
    }
  })();

  return job;
}

export const getJob = (id: string): JobRecord | undefined => jobs.get(id);
export const listJobs = (): JobRecord[] =>
  Array.from(jobs.values()).sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));

// === worker-only BEGIN: HTTP-layer exports (getRecordingStatus + recorderDiagnostics) ===
/**
 * The HTTP layer's name for getJob: returns the JobRecord (status/message/
 * error/result) the bot's external client reads straight off the JSON body.
 */
export const getRecordingStatus = getJob;

/**
 * Render-binary diagnostics for /health: ffmpeg + chromium presence, in the
 * shape the worker's server.ts /health endpoint expects. Wraps the engine's
 * diagnoseRecorderEnvironment() so the worker's health contract is unchanged.
 */
export async function recorderDiagnostics(): Promise<{
  ffmpeg: { found: boolean; path: string };
  chromium: { found: boolean; source: string };
}> {
  const diag = diagnoseRecorderEnvironment();
  return {
    ffmpeg: { found: diag.ffmpegFound, path: diag.ffmpegPath },
    chromium: { found: diag.chromiumFound, source: diag.chromiumSource },
  };
}
// === worker-only END: HTTP-layer exports ===

// ΓöÇΓöÇ Job TTL eviction ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
// Sweep completed/errored jobs older than 1 hour so the Map never grows
// without bound. Active jobs (status='recording') are never evicted.

const JOB_TTL_MS = 60 * 60 * 1000; // 1 hour

function sweepStaleJobs(): void {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (job.status === "recording" || job.status === "queued") continue; // never evict in-flight jobs
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
  try {
    const tDir = tmpdir();
    const tEntries = await readdir(tDir, { withFileTypes: true });
    for (const entry of tEntries) {
      if (!entry.isDirectory() || !entry.name.startsWith('rec-')) continue;
      const dirPath = join(tDir, entry.name);
      try {
        const s = await stat(dirPath);
        if (s.mtimeMs < cutoff) {
          await rm(dirPath, { recursive: true, force: true });
        }
      } catch {}
    }
  } catch {}

  return removed;
}
