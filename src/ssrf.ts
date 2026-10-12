/**
 * SSRF guard for URLs the bot fetches or renders server-side. Ported verbatim
 * from packages/render-worker/src/ssrf.ts so both surfaces enforce the exact
 * same policy (the worker guards its own fetches; the bot needed the same
 * before handing a URL to the self-hosted Playwright recorder).
 *
 * Blocks non-http(s) schemes, loopback, private/link-local/metadata ranges,
 * and DNS rebinding (a hostname whose resolved IPs include anything private).
 *
 * Chromium loads the page's own sub-resources at render time; those are the
 * renderer's responsibility and out of scope for this guard — but the URLs we
 * ourselves request are fully covered here.
 */
import { lookup } from "dns/promises";
import { isIP } from "net";

const IPV4_BLOCKED: Array<[number, number]> = [
  [0x00000000, 8], // 0.0.0.0/8
  [0x0a000000, 8], // 10.0.0.0/8
  [0x64400000, 10], // 100.64.0.0/10 (CGNAT)
  [0x7f000000, 8], // 127.0.0.0/8
  [0xa9fe0000, 16], // 169.254.0.0/16 (link-local + cloud metadata)
  [0xac100000, 12], // 172.16.0.0/12
  [0xc0000000, 24], // 192.0.0.0/24
  [0xc0000200, 24], // 192.0.2.0/24 (TEST-NET-1)
  [0xc0a80000, 16], // 192.168.0.0/16
  [0xc6120000, 15], // 198.18.0.0/15 (benchmark)
  [0xc6336400, 24], // 198.51.100.0/24 (TEST-NET-2)
  [0xcb007100, 24], // 203.0.113.0/24 (TEST-NET-3)
  [0xe0000000, 4], // 224.0.0.0/4 (multicast)
  [0xf0000000, 4], // 240.0.0.0/4 (reserved)
];

function ipv4ToInt(ip: string): number {
  return ip.split(".").reduce((acc, octet) => (acc << 8) | (Number(octet) & 0xff), 0) >>> 0;
}

function isBlockedIpv4(ip: string): boolean {
  const value = ipv4ToInt(ip);
  return IPV4_BLOCKED.some(([network, bits]) => {
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (value & mask) === (network & mask);
  });
}

/** Expand an IPv6 literal to its 8 16-bit groups (handles `::` and a trailing dotted v4). */
function ipv6Groups(ip: string): number[] | null {
  let s = ip.toLowerCase().replace(/%.*$/, "");
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (v4) {
    const n = ipv4ToInt(v4[1]!);
    s = s.slice(0, v4.index) + ((n >>> 16) & 0xffff).toString(16) + ":" + (n & 0xffff).toString(16);
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const groups = [...head, ...Array(fill).fill("0"), ...tail].map((g) => parseInt(g || "0", 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

function embeddedV4(hi: number, lo: number): string {
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

function isBlockedIpv6(ip: string): boolean {
  const g = ipv6Groups(ip);
  if (!g) return true; // unparseable → fail closed
  const allZeroTo = (n: number) => g.slice(0, n).every((x) => x === 0);
  if (allZeroTo(7) && (g[7] === 0 || g[7] === 1)) return true; // :: and ::1
  if ((g[0]! & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g[0]! & 0xfe00) === 0xfc00) return true; // fc00::/7 ULA
  if ((g[0]! & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  // IPv4-mapped (::ffff:a.b.c.d, in either dotted or hex spelling) and the
  // deprecated IPv4-compatible form (::a.b.c.d) — judge the embedded v4.
  if (allZeroTo(5) && (g[5] === 0xffff || g[5] === 0)) return isBlockedIpv4(embeddedV4(g[6]!, g[7]!));
  // NAT64 64:ff9b::/96 and 6to4 2002::/16 embed a v4 address too.
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return isBlockedIpv4(embeddedV4(g[6]!, g[7]!));
  if (g[0] === 0x2002) return isBlockedIpv4(embeddedV4(g[1]!, g[2]!));
  return false;
}

function isBlockedIp(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) return isBlockedIpv4(ip);
  if (version === 6) return isBlockedIpv6(ip);
  // Hostname fallthrough shouldn't happen here, but treat unknowns as blocked.
  return true;
}

export interface SsrfCheck {
  ok: boolean;
  reason?: string;
}

/**
 * Validate a URL the server will fetch or render. Returns { ok } or
 * { ok:false, reason }. The DNS-resolution check defends against rebinding:
 * we resolve the hostname and reject if ANY returned address is non-public.
 */
export async function assertPublicHttpUrl(raw: string, label: string): Promise<SsrfCheck> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, reason: `${label} is not a valid URL` };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return { ok: false, reason: `${label} must be http(s)` };
  }

  const hostname = u.hostname.replace(/^\[|\]$/g, "");
  // IP literal (v4 or v6) — no DNS needed.
  if (isIP(hostname)) {
    if (isBlockedIp(hostname)) {
      return { ok: false, reason: `${label} resolves to a non-public address` };
    }
    return { ok: true };
  }

  // Hostname — resolve and check every address.
  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    return { ok: false, reason: `${label} hostname could not be resolved` };
  }
  if (addresses.length === 0) {
    return { ok: false, reason: `${label} hostname resolved to no addresses` };
  }
  for (const a of addresses) {
    if (isBlockedIp(a.address)) {
      return { ok: false, reason: `${label} resolves to a non-public address` };
    }
  }
  return { ok: true };
}

// ── Browser request guard ────────────────────────────────────────────────────
// assertPublicHttpUrl above only vets the URL WE request. Chromium then follows
// redirects and runs page JS that can request anything — including the host's
// loopback / Railway-private / cloud-metadata addresses. This is the
// per-request check the recorder installs on every browser context.

/** Hostnames that are private by name, with no DNS needed. */
export function isPrivateHostname(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return (
    h === "localhost" ||
    h.endsWith(".localhost") ||
    h.endsWith(".internal") ||
    h.endsWith(".local") ||
    h === "metadata.google.internal" ||
    h === "instance-data"
  );
}

/**
 * Build a request checker: `(url) => Promise<boolean>` (true = allow).
 * - non-http(s) schemes (data:, blob:, about:) are allowed — they carry no network I/O
 * - hosts in `trustedHosts` are always allowed (our own public origins)
 * - everything else must be a public host; DNS results are cached per host
 */
export function createRequestGuard(trustedHosts: string[] = [], dnsCheck: (h: string) => Promise<boolean> = defaultDnsCheck) {
  const trusted = new Set(trustedHosts.map((h) => h.toLowerCase()));
  const cache = new Map<string, Promise<boolean>>();
  return async (raw: string): Promise<boolean> => {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      return false;
    }
    if (u.protocol !== "http:" && u.protocol !== "https:" && u.protocol !== "ws:" && u.protocol !== "wss:") {
      return ["data:", "blob:", "about:"].includes(u.protocol);
    }
    const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (trusted.has(host)) return true;
    if (isPrivateHostname(host)) return false;
    if (isIP(host)) return !isBlockedIp(host);
    let p = cache.get(host);
    if (!p) {
      p = dnsCheck(host);
      cache.set(host, p);
    }
    return p;
  };
}

async function defaultDnsCheck(host: string): Promise<boolean> {
  try {
    const addrs = await lookup(host, { all: true, verbatim: true });
    return addrs.length > 0 && addrs.every((a) => !isBlockedIp(a.address));
  } catch {
    return false;
  }
}
