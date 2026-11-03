/**
 * The container's memory-lean x264 settings, in one place.
 *
 * `-threads 0` + `-preset fast` (rc-lookahead 30, one frame-thread per core)
 * makes x264's peak RSS scale with core count and with the filter graph; on a
 * memory-capped container that ends in a kernel OOM SIGKILL mid-encode (seen
 * ~1:25 into a 1:30+ render, and again on the /sitdown clip normaliser, which
 * asked for a 1080x1920 encode with no cap at all: ~1.6 GB peak for a 15s
 * clip, killed seconds into the run). veryfast + short lookahead + few threads
 * costs a little file size but keeps the peak flat (~400 MB for the same clip).
 *
 * Override the thread count with RECORD_FFMPEG_THREADS.
 */
import { getEnv } from "./worker-env";

export function x264LeanArgs(crf = 28): string[] {
  const t = Number(getEnv("RECORD_FFMPEG_THREADS"));
  const threads = Number.isFinite(t) && t > 0 ? Math.floor(t) : 2;
  return [
    "-c:v", "libx264", "-preset", "veryfast", "-crf", String(crf),
    "-x264-params", `rc-lookahead=10:ref=2:bframes=2:threads=${threads}:lookahead-threads=1`,
    "-threads", String(threads),
    "-filter_complex_threads", "1",
  ];
}
