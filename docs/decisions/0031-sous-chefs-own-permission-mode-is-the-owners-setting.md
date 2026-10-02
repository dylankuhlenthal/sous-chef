# 0031: Sous chef's own permission mode is the owner's setting

**Date:** 2026-10-02
**Status:** Accepted. Replaces the decision part of decision 0015 (sous chef itself runs in bypass mode).

## Context
Decision 0015 made `souschef` start sous chef's own session in `bypass` mode for everyone, through a constant in `src/souschef.ts`. That was the first owner's informed choice: they were told that in `bypass` nothing sous chef does waits for a person, though it reads messages from other people and can run commands, push and write to their tools. With the core going public, anyone who installs it would inherit that choice without being told. Set aside: keeping `bypass` for everyone with a warning in the README, and a setting that defaults to `bypass`.

## Decision
The mode is the owner's setting, `chef_permissions` in `my/owner.json`, either `auto` or `bypass`. `sc setup` asks for it when `owner.json` has none, after a paragraph explaining what each mode risks, and defaults to `auto`; with `--yes` a new `owner.json` gets `auto`, and an existing one is left as it is. A file without the field means `auto`. `sc owner` shows it, `sc owner set --chef-permissions` changes it, and `souschef` reads it when it starts a new sous chef and says which mode it started in. The other spawn modes (`accept-edits`, `ask`) are not offered: an unattended sous chef that asks before every action, or every non-edit action, would mostly sit at prompts.

The first owner keeps `bypass` by setting it once (`sc owner set --chef-permissions bypass`); their running sous chef keeps its mode until a `souschef --new` anyway.

## Consequences
A new owner's sous chef runs in `auto` unless they choose otherwise, so it can stop at a permission prompt while they are away, with nothing watching sous chef itself to report it; the install question says so. A resumed sous chef keeps the mode it was started with, as before, so a changed setting takes effect at the next `souschef --new`. Everything else decision 0015 recorded about the risk of `bypass` still holds for an owner who chooses it. How it works: "Permission mode" in `docs/operations/running.md`.
