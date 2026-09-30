# 0017: The watcher resumes sessions that stop while idle

**Date:** 2026-09-30
**Status:** Accepted

## Context
Background sessions waiting on Dylan were stopping by themselves. One shape session (Shape 2 of 3, decoupling kinds from skills) went `gone` 62 minutes after its last activity three times in a row, while the Mac stayed awake. The likely cause is Claude Code stopping background sessions that stay idle for about an hour: a one-hour constant sits next to its background-session code. That was seen in the code, not confirmed by running it. Each time, sous chef had to notice the `gone` event, run `sc resume`, and tell the session to restart its shape-gui page server, because the page server targets the session's old process. A plain `sc resume` also records the session as waiting on the agent, so the watcher then reported its hour-old turn as a silent stop.

## Decision
Dylan asked for sous chef's proposal. When the watcher finds a session gone that sous chef did not stop, and the session was waiting on Dylan, sous chef or something external, the watcher resumes it itself through `ops.resume` (the same code as `sc resume`). It appends `auto-resumed`, which does not wake sous chef and leaves who the session is waiting on unchanged, and sends the session an inbox message saying it was resumed after stopping while idle, so it restarts anything tied to its old process. Sous chef is woken only when the watcher does not resume the session: the resume failed, or a limit applied. Then the watcher appends `gone` as before, saying why.

Two limits keep a session that keeps stopping from being resumed in a loop: at most 24 automatic resumes per session in any 24 hours (`SC_AUTO_RESUME_MAX`, 0 turns this off), and none when the session stopped within 10 minutes of the last automatic resume (`SC_AUTO_RESUME_MIN_UP`).

Sessions waiting on the agent are not resumed automatically: they were working, or stopped silently in the last few minutes, so why they stopped is unexplained and sous chef should look. Finished sessions (waiting on nobody) and sessions sous chef stopped are not resumed either. Sessions waiting on something external (`paused`) are included, although the request named only Dylan and sous chef: they are idle for the same reason, their work is unfinished, and the process that would have been woken is gone.

## Consequences
Sous chef no longer handles idle stops by hand, and a session waiting on Dylan overnight costs a short turn each hour it is resumed (reading its inbox, restarting a page server). After a reboot, every session that was waiting on someone else is resumed by the watcher when it starts. A session that stops for another reason while waiting on someone, for example one that crashes, is resumed too; the 10-minute limit stops that from repeating, and the 24-hour cap bounds the rest. If Claude Code's idle stop turns out to be a setting that can be changed, turning it off would make this unnecessary. How it works: `docs/domains/watcher.md`, check 1.
