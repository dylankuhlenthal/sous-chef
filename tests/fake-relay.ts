// A fake of sous chef's messaging relay, for the tests: the relay's routes and answers, in memory.
//
// It follows the relay's contract (`sous-chef-messaging-relay/docs/architecture.md`): the
// bearer key in the Authorization header, the same 401 for any bad key, the same 404 for
// anything sous chef may not read or post to, 502 with Slack's error code, and the neutral
// envelope. It listens on 127.0.0.1 (a free port) in the test process, so the `sc`
// subprocesses the tests start can reach it; they must be started asynchronously
// (tests/helpers.ts), or the relay could never answer.
import http from "node:http";
import type { AddressInfo } from "node:net";

export const KEY = "scmr_0123456789abcdef0123456789abcdef_testsecret";
export const ALEX = "U0ALEX";
export const BOT = "U0BOTSC";
export const DM = "D0DM";

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

/** The key for a pair (conversation id, message ts) in grants, topLevel, history and beforeMsgs. */
export function pair(conversation: string | null | undefined, ts: string | null | undefined): string {
  return JSON.stringify([conversation ?? null, ts ?? null]);
}

export interface EnvelopeOptions {
  conversationId?: string;
  parentId?: string | null;
  author?: string;
  eventType?: string;
  deliveredAt?: string;
  messageId?: string | null;
  channelType?: string | null;
}

export class FakeRelay {
  queue: Json[] = [];                     // envelopes waiting, oldest first
  grants = new Set<string>();             // pair(conversation_id, thread ts) Alex tagged the bot into
  topLevel = new Set<string>();           // pair(conversation_id, ts) of Alex's top-level mentions
  history = new Map<string, Json[]>();    // pair(conversation_id, parent ts) -> envelopes for thread reads
  beforeMsgs = new Map<string, Json[]>(); // pair(conversation_id, ts) -> envelopes for reads before a mention
  posts: Json[] = [];                     // every accepted POST /v1/messages body, with the answer
  requests: [string, string, string | null][] = []; // (method, path with query, Authorization header)
  acked: string[] = [];
  slackError: string | null = null;       // set to e.g. "not_in_channel" to make sends answer 502
  url = "";
  private nextId = 100;
  private nextTs = 0; // seconds after 1790000000, so ts are 1790000001.000100, 1790000002.000100, ...
  private server: http.Server;

  constructor() {
    this.server = http.createServer((req, res) => this.handle(req, res));
  }

  async start(): Promise<this> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private send(res: http.ServerResponse, code: number, body: Json): void {
    const raw = Buffer.from(JSON.stringify(body));
    // Connection: close, as the Python relay's HTTP/1.0 server did: no connection is kept open.
    res.writeHead(code, { "Content-Type": "application/json", "Content-Length": raw.length, Connection: "close" });
    res.end(raw);
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const method = req.method ?? "";
      const auth = req.headers.authorization ?? null;
      this.requests.push([method, req.url ?? "", auth]);
      const url = new URL(req.url ?? "/", "http://relay");
      const query: Record<string, string> = {};
      for (const [k, v] of url.searchParams) if (v !== "") query[k] = v; // parse_qsl drops blank values
      if (url.pathname === "/healthz" && method === "GET") return this.send(res, 200, { ok: true });
      if (!url.pathname.startsWith("/v1/")) return this.send(res, 404, { error: "not_found" });
      if (auth !== `Bearer ${KEY}`) return this.send(res, 401, { error: "unauthorized" });
      const raw = Buffer.concat(chunks);
      const length = parseInt(req.headers["content-length"] ?? "0", 10) || 0;
      const body = length && raw.length ? JSON.parse(raw.toString("utf8")) : {};
      const [code, answer] = this.route(method, url.pathname, query, body);
      return this.send(res, code, answer);
    });
  }

  // --- what the real relay does ------------------------------------------------

  route(method: string, urlPath: string, query: Record<string, string>, body: Json): [number, Json] {
    if (urlPath === "/v1/inbox" && method === "GET") return [200, { messages: [...this.queue] }];
    if (urlPath === "/v1/inbox/ack" && method === "POST") {
      const ids = new Set<string>(body.ids ?? []);
      const before = this.queue.length;
      this.acked.push(...[...ids].sort());
      this.queue = this.queue.filter((m) => !ids.has(m.id));
      return [200, { acknowledged: before - this.queue.length }];
    }
    const parts = urlPath.split("/");
    if (parts.length === 5 && parts[2] === "conversations" && parts[4] === "messages" && method === "GET") {
      const conv = parts[3]!;
      if ("parent_id" in query) {
        const key = pair(conv, query.parent_id);
        if (conv !== DM && !this.grants.has(key)) return [404, { error: "not_found" }];
        return [200, { messages: this.history.get(key) ?? [] }];
      }
      const key = pair(conv, query.before);
      if (conv !== DM && !this.topLevel.has(key)) return [404, { error: "not_found" }];
      const limit = parseInt(query.limit ?? "10", 10);
      const msgs = this.beforeMsgs.get(key) ?? [];
      return [200, { messages: limit === 0 ? [...msgs] : msgs.slice(-limit) }];
    }
    if (urlPath === "/v1/messages" && method === "POST") {
      const conv = body.conversation_id ?? null;
      const parent = body.parent_id ?? null;
      if (!String(body.text || "").trim()) return [400, { error: "bad_request", message: "text must be a non-empty string" }];
      if (conv !== null && conv !== DM && !this.grants.has(pair(conv, parent))) return [404, { error: "not_found" }];
      if (this.slackError) return [502, { error: "transport_error", code: this.slackError }];
      const answer = { conversation_id: conv ?? DM, message_id: this.ts(), parent_id: parent };
      this.posts.push({ ...body, answer });
      return [200, answer];
    }
    return [404, { error: "not_found" }];
  }

  private ts(): string {
    this.nextTs += 1;
    return `${1790000000 + this.nextTs}.000100`;
  }

  // --- helpers for tests -------------------------------------------------------

  /** Queue a message the way the relay would deliver it, and return the envelope. */
  envelope(text: string, o: EnvelopeOptions = {}): Json {
    const conversationId = o.conversationId ?? DM;
    const parentId = o.parentId ?? null;
    const author = o.author ?? ALEX;
    const eventType = o.eventType ?? "message";
    this.nextId += 1;
    const ts = o.messageId || this.ts();
    const event: Json = { type: eventType, user: author, text, ts, channel: conversationId,
      channel_type: o.channelType || (conversationId.startsWith("D") ? "im" : "channel") };
    if (parentId) event.thread_ts = parentId;
    const env = { id: String(this.nextId), source: "slack", conversation_id: conversationId,
      parent_id: parentId, message_id: ts, author: { id: author }, text,
      delivered_at: o.deliveredAt ?? "2027-01-15T08:00:00.000Z",
      payload: { type: "event_callback", event, authorizations: [{ user_id: BOT, is_bot: true }] } };
    this.queue.push(env);
    if (eventType === "app_mention") {
      this.grants.add(pair(conversationId, parentId || ts));
      if (!parentId) this.topLevel.add(pair(conversationId, ts));
    }
    return env;
  }
}
