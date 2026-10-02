// run() in src/proc.ts: the one way sous chef runs other programs (git, claude, the load check).
import { describe, expect, it } from "vitest";
import { run } from "../src/proc.js";

describe("run", () => {
  it("captures all of a program's output and its exit code", async () => {
    const r = await run("bash", ["-c", "for i in $(seq 1 20000); do echo \"line $i\"; done; echo oops >&2; exit 3"]);
    expect(r.code).toBe(3);
    expect(r.timedOut).toBeUndefined();
    const lines = r.stdout.split("\n");
    expect(lines).toHaveLength(20001);
    expect(lines[19999]).toBe("line 20000");
    expect(r.stderr).toBe("oops\n");
  });

  it("waits for output a program's background child writes after the program itself ends", async () => {
    const r = await run("bash", ["-c", "(sleep 0.3; echo late) & echo early"], { timeout: 10 });
    expect(r).toEqual({ code: 0, stdout: "early\nlate\n", stderr: "" });
  });

  it("feeds stdin", async () => {
    expect((await run("cat", [], { input: "in\n" })).stdout).toBe("in\n");
  });

  // Python's subprocess.run returned right after killing the program; a child still holding
  // its pipes (ssh under git fetch) must not hold the caller, the watcher above all.
  it("returns promptly at its timeout while the killed program's child holds the pipes", async () => {
    const start = Date.now();
    const r = await run("bash", ["-c", "sleep 8 & echo hi; sleep 30"], { timeout: 1 });
    expect((Date.now() - start) / 1000).toBeLessThan(3);
    expect(r).toEqual({ code: 124, stdout: "hi\n", stderr: "", timedOut: true });
  }, 15000);

  it("returns at its timeout when the program has ended but its child still holds the pipes", async () => {
    const start = Date.now();
    const r = await run("bash", ["-c", "sleep 8 & echo hi"], { timeout: 1 });
    expect((Date.now() - start) / 1000).toBeLessThan(3);
    expect(r).toEqual({ code: 124, stdout: "hi\n", stderr: "", timedOut: true });
  }, 15000);

  it("says when a program cannot be started", async () => {
    const r = await run("no-such-program-sc-test", []);
    expect(r.code).toBe(127);
    expect(r.error).toBeInstanceOf(Error);
  });
});
