// The file locks (src/lock.ts): one holder at a time, and a dead holder's lock taken over.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { holdLock, isHeld, STALE_MS, withLock } from "../src/lock.js";
import { isRunning } from "../src/watch.js";

const tmps: string[] = [];
afterEach(() => {
  for (const t of tmps.splice(0)) fs.rmSync(t, { recursive: true, force: true });
});

function tmpdir(): string {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), "lock-"));
  tmps.push(t);
  return t;
}

const LOCK_MODULE = path.resolve(import.meta.dirname, "..", "node_modules", "proper-lockfile", "index.js");

/** A separate Node process holding the lock on `p` until killed; resolves once it holds it. */
function holder(p: string) {
  const code = `const l = require(${JSON.stringify(LOCK_MODULE)});
    l.lock(${JSON.stringify(p)}, {realpath: false, stale: ${STALE_MS}}).then(() => console.log("held"));
    setInterval(() => {}, 1000);`;
  const child = spawn(process.execPath, ["-e", code], { stdio: ["ignore", "pipe", "inherit"] });
  return new Promise<typeof child>((resolve) => child.stdout.once("data", () => resolve(child)));
}

describe("withLock", () => {
  it("runs one holder at a time and leaves no lock behind", async () => {
    const p = path.join(tmpdir(), "state", ".events.lock");
    const order: string[] = [];
    await Promise.all([1, 2].map((n) => withLock(p, async () => {
      order.push(`in ${n}`);
      await new Promise((r) => setTimeout(r, 50));
      order.push(`out ${n}`);
    })));
    expect(order).toEqual(["in 1", "out 1", "in 2", "out 2"]);
    expect(fs.existsSync(`${p}.lock`)).toBe(false);
    expect(fs.existsSync(p)).toBe(false); // the lock is the folder <path>.lock, never <path> itself
  });

  it("waits for another process that holds the lock", async () => {
    const p = path.join(tmpdir(), ".seq.lock");
    const child = await holder(p);
    const started = Date.now();
    setTimeout(() => child.kill("SIGTERM"), 500);
    await withLock(p, () => undefined);
    expect(Date.now() - started).toBeGreaterThanOrEqual(400);
  });

  // Python's flock waited as long as the holder held; giving up after a set time crashed
  // sc with proper-lockfile's error while a slow holder (the cron run lock, held through
  // launches) was still working.
  it("keeps waiting for a live holder longer than the old 15-second limit", async () => {
    const p = path.join(tmpdir(), ".runs.lock");
    const child = await holder(p);
    const started = Date.now();
    setTimeout(() => child.kill("SIGTERM"), 18_000);
    await withLock(p, () => undefined);
    expect(Date.now() - started).toBeGreaterThanOrEqual(17_500);
  }, 40_000);
});

describe("the watcher's lock", () => {
  it("is taken over from a holder killed outright once it goes stale", async () => {
    const p = path.join(tmpdir(), "watch.lock");
    const child = await holder(p);
    expect(await isHeld(p)).toBe(true);
    expect(await holdLock(p, 0.3, () => undefined)).toBeNull();
    child.kill("SIGKILL");
    const started = Date.now();
    const release = await holdLock(p, 12, () => undefined);
    expect(release).not.toBeNull();
    expect(Date.now() - started).toBeLessThan(STALE_MS + 2000);
    await release!();
    expect(await isHeld(p)).toBe(false);
  }, 20000);
});

describe("isRunning", () => {
  it("is false while a dead watcher's lock still looks held, and true for a live one", async () => {
    const home = tmpdir();
    const saved = process.env.SC_TEST_HOME;
    process.env.SC_TEST_HOME = home;
    try {
      const state = path.join(home, "state");
      fs.mkdirSync(state);
      const child = await holder(path.join(state, "watch.lock"));
      fs.writeFileSync(path.join(state, "watch.pid"), String(child.pid));
      expect(await isRunning()).toBe(true);
      child.kill("SIGKILL");
      await new Promise((r) => child.once("exit", r));
      expect(await isHeld(path.join(state, "watch.lock"))).toBe(true); // not stale yet
      expect(await isRunning()).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.SC_TEST_HOME;
      else process.env.SC_TEST_HOME = saved;
    }
  });
});
