// A running watcher and the code under it: the copy lets a test change that code without
// touching the code under test. These tests start real watcher processes (no Claude sessions)
// from a copy of the code (RunningWatcherTest in tests/helpers.ts), which its cleanup kills.
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { check, field, read, RunningWatcherTest } from "./helpers.js";

let t: RunningWatcherTest;

// A running watcher and the code under it: the copy lets a test change that code without
// touching the code under test.
describe("WatcherCodeTests", () => {
  beforeEach(() => { t = new RunningWatcherTest(); });
  afterEach(() => t.cleanup());

  function changeCode(): void {
    fs.appendFileSync(t.marker, "a change\n");
  }

  it("a watcher restarts itself on new code between cycles", async () => {
    expect((await t.copySc(["watch", "--ensure"])).stdout).toContain("watcher running");
    const before = field(t.codeRecord(), "code");
    const old = t.pid();
    changeCode();
    expect(await t.waitFor(() => ![undefined, null, before].includes(t.codeRecord().code)),
      read(path.join(t.state, "watch.log"))).toBe(true);
    // One watcher runs: the one that recorded the new code. It may have replaced itself in
    // place (same pid, as the Python sc did) or started a new process and exited (as the TypeScript
    // sc does: docs/domains/watcher.md, "The watcher restarts itself").
    const pid = t.pid();
    expect(field(t.codeRecord(), "pid")).toEqual(pid);
    expect(t.alive(pid)).toBe(true);
    expect(await t.waitFor(() => old === pid || !t.alive(old))).toBe(true);
    expect(read(path.join(t.state, "watch.log"))).toContain("restarting on the new code");
    expect((await t.copySc(["summary"])).stdout).toContain("## Watcher\nrunning\n");
  });

  it("new code that does not load is refused and the old code keeps running", async () => {
    await t.copySc(["watch", "--ensure"]);
    const before = field(t.codeRecord(), "code");
    changeCode();
    const sc = path.join(t.code, "bin", "sc");
    fs.writeFileSync(sc, "def broken(:\n"); // fails in Python, Node and sh alike
    fs.chmodSync(sc, 0o755);
    expect(await t.waitFor(() => read(path.join(t.state, "watch.log")).includes("does not load"))).toBe(true);
    const beat = read(path.join(t.state, "watch.beat"));
    expect(await t.waitFor(() => read(path.join(t.state, "watch.beat")) !== beat)).toBe(true);
    expect(field(t.codeRecord(), "code")).toEqual(before);
  });

  it("ensure replaces a watcher that cannot vouch for its code", async () => {
    // A watcher started before watch.code existed records nothing about its code.
    await t.copySc(["watch", "--ensure"]);
    const old = t.pid();
    fs.unlinkSync(path.join(t.state, "watch.code"));
    expect((await t.copySc(["summary"])).stdout).toContain("older code");
    const out = await t.copySc(["watch", "--ensure"]);
    expect(out.stdout).toContain("was running older code, so it was restarted");
    expect(t.pid()).not.toEqual(old);
    expect(await t.waitFor(() => !t.alive(old))).toBe(true);
    expect(read(path.join(t.state, "watch.log"))).toContain("watcher stopped between cycles");
    expect(field(t.codeRecord(), "pid")).toEqual(t.pid());
  });

  it("cron list says when the watcher or sous chef cannot fire jobs", async () => {
    check(await t.copySc(["cron", "add", "tidy", "--every", "30m", "--target", "chef"],
      { stdin: "tidy up" }), "sc cron add");
    await t.copySc(["watch", "--ensure"]);
    let out = (await t.copySc(["cron", "list"])).stdout; // no sous chef registered
    expect(out).toContain("WARNING: sous chef is not running");
    fs.unlinkSync(path.join(t.state, "watch.code")); // as a watcher started by older code leaves it
    out = (await t.copySc(["cron", "list"])).stdout;
    expect(out).toContain("WARNING: the watcher running now was started by older code");
  });

  it("ensure leaves a watcher on current code alone", async () => {
    await t.copySc(["watch", "--ensure"]);
    const pid = t.pid();
    const out = await t.copySc(["watch", "--ensure"]);
    expect(out.stdout.trim()).toEqual("watcher running");
    expect(t.pid()).toEqual(pid);
  });
});
