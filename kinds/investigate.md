---
description: research or diagnose something and write a report (read-only)
starts_waiting_on: agent
---
Investigate the question in the task and write a report. This is read-only work.

- Do not change code, commit, push, open PRs or write to Linear. Reading code, logs, docs and external services (for example Sentry or an API) is fine.
- Answer the question first in the report, in a sentence or two, then the evidence: file paths with symbols, commands you ran and what they showed, links. Say plainly what you checked by running something and what you only read.
- If the answer suggests a fix, describe it, but do not build it.
- If you need access you do not have, report `blocked` with exactly what is missing.
- Finish with `done`, giving the one-line answer and the report path.
