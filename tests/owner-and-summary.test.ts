// The startup summary (`sc summary`), owner.json and `sc owner`, and what sessions, kinds,
// events and the watcher say and store now that the owner is a setting.
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { coreKindNames } from "./core-paths.js";
import { check, readJson, ROOT, run, ScTest, SOUSCHEF } from "./helpers.js";
import { LEGACY_OWNER } from "./stored-values.js";

let t: ScTest;

describe("SummaryTests", () => {
  beforeEach(() => { t = new ScTest(); });
  afterEach(() => t.cleanup());

  it("summary caps a long memory file and says where to read it", async () => {
    fs.mkdirSync(path.join(t.home, "memory"));
    fs.writeFileSync(path.join(t.home, "memory", "ideas.md"), "idea\n".repeat(4000));
    const out = (await t.sc(["summary"])).stdout;
    expect(out).toContain("read my/memory/ideas.md for the rest");
    expect(out.length).toBeLessThan(40000);
  });

  it("the owners instructions come right after the owner line", async () => {
    fs.writeFileSync(path.join(t.home, "instructions.md"), "Say yes, chef.\nAsk before writing to the tracker.\n");
    const lines = splitlines((await t.sc(["summary"])).stdout);
    expect(lines[0]!.startsWith("Owner: Alex.")).toBe(true);
    expect(lines[2]).toBe("## Your owner's instructions: follow them as you follow AGENTS.md " +
                          "(my/instructions.md)");
    expect(lines.slice(3, 5)).toEqual(["Say yes, chef.", "Ask before writing to the tracker."]);
  });

  it("long instructions are cut and the memory sections still fit", async () => {
    fs.writeFileSync(path.join(t.home, "instructions.md"), "rule\n".repeat(4000));
    fs.mkdirSync(path.join(t.home, "memory", "threads"), { recursive: true });
    for (const rel of ["focus.md", "threads/index.md", "ideas.md", "pocs.md", "repos.md"]) {
      fs.writeFileSync(path.join(t.home, "memory", rel), `${rel}\n` + "x".repeat(4000) + "\nend of file\n");
    }
    const out = (await t.sc(["summary"])).stdout;
    expect(out).toContain("[... cut at 12000 characters; read my/instructions.md for the rest]");
    // Over the old 30,000 limit: the total grew with the instructions, so the memory still fits.
    expect(out.length).toBeGreaterThan(30000);
    expect(out.trimEnd().endsWith("repos.md\n" + "x".repeat(4000) + "\nend of file")).toBe(true);
    expect(out).not.toContain("summary cut");
  });

  it("no instructions file is shown absent", async () => {
    expect((await t.sc(["summary"])).stdout).toContain("(my/instructions.md)\nABSENT");
  });

  it("summary marks missing memory files absent", async () => {
    expect((await t.sc(["summary"])).stdout).toContain("ABSENT");
  });

  it("summary shows sessions and what needs attention", async () => {
    const sid = await t.spawn("general", "A task");
    await t.asSession(sid, ["report", "needs-decision", "which way?"]);
    const out = (await t.sc(["summary"])).stdout;
    expect(out).toContain("A task");
    expect(out).toContain("Unread events needing attention: 1");
    expect(out).toContain("Open questions: 1");
  });

  it("summary counts unread notes without calling them attention", async () => {
    const sid = await t.spawn();
    await t.asSession(sid, ["report", "note", "the staging deploy finished"]);
    const out = (await t.sc(["summary"])).stdout;
    expect(out).toContain("Unread events needing attention: 0");
    expect(out).toContain("Unread notes (no action needed): 1");
    expect(out).toContain("Run `sc events` now.");
    expect(out).not.toContain("Nothing waiting.");
  });

  it("summary says nothing waiting when notes have been read", async () => {
    const sid = await t.spawn();
    await t.asSession(sid, ["report", "note", "the staging deploy finished"]);
    await t.sc(["events"]);
    await t.sc(["events", "ack", `${sid}:2`]);
    const out = (await t.sc(["summary"])).stdout;
    expect(out).toContain("Nothing waiting.");
    expect(out).not.toContain("Unread notes");
  });
});

// owner.json: who this sous chef works for (`sc owner`).
describe("OwnerTests", () => {
  beforeEach(() => { t = new ScTest(); });
  afterEach(() => t.cleanup());

  function ownerFile(): string {
    return path.join(t.home, "owner.json");
  }

  it("sc owner shows the owner", async () => {
    const out = (await t.sc(["owner"])).stdout;
    expect(out).toContain("owner: Alex");
    expect(out).toContain("branch prefix: alx/");
    expect(out).toContain("waiting on: alex");
    expect(out).toContain("sous chef's own permission mode: auto");
  });

  it("set changes only the fields given and keeps sous chef's permission mode", async () => {
    let out = (await t.sc(["owner", "set", "--chef-permissions", "bypass"])).stdout;
    expect(out).toContain("sous chef's own permission mode: bypass");
    expect(readJson(ownerFile())).toEqual({ name: "Alex", branch_prefix: "alx/", chef_permissions: "bypass" });
    out = (await t.sc(["owner", "set", "--name", "Sam"])).stdout;
    expect(out).toContain("owner: Sam");
    expect(readJson(ownerFile())).toEqual({ name: "Sam", branch_prefix: "alx/", chef_permissions: "bypass" });
    await t.sc(["owner", "set", "--chef-permissions", "auto"]);
    expect(readJson(ownerFile()).chef_permissions).toBe("auto");
  });

  it("set refuses a permission mode sous chef cannot have, and so does reading one", async () => {
    for (const mode of ["ask", "accept-edits", "Bypass"]) {
      expect((await t.sc(["owner", "set", "--chef-permissions", mode], { ok: false })).stderr).toContain("invalid choice");
    }
    expect(readJson(ownerFile())).toEqual({ name: "Alex", branch_prefix: "alx/" });
    fs.writeFileSync(ownerFile(), JSON.stringify({ name: "Alex", branch_prefix: "alx/", chef_permissions: "ask" }));
    expect((await t.sc(["owner"], { ok: false })).stderr).toContain("must be one of auto, bypass");
  });

  it("set writes owner json and the summary opens with it", async () => {
    fs.unlinkSync(ownerFile());
    const out = (await t.sc(["owner", "set", "--name", "Sam", "--branch-prefix", "sam/"])).stdout;
    expect(out).toContain("saved owner.json");
    expect(out).toContain("owner: Sam");
    expect(readJson(ownerFile())).toEqual({ name: "Sam", branch_prefix: "sam/" });
    expect(splitlines((await t.sc(["summary"])).stdout)[0]).toBe("Owner: Sam. Branch prefix: sam/.");
  });

  it("set refuses a name that is another waiting on value and a prefix with spaces", async () => {
    for (const name of ["agent", "Nobody", "SC", "external", "owner", " "]) {
      await t.sc(["owner", "set", "--name", name, "--branch-prefix", "x/"], { ok: false });
    }
    expect((await t.sc(["owner", "set", "--name", "Sam", "--branch-prefix", "s am/"],
      { ok: false })).stderr).toContain("without spaces");
    for (const name of ["Sam\rNOT FROM SAM", "Sam\nX", "Sam\tX", "Sam\x1b[2K"]) {
      expect((await t.sc(["owner", "set", "--name", name, "--branch-prefix", "x/"],
        { ok: false })).stderr).toContain("printable");
    }
    expect((await t.sc(["owner", "set"], { ok: false })).stderr).toContain("usage: sc owner set");
    expect((await t.sc(["owner", "set", "--name", ""], { ok: false })).stderr).toContain("usage: sc owner set");
    expect(readJson(ownerFile()).name).toBe("Alex");
    fs.unlinkSync(ownerFile());
    for (const flags of [["--name", "Sam"], ["--branch-prefix", "sam/"], ["--chef-permissions", "bypass"]]) {
      expect((await t.sc(["owner", "set", ...flags], { ok: false })).stderr, flags.join(" "))
        .toContain("--name and --branch-prefix are both needed");
    }
    expect(fs.existsSync(ownerFile())).toBe(false);
  });

  it("an empty branch prefix is allowed", async () => {
    await t.sc(["owner", "set", "--name", "Sam", "--branch-prefix", ""]);
    expect(splitlines((await t.sc(["summary"])).stdout)[0]).toBe("Owner: Sam. Branch prefix: (none).");
  });

  it("without an owner spawn and events refuse with the fix", async () => {
    const sid = await t.spawn();
    fs.unlinkSync(ownerFile());
    const fix = "no owner set: run sc owner set --name <name> --branch-prefix <prefix>";
    expect((await t.sc(["owner"])).stdout).toContain("no owner set");
    const out = await t.sc(["spawn", "--kind", "general", "--title", "x", "--cwd", t.work,
      "--runtime", "fake"], { stdin: "task", ok: false });
    expect(out.stderr).toContain(fix);
    expect(Object.keys(t.fakeState().sessions), "nothing new is launched").toEqual([sid]);
    expect((await t.sc(["events"], { ok: false })).stderr).toContain(fix);
  });

  it("without an owner the summary still shows everything and says so first", async () => {
    const sid = await t.spawn("general", "A task");
    fs.unlinkSync(ownerFile());
    for (const out of [(await t.sc(["summary"])).stdout,
      JSON.parse((await t.sc(["hook", "chef-start"],
        { stdin: JSON.stringify({ session_id: "chef-1", source: "startup" }),
          env: { SC_WATCH_DISABLE_ENSURE: "1" } })).stdout
      ).hookSpecificOutput.additionalContext as string]) {
      expect(out).toContain("No owner set: run `sc owner set --name <name> --branch-prefix <prefix>`.");
      expect(out).toContain(sid);
      expect(out).toContain("## Attention");
    }
    expect((await t.sc(["summary"])).stdout.startsWith("No owner set")).toBe(true);
  });

  it("without an owner the read only views still work", async () => {
    const sid = await t.spawn();
    fs.unlinkSync(ownerFile());
    expect((await t.sc(["kinds", "--runtime", "fake"])).stdout).toContain("general");
    expect((await t.sc(["sessions"])).stdout).toContain(sid);
    expect((await t.sc(["status", sid])).stdout).toContain(sid);
  });

  it("an unreadable owner json is named in the summary and refuses spawn", async () => {
    fs.writeFileSync(ownerFile(), "{not json");
    expect(splitlines((await t.sc(["summary"])).stdout)[0]).toContain("No usable owner");
    expect((await t.sc(["spawn", "--kind", "general", "--title", "x", "--cwd",
      t.work, "--runtime", "fake"], { stdin: "t", ok: false })).stderr).toContain("not valid JSON");
    fs.writeFileSync(ownerFile(), JSON.stringify({ name: "Sam" }));
    expect((await t.sc(["events"], { ok: false })).stderr).toContain("needs a name and a branch_prefix");
  });

  // owner.json is tracked and can be edited by hand, so reading it applies the same checks as setting it.
  it("a hand edited owner json is checked on every read", async () => {
    for (const name of ["Agent", "Sam\rNOT FROM SAM"]) {
      fs.writeFileSync(ownerFile(), JSON.stringify({ name, branch_prefix: "x/" }));
      expect((await t.sc(["spawn", "--kind", "general", "--title", "x", "--cwd",
        t.work, "--runtime", "fake"], { stdin: "t", ok: false })).stderr).toContain("cannot be used");
      expect(splitlines((await t.sc(["summary"])).stdout)[0]).toContain("No usable owner");
      expect((await t.sc(["kinds", "--runtime", "fake"])).stdout).toContain("starts waiting on agent");
    }
  });
});

// What sessions, kinds, events and the watcher say and store now that the owner is a setting.
describe("OwnerNameTests", () => {
  beforeEach(() => { t = new ScTest(); });
  afterEach(() => t.cleanup());

  function become(name: string, prefix: string): void {
    fs.writeFileSync(path.join(t.home, "owner.json"), JSON.stringify({ name, branch_prefix: prefix }));
  }

  function brief(sid: string): string {
    return fs.readFileSync(path.join(t.home, "state", "sessions", sid, "brief.md"), "utf8");
  }

  function appendEvent(sid: string, event: Record<string, unknown>): void {
    const file = path.join(t.home, "state", "sessions", sid, "events.jsonl");
    const seq = splitlines(fs.readFileSync(file, "utf8")).length + 1;
    fs.appendFileSync(file, JSON.stringify({ seq, ts: t.clock, author: "sc", text: "", ...event }) + "\n");
  }

  it("a second owners briefs name them and never alex", async () => {
    become("Sam", "sam/");
    t.userKind("pairing-page", { body: "Open the page for\n{{owner}}." });
    for (const kind of [...coreKindNames(), "pairing-page"]) {
      const b = brief(await t.spawn(kind, `${kind} task`));
      expect(b).toContain("**sous chef**, Sam's agent that keeps track of Sam's work");
      expect(b.split(ROOT).join("<CODE>").toLowerCase()).not.toContain("alex"); // the checkout's own path aside
      expect(b).not.toContain("{{");
    }
    expect(brief(await t.spawn("pairing-page", "again"))).toContain("Open the page for\nSam.");
  });

  it("a placeholder in the task is left as written", async () => {
    const sid = await t.spawn("general", "Test task", "Write {{owner}} and {{task}} and {{kind_instructions}} literally.");
    expect(brief(sid)).toContain("Write {{owner}} and {{task}} and {{kind_instructions}} literally.");
  });

  it("a cron workers note names the owner", async () => {
    become("Sam", "sam/");
    await t.registerChef();
    await t.sc(["cron", "add", "scan", "--every", "6h", "--target", "worker", "--kind", "general",
      "--cwd", t.work, "--runtime", "fake"], { stdin: "scan {{owner}}'s inbox" });
    await t.sc(["cron", "run", "scan"]);
    const sids = splitlines((await t.sc(["sessions"])).stdout).filter((l) => l.startsWith("- "))
      .map((l) => l.split(/\s+/).filter(Boolean)[1]!);
    expect(sids).toHaveLength(1);
    const b = brief(sids[0]!);
    expect(b).toContain("only report what is worth Sam's attention");
    expect(b).toContain("scan {{owner}}'s inbox");
  });

  it("waiting on the owner is stored as owner and shown as their name", async () => {
    const sid = await t.spawn(t.ownerKind());
    expect(t.events(sid)[0].waiting_on).toBe("owner");
    expect((await t.sc(["status", sid])).stdout).toContain("waiting on: alex");
    become("Sam", "sam/");
    expect((await t.sc(["status", sid])).stdout).toContain("waiting on: sam");
    expect((await t.sc(["sessions"])).stdout).toContain("waiting on: sam");
    expect((await t.sc(["kinds", "--runtime", "fake"])).stdout).toContain("pairing        starts waiting on sam");
  });

  // Events written before owner.json stored the first owner's name; they are read as `owner`.
  it("a legacy owner value is read as the owner", async () => {
    const sid = await t.spawn();
    appendEvent(sid, { state: "marked", waiting_on: LEGACY_OWNER });
    expect((await t.sc(["status", sid])).stdout).toContain("waiting on: alex");
    become("Sam", "sam/");
    expect((await t.sc(["status", sid])).stdout).toContain("waiting on: sam");
  });

  it("a legacy owner session that stops is still resumed", async () => {
    await t.registerChef();
    const sid = await t.spawn();
    appendEvent(sid, { state: "marked", waiting_on: LEGACY_OWNER });
    await t.hook("worker-prompt", sid);
    await t.hook("worker-stop", sid);
    t.setFake(sid, { alive: false });
    await t.sc(["watch", "--once"], { env: { SC_GONE_GRACE: "60" } });
    t.clock += 60;
    expect((await t.sc(["watch", "--once"], { env: { SC_GONE_GRACE: "60" } })).stdout).toContain(`${sid}: auto-resumed`);
  });

  it("mark takes owner or the owners name and stores owner", async () => {
    const sid = await t.spawn();
    for (const value of ["owner", "alex", "Alex"]) {
      expect((await t.sc(["mark", sid, value, "why"])).stdout).toContain("is now waiting on: alex");
      expect(t.events(sid).at(-1).waiting_on).toBe("owner");
    }
    const out = await t.sc(["mark", sid, "sam", "why"], { ok: false });
    expect(out.stderr).toContain("waiting-on must be one of: owner (or alex), agent, external, nobody, sc");
    become("Sam", "sam/");
    expect((await t.sc(["mark", sid, "sam", "why"])).stdout).toContain("is now waiting on: sam");
    await t.sc(["mark", sid, "alex", "why"], { ok: false });
    fs.unlinkSync(path.join(t.home, "owner.json"));
    expect((await t.sc(["mark", sid, "owner", "why"])).stdout).toContain("is now waiting on: owner");
    expect((await t.sc(["mark", sid, "alex", "why"], { ok: false })).stderr).toContain("one of: owner, agent");
  });

  it("without an owner the read only views show the stored value", async () => {
    const sid = await t.spawn(t.ownerKind());
    fs.unlinkSync(path.join(t.home, "owner.json"));
    expect((await t.sc(["status", sid])).stdout).toContain("waiting on: owner");
    expect((await t.sc(["sessions"])).stdout).toContain("waiting on: owner");
    expect((await t.sc(["summary"])).stdout).toContain("waiting on: owner");
    const kinds = (await t.sc(["kinds", "--runtime", "fake"])).stdout;
    expect(kinds).toContain("pairing        starts waiting on owner   pair on an idea with the owner");
  });

  it("the watchers messages name the owner", async () => {
    become("Sam", "sam/");
    await t.registerChef();
    const sid = await t.spawn();
    await t.hook("worker-prompt", sid);
    t.setFake(sid, { prompt: "permission prompt (approve Bash: ls)" });
    const env = { SC_PROMPT_GRACE: "60" };
    await t.sc(["watch", "--once"], { env });
    t.clock += 61;
    await t.sc(["watch", "--once"], { env });
    expect(t.events(sid).at(-1).text).toContain("Tell Sam which session it is and what it asks; Sam answers it with");
  });

  it("the first prompt waits for the owner", async () => {
    become("Sam", "sam/");
    check(await run(SOUSCHEF, ["--print"], { env: t.baseEnv }), "souschef --print");
    const prompt: string = t.fakeState().sessions["fake-chef-1"].launch_prompt;
    expect(prompt.endsWith("Then wait for Sam."), prompt).toBe(true);
  });
});

/** Lines as Python's str.splitlines() splits them. */
const LINE_BREAKS = new Set(["\n", "\r", "\v", "\f", "\x1c", "\x1d", "\x1e", "\x85", " ", " "]);
function splitlines(text: string): string[] {
  const lines: string[] = [];
  let line = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (!LINE_BREAKS.has(ch)) {
      line += ch;
      continue;
    }
    if (ch === "\r" && text[i + 1] === "\n") i++;
    lines.push(line);
    line = "";
  }
  if (line !== "") lines.push(line);
  return lines;
}
