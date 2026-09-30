"""A fake of sous chef's messaging relay, for the tests: the relay's routes and answers, in memory.

It follows the relay's contract (`sous-chef-messaging-relay/docs/architecture.md`):
the bearer key in the Authorization header, the same 401 for any bad key, the same 404
for anything sous chef may not read or post to, 502 with Slack's error code, and the
neutral envelope. It runs on 127.0.0.1 in a thread of the test process, so the `sc`
subprocesses the tests start can reach it. Python standard library only.
"""
import json
import threading
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

KEY = "scmr_0123456789abcdef0123456789abcdef_testsecret"
ALEX = "U0ALEX"
BOT = "U0BOTSC"
DM = "D0DM"


class FakeRelay:
    def __init__(self):
        self.queue = []          # envelopes waiting, oldest first
        self.grants = set()      # (conversation_id, thread ts) Alex tagged the bot into
        self.top_level = set()   # (conversation_id, ts) of Alex's top-level mentions
        self.history = {}        # (conversation_id, parent ts) -> [envelope] for thread reads
        self.before_msgs = {}    # (conversation_id, ts) -> [envelope] for reads before a mention
        self.posts = []          # every accepted POST /v1/messages body, with the answer
        self.requests = []       # (method, path with query, Authorization header)
        self.acked = []
        self.slack_error = None  # set to e.g. "not_in_channel" to make sends answer 502
        self._next_id = 100
        self._next_ts = 1790000000.000100
        relay = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def _send(self, code, body):
                raw = json.dumps(body).encode()
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            def _handle(self, method):
                auth = self.headers.get("Authorization")
                relay.requests.append((method, self.path, auth))
                url = urllib.parse.urlparse(self.path)
                query = dict(urllib.parse.parse_qsl(url.query))
                if url.path == "/healthz" and method == "GET":
                    return self._send(200, {"ok": True})
                if not url.path.startswith("/v1/"):
                    return self._send(404, {"error": "not_found"})
                if auth != f"Bearer {KEY}":
                    return self._send(401, {"error": "unauthorized"})
                length = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(length) or b"{}") if length else {}
                return self._send(*relay.route(method, url.path, query, body))

            def do_GET(self):
                self._handle("GET")

            def do_POST(self):
                self._handle("POST")

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def start(self):
        self.thread.start()
        return self

    def stop(self):
        self.server.shutdown()
        self.server.server_close()

    # --- what the real relay does ------------------------------------------------

    def route(self, method, path, query, body):
        if path == "/v1/inbox" and method == "GET":
            return 200, {"messages": list(self.queue)}
        if path == "/v1/inbox/ack" and method == "POST":
            ids = set(body.get("ids") or [])
            before = len(self.queue)
            self.acked += sorted(ids)
            self.queue = [m for m in self.queue if m["id"] not in ids]
            return 200, {"acknowledged": before - len(self.queue)}
        parts = path.split("/")
        if len(parts) == 5 and parts[2] == "conversations" and parts[4] == "messages" and method == "GET":
            conv = parts[3]
            if "parent_id" in query:
                key = (conv, query["parent_id"])
                if conv != DM and key not in self.grants:
                    return 404, {"error": "not_found"}
                return 200, {"messages": self.history.get(key, [])}
            key = (conv, query.get("before"))
            if conv != DM and key not in self.top_level:
                return 404, {"error": "not_found"}
            return 200, {"messages": self.before_msgs.get(key, [])[-int(query.get("limit", 10)):]}
        if path == "/v1/messages" and method == "POST":
            conv, parent = body.get("conversation_id"), body.get("parent_id")
            if not (body.get("text") or "").strip():
                return 400, {"error": "bad_request", "message": "text must be a non-empty string"}
            if conv not in (None, DM) and (conv, parent) not in self.grants:
                return 404, {"error": "not_found"}
            if self.slack_error:
                return 502, {"error": "transport_error", "code": self.slack_error}
            answer = {"conversation_id": conv or DM, "message_id": self._ts(), "parent_id": parent}
            self.posts.append({**body, "answer": answer})
            return 200, answer
        return 404, {"error": "not_found"}

    def _ts(self):
        self._next_ts += 1
        return f"{self._next_ts:.6f}"

    # --- helpers for tests -------------------------------------------------------

    def envelope(self, text, conversation_id=DM, parent_id=None, author=ALEX, event_type="message",
                 delivered_at="2027-01-15T08:00:00.000Z", message_id=None, channel_type=None):
        """Queue a message the way the relay would deliver it, and return the envelope."""
        self._next_id += 1
        ts = message_id or self._ts()
        event = {"type": event_type, "user": author, "text": text, "ts": ts, "channel": conversation_id,
                 "channel_type": channel_type or ("im" if conversation_id.startswith("D") else "channel")}
        if parent_id:
            event["thread_ts"] = parent_id
        env = {"id": str(self._next_id), "source": "slack", "conversation_id": conversation_id,
               "parent_id": parent_id, "message_id": ts, "author": {"id": author}, "text": text,
               "delivered_at": delivered_at,
               "payload": {"type": "event_callback", "event": event,
                           "authorizations": [{"user_id": BOT, "is_bot": True}]}}
        self.queue.append(env)
        if event_type == "app_mention":
            self.grants.add((conversation_id, parent_id or ts))
            if not parent_id:
                self.top_level.add((conversation_id, ts))
        return env
