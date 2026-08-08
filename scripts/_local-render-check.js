// Throwaway local validation: boot the compiled worker on the host, serve a
// demo page, POST a render, poll, download, verify the MP4, then clean up.
const { spawn } = require("child_process");
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const WORKER_PORT = 7100;
const PAGE_PORT = 8090;
const SECRET = "testsecret";
const demosDir = path.join(__dirname, "..", "..", "..", "public", "demos");

async function main() {
  // 1. Static server for the demo page
  const pageServer = http.createServer((req, res) => {
    const url = req.url.split("?")[0];
    const file = path.join(demosDir, url === "/" ? "imessage.html" : url);
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end("not found");
        return;
      }
      const ext = path.extname(file);
      res.writeHead(200, { "Content-Type": ext === ".html" ? "text/html" : "application/octet-stream" });
      res.end(data);
    });
  });
  await new Promise((r) => pageServer.listen(PAGE_PORT, r));
  console.log(`[check] demo server on ${PAGE_PORT}`);

  // 2. Boot the compiled worker
  const worker = spawn("node", ["dist/server.js"], {
    cwd: path.join(__dirname, ".."),
    env: { ...process.env, WORKER_SECRET: SECRET, PORT: String(WORKER_PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  worker.stdout.on("data", (d) => process.stdout.write(`[worker] ${d}`));
  worker.stderr.on("data", (d) => process.stderr.write(`[worker!] ${d}`));
  await sleep(2500);

  const base = `http://127.0.0.1:${WORKER_PORT}`;

  // 3. Auth guard checks
  const unauth = await fetch(`${base}/api/record`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: "http://x" }),
  });
  const unauthOk = unauth.status === 401;
  console.log(`UNAUTH POST -> ${unauth.status} (expect 401) ${unauthOk ? "PASS" : "FAIL"}`);

  // 4. Real render
  const url = `http://127.0.0.1:${PAGE_PORT}/imessage.html`;
  const res = await fetch(`${base}/api/record`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-operator-secret": SECRET },
    body: JSON.stringify({ url, autoDuration: true, aspectRatio: "9:16", background: "blur", viewport: "vertical" }),
  });
  const start = await res.json();
  const id = start.id || start.job?.id;
  console.log(`START -> HTTP ${res.status}, job ${id}, initial ${start.job?.status}`);
  if (!id) throw new Error("no job id returned");

  // 5. Poll to completion
  let last = "";
  let status = "";
  for (let i = 0; i < 100; i++) {
    await sleep(5000);
    const s = await (await fetch(`${base}/api/record/${id}`, { headers: { "x-operator-secret": SECRET } })).json();
    status = s.status;
    const line = `${s.status} | ${s.message || ""}${s.error ? " | ERROR: " + s.error : ""}`;
    if (line !== last) {
      console.log(`POLL ${i}: ${line}`);
      last = line;
    }
    if (s.status === "done") break;
    if (s.status === "error") throw new Error(`render failed: ${s.error}`);
  }
  if (status !== "done") throw new Error("render timed out in check");

  // 6. Download + verify the MP4
  const dl = await fetch(`${base}/api/record/${id}/download`);
  const buf = Buffer.from(await dl.arrayBuffer());
  const hasMoov = buf.indexOf(Buffer.from("moov")) >= 0;
  const hasFtyp = buf.indexOf(Buffer.from("ftyp")) >= 0;
  const ok = hasMoov && hasFtyp && buf.length > 100000;
  console.log(`DOWNLOAD -> HTTP ${dl.status}, ${buf.length} bytes`);
  console.log(`MP4 CHECK -> moov=${hasMoov} ftyp=${hasFtyp} size=${buf.length} -> ${ok ? "PASS" : "FAIL"}`);
  fs.writeFileSync(path.join(os.tmpdir(), "worker-render-check.mp4"), buf);

  worker.kill();
  pageServer.close();
  console.log(`LOCAL RENDER CHECK: ${ok && unauthOk ? "PASS" : "FAIL"}`);
}

main().catch((e) => {
  console.error("CHECK FAILED:", e.message);
  process.exit(1);
});
