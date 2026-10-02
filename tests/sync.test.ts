// Syncing the data folder: the watcher keeps a data folder that is a git repo with an upstream
// committed and pushed. Local bare repos stand in for GitHub; the fake clock drives the quiet
// period and retries.
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { git as gitIn, GIT_ENV, read, readJson, ScTest, write } from "./helpers.js";

let t: ScTest;

// The watcher keeps a data folder that is a git repo with an upstream committed and pushed.
// Local bare repos stand in for GitHub; the fake clock drives the quiet period and retries.
describe("SyncTests", () => {
  let remote: string;

  function git(folder: string, args: string[], o: { ok?: boolean } = {}): string {
    return gitIn(folder, args, { env: GIT_ENV, ok: o.ok });
  }

  beforeEach(async () => {
    t = new ScTest();
    Object.assign(t.baseEnv, GIT_ENV);
    remote = path.join(t.tmp, "data.git");
    git(t.tmp, ["init", "-q", "--bare", "-b", "main", remote]);
    write(path.join(t.home, ".gitignore"), "state/\n.env\n");
    fs.mkdirSync(path.join(t.home, "memory"));
    write(path.join(t.home, "memory", "focus.md"), "one\n");
    git(t.home, ["init", "-q", "-b", "main"]);
    git(t.home, ["add", "-A"]);
    git(t.home, ["commit", "-qm", "start"]);
    git(t.home, ["remote", "add", "origin", remote]);
    git(t.home, ["push", "-q", "-u", "origin", "main"]);
    await t.registerChef();
    const file = path.join(t.home, "state", "fake-runtime.json");
    const data = fs.existsSync(file) ? readJson(file) : { sessions: {}, wakes: [] };
    data.sessions["chef-1"] = { alive: true, busy: false };
    fs.writeFileSync(file, JSON.stringify(data));
  });
  afterEach(() => t.cleanup());

  async function watch(env: Record<string, string> = {}): Promise<string> {
    return (await t.sc(["watch", "--once"], { env })).stdout;
  }

  function splitlines(text: string): string[] {
    const lines = text.split(/\r?\n/);
    if (lines.at(-1) === "") lines.pop();
    return lines;
  }

  function remoteLog(): string[] {
    return splitlines(git(remote, ["log", "--format=%s", "main"]));
  }

  function syncEvents(): any[] { // eslint-disable-line @typescript-eslint/no-explicit-any
    const file = path.join(t.home, "state", "sync", "events.jsonl");
    return fs.existsSync(file) ? splitlines(read(file)).map((l) => JSON.parse(l)) : [];
  }

  function otherClonePushes(rel: string, text: string): void {
    const other = path.join(t.tmp, `other-${fs.readdirSync(t.tmp).filter((n) => n.startsWith("other-")).length}`);
    git(t.tmp, ["clone", "-q", remote, other]);
    write(path.join(other, rel), text);
    git(other, ["add", "-A"]);
    git(other, ["commit", "-qm", `elsewhere: ${rel}`]);
    git(other, ["push", "-q", "origin", "main"]);
  }

  async function changeAndWait(rel = "memory/focus.md", text = "two\n"): Promise<string> {
    fs.writeFileSync(path.join(t.home, rel), text);
    await watch();
    t.clock += 120;
    return watch();
  }

  it("without an upstream nothing is committed", async () => {
    git(t.home, ["branch", "--unset-upstream"]);
    await changeAndWait();
    expect(splitlines(git(t.home, ["log", "--oneline"])).length).toEqual(1);
    expect(git(t.home, ["status", "--porcelain"])).toContain("M memory/focus.md");
  });

  it("changes are committed after two quiet minutes and pushed", async () => {
    fs.writeFileSync(path.join(t.home, "memory", "focus.md"), "two\n");
    await watch();
    t.clock += 60;
    fs.writeFileSync(path.join(t.home, "memory", "ideas.md"), "an idea\n"); // a new change restarts the quiet period
    await watch();
    t.clock += 100;
    await watch();
    expect(remoteLog()).toEqual(["start"]);
    t.clock += 20;
    const out = await watch();
    expect(out).toContain("sync: committed 2 file(s)");
    expect(out).toContain("sync: pushed");
    expect(remoteLog()).toEqual(["sync: memory/focus.md, memory/ideas.md", "start"]);
    expect(git(t.home, ["status", "--porcelain"])).toEqual("");
  });

  it("state and env are never committed even if not ignored", async () => {
    fs.unlinkSync(path.join(t.home, ".gitignore"));
    fs.writeFileSync(path.join(t.home, ".env"), "SC_RELAY_KEY=secret\n");
    await changeAndWait();
    const files = git(remote, ["ls-tree", "-r", "--name-only", "main"]).split(/\s+/).filter(Boolean);
    expect(files).toContain("memory/focus.md");
    expect(files.filter((f) => f.startsWith("state/") || f === ".env"), JSON.stringify(files)).toEqual([]);
  });

  it("a remote that moved on is rebased onto", async () => {
    otherClonePushes("memory/ideas.md", "from the other machine\n");
    await changeAndWait();
    expect(remoteLog()).toEqual(["sync: memory/focus.md", "elsewhere: memory/ideas.md", "start"]);
    expect(read(path.join(t.home, "memory", "ideas.md"))).toEqual("from the other machine\n");
  });

  it("a conflict stops syncing wakes sous chef and restarts once resolved", async () => {
    otherClonePushes("memory/focus.md", "theirs\n");
    let out = await changeAndWait("memory/focus.md", "mine\n");
    expect(out).toContain("sync: stopped (conflict)");
    const events = syncEvents();
    expect(events).toHaveLength(1);
    const [stopped] = events;
    expect(stopped.state).toEqual("sync-stopped");
    expect(stopped.text).toContain("conflicted, so the rebase was aborted");
    expect(out).toContain("woke sous chef: True");
    expect(fs.existsSync(path.join(git(t.home, ["rev-parse", "--absolute-git-dir"]).trim(), "rebase-merge"))).toBe(false);
    expect(read(path.join(t.home, "memory", "focus.md"))).toEqual("mine\n");
    expect((await t.sc(["events"])).stdout).toContain("[sync] keeping your data folder committed and pushed");
    t.clock += 600;
    await watch();
    expect(syncEvents().length).toEqual(1); // still stopped: nothing changed
    // The owner resolves it by hand.
    git(t.home, ["pull", "-q", "--rebase", "-X", "theirs", "origin", "main"]);
    out = await watch();
    expect(out).toContain("sync: resumed");
    expect(syncEvents().at(-1).state).toEqual("sync-resumed");
    expect(out).toContain("sync: pushed");
    expect(remoteLog()[0]).toEqual("sync: memory/focus.md");
  });

  it("failed pushes are retried then stop syncing until a fetch works", async () => {
    git(t.home, ["remote", "set-url", "origin", path.join(t.tmp, "offline.git")]);
    let out = await changeAndWait();
    expect(out).toContain("fetch or push failed (1 in a row)");
    expect(await watch()).not.toContain("failed (2"); // backing off
    for (const n of [2, 3, 4]) {
      t.clock += 60 * 2 ** (n - 2);
      expect(await watch()).toContain(`failed (${n} in a row)`);
    }
    t.clock += 480;
    out = await watch();
    expect(out).toContain("sync: stopped (push)");
    const events = syncEvents();
    expect(events).toHaveLength(1);
    const [stopped] = events;
    expect(stopped.text).toContain("5 fetches or pushes in a row failed");
    t.clock += 600;
    expect(await watch()).not.toContain("resumed"); // still offline
    git(t.home, ["remote", "set-url", "origin", remote]);
    t.clock += 600;
    out = await watch();
    expect(out).toContain("sync: resumed");
    expect(out).toContain("sync: pushed");
    expect(syncEvents().at(-1).state).toEqual("sync-resumed");
    expect(remoteLog()[0]).toEqual("sync: memory/focus.md");
  });

  it("an uncommitted edit holds the push back instead of stopping sync", async () => {
    otherClonePushes("memory/ideas.md", "from the other machine\n");
    fs.writeFileSync(path.join(t.home, "memory", "focus.md"), "two\n");
    git(t.home, ["commit", "-qam", "unpushed"]); // one commit ahead of a remote that moved on
    fs.writeFileSync(path.join(t.home, "memory", "focus.md"), "three\n"); // and an edit still in its quiet period
    let out = await watch();
    expect(out).not.toContain("sync:");
    expect(syncEvents()).toEqual([]);
    t.clock += 120;
    out = await watch();
    expect(out).toContain("sync: committed 1 file(s)");
    expect(out).toContain("sync: pushed");
    expect(remoteLog().slice(0, 2)).toEqual(["sync: memory/focus.md", "unpushed"]);
    expect(syncEvents()).toEqual([]);
  });

  it("nothing is done while a merge is in progress", async () => {
    otherClonePushes("memory/focus.md", "theirs\n");
    fs.writeFileSync(path.join(t.home, "memory", "focus.md"), "mine\n");
    git(t.home, ["commit", "-qam", "mine"]);
    git(t.home, ["pull", "-q", "--no-rebase", "origin", "main"], { ok: false }); // conflicts, left for the owner
    t.clock += 600;
    await watch();
    t.clock += 600;
    await watch();
    expect(remoteLog()).toEqual(["elsewhere: memory/focus.md", "start"]);
    expect(syncEvents()).toEqual([]);
  });
});
