import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "net";
import { registerMixRoutes, argsAreContained } from "./mix";

test("argsAreContained keeps paths inside the session", () => {
  const d = "/tmp/mix-sessions/abc";
  assert.ok(argsAreContained(["-y", "-i", `${d}/a.mp4`, `${d}/o.mp4`, "-vf", "scale=1080:1920"], d));
  assert.ok(!argsAreContained(["-i", "/etc/passwd"], d));
  assert.ok(!argsAreContained(["-i", `${d}/../x`], d));
  assert.ok(!argsAreContained(["-i", "http://evil/x.mp4"], d));
  assert.ok(!argsAreContained("nope", d));
});

test("session: upload → ffmpeg → download → delete", async () => {
  const app = express();
  app.use(express.json());
  registerMixRoutes(app, (_q, _r, n) => n());
  const srv = app.listen(0);
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  try {
    const { id, dir } = (await (await fetch(`${base}/api/mix/session`, { method: "POST" })).json()) as any;
    const run = (bin: string, args: string[]) =>
      fetch(`${base}/api/mix/${id}/run`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ bin, args }) });
    let r = await run("/usr/bin/ffmpeg", ["-y", "-f", "lavfi", "-i", "color=c=red:s=64x64:d=1", "-pix_fmt", "yuv420p", `${dir}/t.mp4`]);
    assert.equal(r.status, 200);
    r = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", `${dir}/t.mp4`]);
    assert.ok(parseFloat(((await r.json()) as any).stdout) > 0.5);
    const up = await fetch(`${base}/api/mix/${id}/file?name=copy.mp4`, { method: "PUT", headers: { "content-type": "application/octet-stream" }, body: Buffer.from("hello") });
    assert.equal(up.status, 200);
    const dl = await fetch(`${base}/api/mix/${id}/file?name=t.mp4`);
    assert.equal(dl.status, 200);
    assert.ok((await dl.arrayBuffer()).byteLength > 100);
    assert.equal((await run("rm", ["-rf", "/"])).status, 400);
    r = await run("ffmpeg", ["-i", `${dir}/missing.mp4`, `${dir}/o.mp4`]);
    assert.equal(r.status, 422);
    await fetch(`${base}/api/mix/${id}`, { method: "DELETE" });
    assert.equal((await fetch(`${base}/api/mix/${id}/file?name=t.mp4`)).status, 404);
  } finally {
    srv.close();
  }
});
