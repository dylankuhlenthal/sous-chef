"""Post a wake-up message into a running Claude Code session on this machine.

Adapted from ~/msg-agent. A running session listens on a Unix socket at
/tmp/cc-socks/<pid>.sock (fallback /tmp/cc-socks-<uid>/) and accepts one JSON
line per message. An idle session starts a new turn; a busy one picks the
message up at its next tool call.

Shortcut (PoC): the socket path is inferred from observed behaviour, not from a
documented source. Every failure raises WakeError with the session and path, so
a changed layout shows up as a loud error, and messages are never lost because
the durable copy is the file on disk (events log or inbox), not this socket.
"""
import json
import os
import socket


class WakeError(Exception):
    pass


def socket_dirs():
    return ("/tmp/cc-socks", f"/tmp/cc-socks-{os.getuid()}")


def socket_path(pid: int):
    for d in socket_dirs():
        p = f"{d}/{pid}.sock"
        if os.path.exists(p):
            return p
    return None


def post(pid, text: str) -> None:
    if not pid:
        raise WakeError("session has no pid (not running)")
    path = socket_path(pid)
    if not path:
        raise WakeError(f"no socket for pid {pid} in {' or '.join(socket_dirs())}")
    line = json.dumps({"type": "user", "message": {"role": "user", "content": text}}) + "\n"
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.settimeout(5)
    try:
        s.connect(path)
        s.sendall(line.encode())
    except OSError as e:
        raise WakeError(f"could not post to {path}: {e}") from e
    finally:
        s.close()
