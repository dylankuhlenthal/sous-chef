"""Messages from sous chef to a session: state/sessions/<id>/inbox/.

Each message is one JSON file, <seq>.json, written atomically. The session
acknowledges a message by running `sc inbox ack <seq>`, which moves the file
into inbox/handled/. Sequence numbers are never reused, because allocation
looks at both the inbox and handled/.
"""
import os

from . import records, util


def inbox_dir(sid: str):
    return records.session_dir(sid) / "inbox"


def handled_dir(sid: str):
    return inbox_dir(sid) / "handled"


def _seqs(path) -> list:
    if not path.is_dir():
        return []
    return [int(p.stem) for p in path.glob("*.json") if p.stem.isdigit()]


def write(sid: str, text: str, sender: str = "sous chef", resolves: str = None) -> dict:
    with util.locked(inbox_dir(sid) / ".seq.lock"):
        seq = max(_seqs(inbox_dir(sid)) + _seqs(handled_dir(sid)) + [0]) + 1
        msg = {"seq": seq, "ts": util.now(), "from": sender, "text": text}
        if resolves:
            msg["resolves"] = resolves
        util.write_json(inbox_dir(sid) / f"{seq:04d}.json", msg)
    return msg


def unhandled(sid: str) -> list:
    d = inbox_dir(sid)
    if not d.is_dir():
        return []
    msgs = [util.read_json(p) for p in sorted(d.glob("*.json"))]
    return [m for m in msgs if m]


def ack(sid: str, seq: int) -> None:
    src = inbox_dir(sid) / f"{seq:04d}.json"
    if not src.is_file():
        if (handled_dir(sid) / src.name).is_file():
            return
        raise util.SCError(f"no unhandled message {seq} in the inbox of {sid}")
    handled_dir(sid).mkdir(parents=True, exist_ok=True)
    os.replace(src, handled_dir(sid) / src.name)
