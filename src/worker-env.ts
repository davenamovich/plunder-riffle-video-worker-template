/**
 * Worker env readers — vendored mirrors of bot/src/lib/env.ts semantics.
 *
 * The worker's recorder engine is sync-guarded to stay byte-identical with
 * bot/src/lib/video/recorder.ts, which imports { getEnv, isEnvTrue } from
 * "../env". The worker has no ../env module, so it carries the same readers
 * here (getEnv keeps the case-insensitive fallback and quote-trim the bot has;
 * isEnvTrue is the same fail-open boolean).
 */

export function getEnv(key: string, fallback: string = ""): string {
  // 1. Direct exact lookup (fast path)
  let v = process.env[key];

  // 2. Case-insensitive and punctuation-insensitive fallback lookup for
  //    Railway/Linux (env keys that lost their underscores in a dashboard)
  if (!v || v.trim().length === 0) {
    const targetKey = key.toLowerCase().replace(/[^a-z0-9]/g, "");
    for (const envKey of Object.keys(process.env)) {
      const normalizedEnvKey = envKey.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (normalizedEnvKey === targetKey) {
        const val = process.env[envKey];
        if (val && val.trim().length > 0) {
          v = val;
          break;
        }
      }
    }
  }

  const value = v && v.trim().length > 0 ? v.trim().replace(/^["']|["']$/g, "") : fallback;
  return value;
}

/** Fail-open boolean reader — '1'/'true'/'yes' are true, anything else false. */
export function isEnvTrue(key: string): boolean {
  return ["1", "true", "yes", "on"].includes(getEnv(key).toLowerCase());
}
