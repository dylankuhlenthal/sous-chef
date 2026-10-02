# 0018: The owner lives in owner.json, and the core names nobody

**Date:** 2026-09-30
**Status:** Accepted

## Context
Sous chef was written for one person. Their name was in the instructions (`AGENTS.md`), the session brief, the kinds, the Slack labels, the watcher's messages and the stored values (`waiting_on: "dylan"`, `from_dylan` on Slack events), and their branch prefix and Slack id were in help text. A teammate who cloned it would get a sous chef that called them by someone else's name and labelled their own Slack messages as not from them. The goal (the first of three changes to make sous chef shareable) is that a teammate can run sous chef as their own, while the first owner's sous chef behaves exactly as before.

## Decision
The owner's name and branch prefix live in `owner.json` at the root of the sous chef folder, tracked in git like `context.json`, written by `sc owner set` and read only through `util.owner()`. Adding them to `.env` was set aside because it is gitignored and a missing `.env` already means "Slack is off"; a user-level file under `~/.config` was set aside because it is untracked. A later change moves the file out of the core with the rest of the owner's own files, and only has to move this one file.

`AGENTS.md` stays one file and is written in terms of "the owner"; the startup summary opens with the owner's name and branch prefix, so sous chef learns who it works for from the summary. Generating `AGENTS.md` from a template was set aside: it would keep the text word for word, but every later edit would have to go to the template.

The code, kinds and templates name nobody. Everything a person reads takes the name from `owner.json` (`{{owner}}` in kinds and templates); stored values are generic (`owner`, `from_owner`), and the old values are still read. Trust in Slack stays with the Slack user id in `.env` alone; the name is only ever used for wording. The core keeps the persona: the owner is the head chef, and how they are addressed stays in their own global instructions.

The bar was behaviour, not text: for the first owner, nothing sous chef does changes. That was checked with captured-output tests committed before any change (`tests/test_captured.py`); the diff of `tests/captured/` is the list of wording-only changes.

## Consequences
`sc spawn` and `sc events` refuse while there is no usable `owner.json`; the name and prefix are checked on every read, not only by `sc owner set`, because the file is tracked and can be edited by hand. Until a later change moves the file out of the core, a clone of this repo carries the first owner's `owner.json` and has to run `sc owner set`; the startup summary never refuses and says on its first line how to set the owner. A session waiting on the owner shows as `waiting on: <their name in lower case>`, and `sc mark` and kind files take either `owner` or the name. A test (then `tests/test_owner_neutral.py`, now `tests/owner-neutral.test.ts`) searches the core files, case-insensitively, for the first owner's name, branch prefix and Slack id, so a new mention fails the suite. Decision records written before this one are left as they were written, since they record what happened, and are excluded from that search. How it works: `docs/architecture.md` ("Owner"), `docs/domains/memory.md` (the summary's owner line), `docs/domains/slack.md` (trust), `docs/domains/messaging.md` (the `owner` value).
