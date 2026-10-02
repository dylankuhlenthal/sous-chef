# Adding a kind

A kind is a way of working, such as investigating or building. Adding one is adding a file; no code changes.

## Core kind or user kind

- A **user kind** belongs to the person running sous chef. It goes in `my/kinds/`, in the owner's data folder (`util.userKindsDir()`). A user kind with the same name as a core kind replaces it as a whole file, which is how someone changes a built-in kind without editing the core; `sc kinds` then marks it `[user, replaces core]`. Kinds that run someone's own skills (such as the owner's `shape`, `build`, `mega-shape` and `orchestrate`) are user kinds.
- A **core kind** ships with sous chef, in the core's `kinds/` (`util.kindsDir()`), and is on the core's path list (`tests/core-paths.ts`). Core kinds need no skills, so they work for anyone: today `general` and `investigate`.

Lookup order and the rest: "Kinds" in `docs/domains/sessions.md`.

## Steps

1. Create `<name>.md` in the right `kinds/` folder. The name must be lowercase kebab-case (`[a-z0-9][a-z0-9-]*`); any other name is refused as an unknown kind.

   ```markdown
   ---
   description: one line shown by `sc kinds`
   starts_waiting_on: agent
   ---
   Instructions for this kind of session.
   ```

2. Choose `starts_waiting_on`:
   - `owner` when the session is only useful once the owner joins it (shaping, discussing). Sous chef tells the owner it is ready to attach, and the watcher does not report it as stopped while it waits.
   - `agent` when the session works on its own and reports back.
3. Choose `permissions`, or leave the line out. It is the permission mode a session of this kind launches in when `sc spawn` is not given `--permissions`, and takes the same values (`sc spawn --help` lists them). Without it the session runs in `auto`. Set it only when the owner has decided the kind should run in another mode, as for the owner's four skill kinds (decision 0016, kinds set their default permission mode). A scheduled job of this kind inherits the mode too. `sc kinds` refuses an unknown value.
4. If the kind runs a skill, declare it with `skill`, as a bare name without a slash. Declare only the skill the instructions tell the session to run, not the skills that skill calls in turn.

   ```markdown
   ---
   description: build a shaped issue and open a PR (/build)
   starts_waiting_on: agent
   skill: build
   ---
   Run the `/build` skill on the issue in the task.
   ```

   `sc spawn` then refuses the kind when the runtime says the skill is missing, before anything is written, and `sc kinds` shows the skill and whether it is found. For a skill the check cannot see on disk, declare its namespaced name (for example `skill: anthropic-skills:build`), which is not checked. You do not need to tell the session what to do when a skill or tool is missing: the brief already tells every session to report `blocked`, naming it.
5. Write the instructions for what is specific to this kind only. The brief (`templates/worker-brief.md`) already covers reporting, messages, missing skills and tools, and the rules on what needs asking. Say:
   - which skill to run, if any, written as `/<skill>`: `sc kinds` warns when the instructions never name the declared skill that way;
   - what the task authorises (for example "opening the PR is part of this task"), because anything not named needs a `needs-decision` first;
   - when to report `waiting` or `working`, if that differs from the brief;
   - what the `done` report must include (links, report path).

   Write `{{owner}}` wherever the instructions or the description name the owner; it is filled with the owner's name from `my/owner.json` (`kinds.load`, `ops.renderBrief`). Never write a name.
6. Run `sc kinds` to check it loads, shows the right skill as found, and prints no warning. For a core kind, add it to `CORE_PATHS` in `tests/core-paths.ts` (otherwise it is left out of the published core, and the check that every tracked file is core fails), update the captured `sc kinds` output (`SC_UPDATE_CAPTURED=1`), and update the core kinds table in `docs/domains/sessions.md` (including its permissions and skill columns) and any example in `AGENTS.md` that would now be wrong. Nothing checks that those lists match `kinds/`, so they drift if you skip this.
7. Add a test if a core kind has behaviour worth pinning. Tests write their own kinds into the test home's `kinds/` (`ScTest.userKind` in `tests/helpers.ts`) rather than depend on a shipped kind; `KindSkillTests` and `KindListingTests` show the shape.

## Example

`kinds/investigate.md` is the canonical example of a core kind: an `agent` kind that needs no skill and limits what the session may do.
