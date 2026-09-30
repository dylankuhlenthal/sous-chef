"""The HTTP client for sous chef's messaging relay, the service that stands between Slack and sous chef.

The relay (its own repo, `sous-chef-messaging-relay`; its `docs/architecture.md` is the
contract) queues the Slack messages meant for the owner and posts sous chef's messages as
its bot. This module is the only code that talks to it. It knows the relay's routes
and its error answers, and nothing about sessions or the slack log (slack.py).

Every `/v1` call sends the key in the `Authorization` header, never in the URL,
because the relay and anything in front of it (ngrok, Railway) log URLs.

Python standard library only (`urllib`), like the rest of sc.
"""
import json
import socket
import urllib.error
import urllib.parse
import urllib.request

from . import util

TIMEOUT = 10  # seconds; a watcher cycle waits at most this long on a relay that hangs


class RelayError(util.SCError):
    """A relay call that failed. `status` is the HTTP status, or None when the relay was not reached."""

    def __init__(self, message: str, status: int = None):
        super().__init__(message)
        self.status = status


def _explain(status: int, body: dict) -> str:
    """What a relay error answer means, in words sous chef can act on."""
    if status == 401:
        return ("the relay refused the key (401). The relay gives the same answer for a wrong, unknown or "
                "revoked key; `sc slack setup` writes a new one into .env")
    if status == 404:
        return ("the relay answered 404: that conversation or thread does not exist, or sous chef may not "
                "read or post there (the relay gives the same answer for both). Sous chef may use "
                f"{util.owner_name()}'s DM with the bot, and threads {util.owner_name()} tagged it into")
    if status == 502:
        return f"Slack refused the call (the relay passed on Slack's error: {body.get('code') or 'no code'})"
    if status == 400:
        return f"the relay refused the request as malformed: {body.get('message') or body}"
    return f"the relay answered {status}: {body.get('error') or body or 'no detail'}"


def call(url: str, key: str, method: str, path: str, body: dict = None, query: dict = None):
    """One relay call. Returns the decoded JSON answer, or raises RelayError saying why not."""
    full = url.rstrip("/") + path
    if query:
        full += "?" + urllib.parse.urlencode(query)
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(full, data=data, method=method)
    req.add_header("Accept", "application/json")
    if data is not None:
        req.add_header("Content-Type", "application/json")
    if key:
        req.add_header("Authorization", f"Bearer {key}")
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            raw = resp.read()
    except urllib.error.HTTPError as e:
        try:
            detail = json.loads(e.read() or b"{}")
        except ValueError:
            detail = {}
        raise RelayError(_explain(e.code, detail if isinstance(detail, dict) else {}), e.code) from None
    except (urllib.error.URLError, socket.timeout, TimeoutError, ConnectionError, OSError) as e:
        reason = getattr(e, "reason", None) or e
        raise RelayError(f"the relay at {url} could not be reached: {reason}") from None
    if not raw:
        return {}
    try:
        return json.loads(raw)
    except ValueError:
        raise RelayError(f"the relay at {url} answered with something that is not JSON") from None


def health(url: str) -> None:
    """Raise RelayError unless the relay answers `GET /healthz` (no key needed)."""
    call(url, None, "GET", "/healthz")


def inbox(url: str, key: str) -> list:
    """Every message queued for the key's user, oldest first. Reading deletes nothing."""
    return call(url, key, "GET", "/v1/inbox").get("messages") or []


def ack(url: str, key: str, ids: list) -> int:
    """Tell the relay these messages are safely on disk. The relay deletes them."""
    if not ids:
        return 0
    return call(url, key, "POST", "/v1/inbox/ack", {"ids": [str(i) for i in ids]}).get("acknowledged", 0)


def thread(url: str, key: str, conversation_id: str, parent_id: str) -> list:
    """A thread's root and replies, if sous chef may read it."""
    return call(url, key, "GET", f"/v1/conversations/{urllib.parse.quote(conversation_id)}/messages",
                query={"parent_id": parent_id}).get("messages") or []


def before(url: str, key: str, conversation_id: str, message_id: str, limit: int) -> list:
    """Up to `limit` messages before a message the owner tagged the bot in at top level."""
    return call(url, key, "GET", f"/v1/conversations/{urllib.parse.quote(conversation_id)}/messages",
                query={"before": message_id, "limit": str(limit)}).get("messages") or []


def post(url: str, key: str, text: str, conversation_id: str = None, parent_id: str = None) -> dict:
    """Post as the bot. No conversation: the owner's DM with the bot. Returns conversation_id, message_id, parent_id."""
    body = {"text": text}
    if conversation_id:
        body["conversation_id"] = conversation_id
    if parent_id:
        body["parent_id"] = parent_id
    return call(url, key, "POST", "/v1/messages", body)
