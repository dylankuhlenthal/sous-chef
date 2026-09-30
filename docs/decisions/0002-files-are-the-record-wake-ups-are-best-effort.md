# 0002: Files are the record; wake-ups are best effort

**Date:** 2026-09-17
**Status:** Accepted

## Context
Claude Code can wake a session with a message, but delivery is not confirmed, a stopped session cannot receive one, and a message into a busy session waits for its next tool call. Messages sent only this way could be lost.

## Decision
Every event and every message is written to a file first (the session's `events.jsonl` or its `inbox/`). The wake-up message only tells the other side to read. Acknowledgement is explicit (`sc events ack`, `sc inbox ack`), and the watcher re-sends wake-ups for anything not acknowledged.

## Consequences
A lost wake-up delays attention but loses nothing. Stopped sessions find their messages when resumed. Readers can see the same event twice (after a crash between reading and acknowledging), so handling must tolerate repeats.
