/**
 * /api/mix/* — a scratch workspace + ffmpeg runner for the bot's /mixclips.
 *
 * The bot used to run every ffmpeg step of a mix inside its own container
 * (2 GB limit → OOM kills). Now it opens a session here, uploads the clips,
 * runs the same ffmpeg/ffprobe commands with the session dir as the working
 * area, and downloads the finished MP4. The bot's logic is unchanged: the
 * session `dir` is a real path on this machine, so absolute paths in args and
 * concat lists are valid as-is.
 */
import type { Express, Request, Response, NextFunction, RequestHandler } from "express";
import express from "express";
import { spawn } from "child_process";
import { randomUUID } from "crypto";
import { mkdir, readFile, rm, writeFile, readdir, stat } from "fs/promises";
import { tmpdir } from "os";
import { join, resolve } from "path";

const ROOT = join(tmpdir(), "mix-sessions");
const SESSION_TTL_MS = 45 * 60_000;
const MAX_FILE = 80 * 1024 * 1024;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;
const BINS = new Set(["ffmpeg", "ffprobe"]);

const sessions = new Map<string, { dir: string; last: number }>();

function sess(req: Request, res: Response): { id: string; dir: string } | null {
  const id = String(req.params["id"] || "");
  const s = sessions.get(id);
  if (!s) {
    res.status(404).json({ error: "Mix session not found" });
    return null;
  }
  s.last = Date.now();
  return { id, dir: s.dir };
}

/** ffmpeg's stderr ends in `frame= … fps=` progress lines that bury the real error. */
function tidy(err: string): string {
  return err.split(/\r|\n/).map((l) => l.trim()).filter((l) => l && !/^(frame|size)=/.test(l)).slice(-3).join(" | ").slice(-300);
}

function runBin(bin: string, args: string[], cwd: string, timeoutMs: number): Promise<{ ok: true; stdout: string } | { ok: false; error: string }> {
  return new Promise((done) => {
    const p = spawn(bin, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += String(d)));
    p.stderr.on("data", (d) => (err = (err + String(d)).slice(-4000)));
    let timedOut = false;
    const t = setTimeout(() => { timedOut = true; p.kill("SIGKILL"); }, timeoutMs);
    p.on("error", (e) => { clearTimeout(t); done({ ok: false, error: `${bin} failed — ${e.message}` }); });
    p.on("close", (code, signal) => {
      clearTimeout(t);
      if (code === 0) return done({ ok: true, stdout: out });
      const why = timedOut ? `timed out after ${Math.round(timeoutMs / 1000)}s` : signal ? `killed by ${signal} (likely out of memory)` : `exit ${code}`;
      const real = tidy(err);
      done({ ok: false, error: `${bin} failed — ${why}${real ? `: ${real}` : ""}` });
    });
  });
}

/** Every absolute path in the args must live inside the session dir. */
export function argsAreContained(args: unknown, dir: string): args is string[] {
  if (!Array.isArray(args) || args.length > 200) return false;
  for (const a of args) {
    if (typeof a !== "string" || a.length > 4000) return false;
    if (a.includes("..")) return false;
    // `-i /abs/path`, `file:/abs`, or a bare /abs output
    if (a.startsWith("/") && resolve(a) !== dir && !resolve(a).startsWith(dir + "/")) return false;
    if (/^(file|concat|subfile|pipe|tcp|udp|rtmp|http|https|ftp):/i.test(a) && !a.startsWith("file:" + dir)) return false;
  }
  return true;
}

async function sweep(): Promise<void> {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.last > SESSION_TTL_MS) {
      sessions.delete(id);
      await rm(s.dir, { recursive: true, force: true }).catch(() => {});
    }
  }
  // Orphans from a previous process (the in-memory map is gone after a restart).
  const known = new Set([...sessions.values()].map((s) => s.dir));
  for (const name of await readdir(ROOT).catch(() => [] as string[])) {
    const d = join(ROOT, name);
    if (known.has(d)) continue;
    const st = await stat(d).catch(() => null);
    if (st && now - st.mtimeMs > SESSION_TTL_MS) await rm(d, { recursive: true, force: true }).catch(() => {});
  }
}

export function registerMixRoutes(app: Express, requireSecret: RequestHandler): void {
  const raw = express.raw({ type: () => true, limit: MAX_FILE });
  setInterval(() => void sweep(), 5 * 60_000).unref();

  app.post("/api/mix/session", requireSecret, async (_req: Request, res: Response) => {
    try {
      await mkdir(ROOT, { recursive: true });
      const id = randomUUID();
      const dir = join(ROOT, id);
      await mkdir(dir, { recursive: true });
      sessions.set(id, { dir, last: Date.now() });
      res.json({ id, dir });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  app.put("/api/mix/:id/file", requireSecret, raw, async (req: Request, res: Response) => {
    const s = sess(req, res);
    if (!s) return;
    const name = String(req.query["name"] || "");
    if (!NAME_RE.test(name)) return void res.status(400).json({ error: "bad file name" });
    const body = req.body;
    if (!Buffer.isBuffer(body)) return void res.status(400).json({ error: "send the file as the raw request body" });
    try {
      await writeFile(join(s.dir, name), body);
      res.json({ ok: true, bytes: body.length });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  app.get("/api/mix/:id/file", requireSecret, async (req: Request, res: Response) => {
    const s = sess(req, res);
    if (!s) return;
    const name = String(req.query["name"] || "");
    if (!NAME_RE.test(name)) return void res.status(400).json({ error: "bad file name" });
    try {
      const buf = await readFile(join(s.dir, name));
      res.setHeader("Content-Type", "application/octet-stream");
      res.send(buf);
    } catch {
      res.status(404).json({ error: "file not found" });
    }
  });

  app.post("/api/mix/:id/run", requireSecret, async (req: Request, res: Response) => {
    const s = sess(req, res);
    if (!s) return;
    const { bin, args, timeoutMs } = req.body ?? {};
    // The bot passes its own ffmpeg path (e.g. /usr/bin/ffmpeg); only the program name matters here.
    const base = typeof bin === "string" ? bin.split("/").pop() || "" : "";
    if (!BINS.has(base)) return void res.status(400).json({ error: "bin must be ffmpeg or ffprobe" });
    if (!argsAreContained(args, s.dir)) return void res.status(400).json({ error: "args rejected (paths must stay inside the session)" });
    const t = Math.min(Math.max(Number(timeoutMs) || 120_000, 5_000), 300_000);
    const r = await runBin(base, args, s.dir, t);
    if (r.ok) return void res.json({ stdout: r.stdout });
    res.status(422).json({ error: r.error });
  });

  app.delete("/api/mix/:id", requireSecret, async (req: Request, res: Response) => {
    const id = String(req.params["id"] || "");
    const s = sessions.get(id);
    sessions.delete(id);
    if (s) await rm(s.dir, { recursive: true, force: true }).catch(() => {});
    res.json({ ok: true });
  });
}
