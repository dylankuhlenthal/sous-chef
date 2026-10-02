// `sc setup`'s question about sous chef's own permission mode, asked as it is at a terminal:
// the risk explained first, auto as the default, and asked again until the answer is auto
// or bypass. The answers come from a test Asker instead of a terminal; install.sh's piped
// form, which reads the real terminal (/dev/tty), is checked by hand
// (docs/decisions/0032-install-sh-also-runs-piped-from-the-web.md).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Asker, CHEF_PERMISSIONS_RISK, chooseChefPermissions, SetupArgs } from "../src/setup.js";

class Answers extends Asker {
  prompts: string[] = [];

  constructor(private answers: string[]) {
    super(true);
    this.interactive = true;
  }

  protected override async input(prompt: string): Promise<string> {
    this.prompts.push(prompt);
    const answer = this.answers.shift();
    if (answer === undefined) throw new Error(`asked more than expected: ${prompt}`);
    return answer;
  }
}

const ARGS: SetupArgs = { data: null, clone: null, git: null, push_url: null, name: null, branch_prefix: null,
  bin_dir: null, chef_permissions: null, yes: false };

let data: string;
beforeEach(() => {
  data = fs.mkdtempSync(path.join(os.tmpdir(), "setup-questions-"));
  fs.writeFileSync(path.join(data, "owner.json"), JSON.stringify({ name: "Sam", branch_prefix: "sam/" }));
});
afterEach(() => fs.rmSync(data, { recursive: true, force: true }));

async function choose(answers: string[], newOwner = true) {
  const said: string[] = [];
  const ask = new Answers(answers);
  await chooseChefPermissions(data, ARGS, ask, newOwner, (s) => said.push(s));
  const owner = JSON.parse(fs.readFileSync(path.join(data, "owner.json"), "utf8"));
  return { said, prompts: ask.prompts, owner };
}

describe("SetupQuestionTests", () => {
  it("explains the risk before asking, and a blank answer is auto", async () => {
    const r = await choose([""]);
    expect(r.said[0]).toBe(CHEF_PERMISSIONS_RISK);
    expect(r.said[0]).toContain("bypass  nothing ever waits for you");
    expect(r.prompts).toEqual(["Sous chef's own permission mode (auto or bypass) [auto]: "]);
    expect(r.owner.chef_permissions).toBe("auto");
  });

  it("asks again until the answer is auto or bypass", async () => {
    const r = await choose(["yes", "ask", "bypass"]);
    expect(r.prompts.length).toBe(3);
    expect(r.said.filter((s) => s === "answer auto or bypass").length).toBe(2);
    expect(r.owner).toEqual({ name: "Sam", branch_prefix: "sam/", chef_permissions: "bypass" });
  });

  it("asks an existing owner with no mode, and never one who has chosen", async () => {
    expect((await choose(["bypass"], false)).owner.chef_permissions).toBe("bypass");
    const again = await choose([], false);
    expect(again.prompts).toEqual([]);
    expect(again.owner.chef_permissions).toBe("bypass");
  });
});
