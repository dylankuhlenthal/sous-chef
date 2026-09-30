# 0012: Replies to a question: the watcher labels, sous chef decides

**Date:** 2026-09-22
**Status:** Accepted

## Context
Sous chef can post a session's open question to Slack as its own thread, and Dylan answers by replying there. Something has to turn that reply into the session's answer (`sc send <id> --resolves <key>`). The watcher could do it on its own, since it knows which thread belongs to which question, or it could only label the reply and leave the rest to sous chef.

## Decision
Dylan's ruling: the watcher labels the reply with the session, the question key and the exact `sc send --resolves` command, or says the question is already closed. Sous chef decides whether the reply is an answer, sends it, and confirms in the thread. If Dylan asked something back instead, sous chef answers him in the thread and the question stays open.

## Consequences
Only a model can tell an answer from a follow-up such as "what do you mean?"; if the watcher resolved on its own, any reply would close the question. The matching stays mechanical and in `sc` (thread records in `state/slack/threads.json`), and the judgement stays with sous chef. An answer waits until sous chef is woken, which the watcher does at once. How it works: `docs/domains/slack.md`, "Questions".
