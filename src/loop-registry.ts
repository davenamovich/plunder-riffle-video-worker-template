/**
 * Loop registry — one owner for every recurring background job in the bot.
 *
 * Why this exists. Before it, ~30 separate `setInterval` calls were started
 * from three different places (`server.ts`, `scheduler.ts`, `xaiver/telegram-flow.ts`),
 * each with its own hardcoded cadence and its own ad-hoc guard style. Nothing
 * could answer the one question that matters when a job goes quiet: *which loop
 * last ran, when, and did it error?* A loop that throws logged and retried
 * forever; a loop that was never started looked exactly like a loop with
 * nothing to do.
 *
 * What it guarantees, per the nine parts a scheduled loop needs (see
 * `.agents/skills/marketing-loops/references/loop-template.md`):
 *
 *   - **Cadence** lives here, not at the call site.
 *   - **Jitter** — every delay gets a random offset, so loops that were started
 *     in the same boot no longer all fire on the same wall-clock boundary.
 *   - **Backoff** — consecutive failures double the delay up to a cap instead
 *     of hammering a dead dependency every 60s forever.
 *   - **State / idempotency** — `tick` and `consecutiveFailures` are handed to
 *     the job, and a still-running job is skipped rather than re-entered.
 *   - **Self-check** — `lastOutcome` / `lastError` / `stuck` are recorded and
 *     surfaced on `/health`.
 *   - **Stop** — `DISABLE_LOOPS=1` is the global off switch; `stopLoops()`
 *     clears everything.
 *
 * Deliberately *not* here: the job bodies. A migrated loop keeps its exact
 * original body and only swaps its `setInterval` wrapper for `registerLoop`.
 *
 * Scheduling model: one self-re-arming `setTimeout` per loop (not a shared
 * 1s tick). The next delay is computed *after* a run finishes, so cadence is
 * measured end-to-start and a slow run cannot stack up behind it.
 */
import { isEnvTrue } from './worker-env';

/** Context handed to every run so a job can adapt without owning its own state. */
export interface LoopRunContext {
  /** The loop's registry id. */
  id: string;
  /** 1 on the first run, incrementing once per run. */
  tick: number;
  /** Failed runs immediately before this one — 0 when the last run passed. */
  consecutiveFailures: number;
}

export interface LoopSpec {
  /**
   * Stable, unique, dotted id — `"scheduler.autopost"`, `"xaiver.poller"`.
   * Registering the same id twice is ignored (hot reload, double boot).
   */
  id: string;
  /** Base delay between the end of one run and the start of the next. */
  cadenceMs: number;
  /** The job. Sync throws and rejections are both caught and recorded. */
  run: (ctx: LoopRunContext) => unknown | Promise<unknown>;
  /**
   * Random 0..jitterMs added to every delay. Defaults to 10% of the cadence,
   * capped at 5s — enough to decorrelate loops started together without
   * visibly moving a deliberate cadence.
   */
  jitterMs?: number;
  /** Run once immediately on arm (after a short stagger). Default true. */
  runOnStart?: boolean;
  /** Delay before the first run when `runOnStart` is true (default 250ms). */
  startDelayMs?: number;
  /** Re-checked before every run; false records a `skipped` tick and re-arms. */
  enabled?: () => boolean;
  /** Cap for exponential failure backoff. Default 30 min. */
  backoffCapMs?: number;
  /** Flag a run that outlives this as stuck on /health. Default max(cadence*5, 5min). */
  stuckAfterMs?: number;
}

export type LoopOutcome = 'never' | 'ok' | 'error' | 'skipped';

export interface LoopState {
  id: string;
  cadenceMs: number;
  runs: number;
  failures: number;
  consecutiveFailures: number;
  skipped: number;
  running: boolean;
  /** True when `running` outlived `stuckAfterMs` — a hung job, not a slow one. */
  stuck: boolean;
  lastOutcome: LoopOutcome;
  lastStartAt: number | null;
  lastEndAt: number | null;
  lastDurationMs: number | null;
  lastError: string | null;
  nextRunAt: number | null;
}

/** One loop as reported by `/health` — compact, and never carries a secret. */
export interface LoopHealth {
  id: string;
  cadenceMs: number;
  ok: boolean;
  runs: number;
  failures: number;
  lastOutcome: LoopOutcome;
  /** ms since the last run finished; null until it has run once. */
  lastRunMsAgo: number | null;
  /** ms until the next run; null when unscheduled. */
  nextRunMsIn: number | null;
  stuck: boolean;
  lastError: string | null;
}

export interface LoopsHealth {
  /** False when the registry was never started (headless/import-only boot). */
  running: boolean;
  /** True when DISABLE_LOOPS is set — registered but deliberately not armed. */
  disabled: boolean;
  count: number;
  /** Ids whose last run failed, most-recently-broken first. */
  unhealthy: string[];
  /** Ids currently flagged stuck. */
  stuck: string[];
  loops: LoopHealth[];
}

// ── Internal state ─────────────────────────────────────────────────────────
//
// Attached to globalThis so a hot reload (tsx watch) re-uses the live registry
// instead of arming a second copy of every timer — the same guard pattern
// scheduler.ts / ops-daemon.ts used individually before this existed.

interface Armed {
  spec: LoopSpec;
  timer: ReturnType<typeof setTimeout> | null;
  state: LoopState;
  /** Set when noteLoopError() fires during the current run. */
  notedThisRun: boolean;
}

interface Registry {
  running: boolean;
  disabled: boolean;
  armed: Map<string, Armed>;
}

const g = globalThis as unknown as { __RALPH_LOOP_REGISTRY__?: Registry };
if (!g.__RALPH_LOOP_REGISTRY__) {
  g.__RALPH_LOOP_REGISTRY__ = { running: false, disabled: false, armed: new Map() };
}
const registry: Registry = g.__RALPH_LOOP_REGISTRY__;

/** Longest error string /health will carry — enough to act on, not a stack dump. */
const MAX_ERROR_CHARS = 240;
/** Default first-run stagger, so a boot doesn't fire every loop in one turn. */
const DEFAULT_START_DELAY_MS = 250;

function errorMessage(err: unknown): string {
  const msg =
    err instanceof Error
      ? err.message
      : typeof err === 'string'
        ? err
        : (() => {
            try {
              return JSON.stringify(err);
            } catch {
              return String(err);
            }
          })();
  return msg.length > MAX_ERROR_CHARS ? `${msg.slice(0, MAX_ERROR_CHARS - 1)}…` : msg;
}

function warn(message: string): void {
  console.warn(`[loops] ${message}`);
}

/** `90s` / `5m` / `4h` — a cadence should be readable at a glance in a log line. */
function formatCadence(cadenceMs: number): string {
  if (cadenceMs < 1_000) return `${Math.round(cadenceMs)}ms`;
  if (cadenceMs < 60_000) return `${Math.round(cadenceMs / 1_000)}s`;
  if (cadenceMs < 3_600_000) return `${Math.round(cadenceMs / 60_000)}m`;
  return `${Math.round(cadenceMs / 3_600_000)}h`;
}

function effectiveJitter(spec: LoopSpec): number {
  if (spec.jitterMs !== undefined) return Math.max(0, spec.jitterMs);
  return Math.max(0, Math.min(5_000, Math.floor(spec.cadenceMs * 0.1)));
}

function backoffCap(spec: LoopSpec): number {
  return spec.backoffCapMs ?? 30 * 60_000;
}

function stuckAfter(spec: LoopSpec): number {
  return spec.stuckAfterMs ?? Math.max(spec.cadenceMs * 5, 5 * 60_000);
}

/**
 * Delay before the next run. Failures back off exponentially from the cadence
 * (cadence, 2x, 4x, …) and the cap bounds it; jitter is added last so a
 * recovered loop rejoins the normal cadence instead of drifting.
 */
function nextDelay(spec: LoopSpec, consecutiveFailures: number): number {
  const base = spec.cadenceMs * Math.pow(2, Math.max(0, consecutiveFailures));
  const capped = Math.min(base, backoffCap(spec));
  return Math.max(0, capped + Math.floor(Math.random() * effectiveJitter(spec)));
}

function arm(a: Armed): void {
  if (a.timer) return;
  const delay =
    a.state.runs === 0 && a.spec.runOnStart !== false
      ? (a.spec.startDelayMs ?? DEFAULT_START_DELAY_MS)
      : nextDelay(a.spec, a.state.consecutiveFailures);

  a.state.nextRunAt = Date.now() + delay;
  a.timer = setTimeout(() => {
    a.timer = null;
    void tick(a);
  }, delay);
  // Never hold the process open for a background job — every pre-existing loop
  // called unref() individually; the registry applies it once for all of them.
  a.timer.unref?.();
}

function scheduleNext(a: Armed): void {
  if (!registry.running) {
    a.state.nextRunAt = null;
    return;
  }
  arm(a);
}

async function tick(a: Armed): Promise<void> {
  const { spec, state } = a;

  if (spec.enabled && !spec.enabled()) {
    state.skipped++;
    state.lastOutcome = 'skipped';
    scheduleNext(a);
    return;
  }

  state.running = true;
  state.runs++;
  state.lastStartAt = Date.now();
  state.nextRunAt = null;
  a.notedThisRun = false;

  try {
    await spec.run({
      id: spec.id,
      tick: state.runs,
      consecutiveFailures: state.consecutiveFailures,
    });
    // A body that handled its own error called noteLoopError(); resolving is not
    // the same as succeeding, so don't clear what the body just reported.
    if (!a.notedThisRun) {
      state.lastOutcome = 'ok';
      state.lastError = null;
      state.consecutiveFailures = 0;
    }
  } catch (err) {
    state.lastOutcome = 'error';
    state.lastError = errorMessage(err);
    state.failures++;
    state.consecutiveFailures++;
    // Every failure is reported, matching the noise level of the loops this
    // replaced — the difference is that it is now also queryable from /health.
    warn(
      `${spec.id} failed (${state.consecutiveFailures} consecutive, next in ~${Math.round(
        Math.min(spec.cadenceMs * Math.pow(2, state.consecutiveFailures), backoffCap(spec)) / 1000,
      )}s): ${state.lastError}`,
    );
  } finally {
    state.running = false;
    state.lastEndAt = Date.now();
    state.lastDurationMs =
      state.lastStartAt === null ? null : state.lastEndAt - state.lastStartAt;
    scheduleNext(a);
  }
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Register a recurring job. Idempotent by id: a second registration of the same
 * id is ignored, so a hot reload or a double boot cannot double-fire a loop.
 *
 * If the registry is already running the loop is armed immediately; otherwise
 * it waits for `startLoops()`.
 */
export function registerLoop(spec: LoopSpec): void {
  if (!spec.id) {
    warn('registerLoop ignored a spec with no id');
    return;
  }
  if (spec.cadenceMs <= 0) {
    warn(`registerLoop(${spec.id}) ignored: cadenceMs must be > 0`);
    return;
  }

  const existing = registry.armed.get(spec.id);
  if (existing) {
    // Same id, same job re-registering after a reload: keep the live timer.
    return;
  }

  const armed: Armed = {
    spec,
    timer: null,
    state: {
      id: spec.id,
      cadenceMs: spec.cadenceMs,
      runs: 0,
      failures: 0,
      consecutiveFailures: 0,
      skipped: 0,
      running: false,
      stuck: false,
      lastOutcome: 'never',
      lastStartAt: null,
      lastEndAt: null,
      lastDurationMs: null,
      lastError: null,
      nextRunAt: null,
    },
    notedThisRun: false,
  };
  registry.armed.set(spec.id, armed);

  if (registry.running) {
    // Registered after boot (a lazily-imported worker, say) — arm it now, and
    // say so, otherwise the boot manifest would be the only record of what runs.
    arm(armed);
    console.log(`[loops] ${spec.id} registered after boot (every ${formatCadence(spec.cadenceMs)})`);
  }
}

/**
 * Record a failure a loop handled inside its own body.
 *
 * Most of the migrated jobs already catch their own errors and log them, so
 * nothing ever reached the registry and /health would have reported `ok` for a
 * job failing on every tick — the exact blind spot this registry exists to
 * close. A body's existing `catch` calls this instead of swallowing silently.
 *
 * Deliberately does NOT touch `consecutiveFailures`, so it never engages the
 * failure backoff: the body decided it could carry on, so the loop keeps its
 * declared cadence. Backoff stays reserved for an unhandled throw, where the
 * loop has no evidence that continuing is safe.
 *
 * A no-op for an unknown id, so a body can call it unconditionally.
 */
export function noteLoopError(id: string, err: unknown): void {
  const armed = registry.armed.get(id);
  if (!armed) return;
  const { state } = armed;
  // A note that arrives while no registry run is in flight came from the job's
  // own boot one-shot (`setTimeout(tick, …)` outside the registry), not from a
  // loop run. Report it — the job really did fail — but do not count it against
  // the run tally, or /health would show `failures > runs` and read as a bug
  // (temp.cleanup does exactly this: its 30s startup sweep shares the tick).
  if (state.running) {
    armed.notedThisRun = true;
    state.failures++;
  }
  state.lastError = errorMessage(err);
  state.lastOutcome = 'error';
}

/**
 * Stop a loop and forget it. Safe on an unknown id, so a `stop*()` export can
 * stay callable after the loop was never started.
 */
export function unregisterLoop(id: string): void {
  const armed = registry.armed.get(id);
  if (!armed) return;
  if (armed.timer) clearTimeout(armed.timer);
  armed.timer = null;
  armed.state.nextRunAt = null;
  registry.armed.delete(id);
}

/**
 * Arm every registered loop. Idempotent — the second call is a no-op, which is
 * what makes it safe to call from a boot path that can run twice.
 *
 * `DISABLE_LOOPS=1` (or true/yes/on) is the global off switch: loops register
 * normally but nothing is armed, and /health says so.
 */
export function startLoops(): void {
  if (registry.running) return;

  if (isEnvTrue('DISABLE_LOOPS')) {
    registry.disabled = true;
    console.log('[loops] DISABLE_LOOPS set — no recurring jobs armed');
    return;
  }

  registry.disabled = false;
  registry.running = true;
  for (const armed of registry.armed.values()) arm(armed);

  const ids = [...registry.armed.values()]
    .map((a) => `${a.spec.id}(${formatCadence(a.spec.cadenceMs)})`)
    .sort();
  // One line at boot beats twenty scattered "[x] started (interval: …)" lines.
  console.log(
    ids.length
      ? `[loops] ${ids.length} recurring job(s) armed: ${ids.join(', ')}`
      : '[loops] no recurring jobs registered',
  );
}

/** Clear every timer and stop the registry. Loops stay registered. */
export function stopLoops(): void {
  registry.running = false;
  for (const armed of registry.armed.values()) {
    if (armed.timer) clearTimeout(armed.timer);
    armed.timer = null;
    armed.state.nextRunAt = null;
  }
}

/** True once `startLoops()` has armed the registry. */
export function loopsRunning(): boolean {
  return registry.running;
}

/** Registered ids, sorted — the cheap assertion a hygiene test wants. */
export function registeredLoopIds(): string[] {
  return [...registry.armed.keys()].sort();
}

/** The full ledger for one loop, or undefined when it was never registered. */
export function loopState(id: string): LoopState | undefined {
  const armed = registry.armed.get(id);
  if (!armed) return undefined;
  const spec = armed.spec;
  const stale = armed.timer === null && registry.running && !armed.state.running;
  return {
    ...armed.state,
    stuck:
      armed.state.running &&
      armed.state.lastStartAt !== null &&
      Date.now() - armed.state.lastStartAt > stuckAfter(spec),
    // nextRunAt is only meaningful while armed; report null otherwise so a
    // stopped-but-registered loop can't look scheduled.
    nextRunAt: stale ? null : armed.state.nextRunAt,
  };
}

/**
 * Compact view for `/health`. Answers "which loop last ran, when, and did it
 * error" without needing the Railway log tail — and it is sorted so a
 * comparison between two deploys is a diff, not a reading exercise.
 */
export function loopsSummary(): LoopsHealth {
  const now = Date.now();
  const loops: LoopHealth[] = [];

  for (const armed of registry.armed.values()) {
    const { state, spec } = armed;
    const stuck =
      state.running &&
      state.lastStartAt !== null &&
      now - state.lastStartAt > stuckAfter(spec);
    loops.push({
      id: spec.id,
      cadenceMs: spec.cadenceMs,
      ok: state.lastOutcome !== 'error',
      runs: state.runs,
      failures: state.failures,
      lastOutcome: state.lastOutcome,
      lastRunMsAgo: state.lastEndAt === null ? null : now - state.lastEndAt,
      nextRunMsIn: state.nextRunAt === null ? null : Math.max(0, state.nextRunAt - now),
      stuck,
      lastError: state.lastError,
    });
  }

  loops.sort((a, b) => a.id.localeCompare(b.id));

  return {
    running: registry.running,
    disabled: registry.disabled,
    count: loops.length,
    // Broken loops first: /health is read when something is wrong.
    unhealthy: loops
      .filter((l) => !l.ok)
      .sort((a, b) => b.failures - a.failures)
      .map((l) => l.id),
    stuck: loops.filter((l) => l.stuck).map((l) => l.id),
    loops,
  };
}

/**
 * Tear the registry down for tests. Clears timers, state, and the globalThis
 * slot so the next test starts from a clean registry rather than a warmed one.
 */
export function resetLoopRegistryForTests(): void {
  for (const armed of registry.armed.values()) {
    if (armed.timer) clearTimeout(armed.timer);
    armed.timer = null;
  }
  registry.armed.clear();
  registry.running = false;
  registry.disabled = false;
}
