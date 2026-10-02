// The HTTP client for sous chef's messaging relay, the service that stands between Slack and sous chef.
//
// The relay (a separate service, not published; its own `docs/architecture.md` is the
// contract) queues the Slack messages meant for the owner and posts sous chef's messages as
// its bot. This module is the only code that talks to it. It knows the relay's routes
// and its error answers, and nothing about sessions or the slack log (slack.ts).
//
// Every `/v1` call sends the key in the `Authorization` header, never in the URL,
// because the relay and anything in front of it (ngrok, Railway) log URLs.
//
// Plain HTTPS through Node's fetch, with a bearer key; nothing is signed.

import os from "node:os";
import { dumps, JSONDecodeError, loads } from "./pyjson.js";
import { Dict, isDict, rstrip } from "./py.js";
import { ownerName, SCError } from "./util.js";

const TIMEOUT = 10; // seconds; a watcher cycle waits at most this long on a relay that hangs

/** A relay call that failed. `status` is the HTTP status, or null when the relay was not reached. */
export class RelayError extends SCError {
  constructor(message: string, public status: number | null = null) {
    super(message);
    this.name = "RelayError";
  }
}

/** What a relay error answer means, in words sous chef can act on. */
function explain(status: number, body: Dict): string {
  if (status === 401) {
    return "the relay refused the key (401). The relay gives the same answer for a wrong, unknown or " +
      "revoked key; `sc slack setup` writes a new one into .env";
  }
  if (status === 404) {
    return "the relay answered 404: that conversation or thread does not exist, or sous chef may not " +
      "read or post there (the relay gives the same answer for both). Sous chef may use " +
      `${ownerName()}'s DM with the bot, and threads ${ownerName()} tagged it into`;
  }
  if (status === 502) return `Slack refused the call (the relay passed on Slack's error: ${String(body.code || "no code")})`;
  if (status === 400) return `the relay refused the request as malformed: ${String(body.message || pyStr(body))}`;
  return `the relay answered ${status}: ${String(body.error || (Object.keys(body).length ? pyStr(body) : "no detail"))}`;
}

/** str(dict) as Python prints it, near enough for an error message. */
function pyStr(d: Dict): string {
  return "{" + Object.entries(d).map(([k, v]) => `'${k}': ${typeof v === "string" ? `'${v}'` : dumps(v)}`).join(", ") + "}";
}

// Python's words for the errors a relay call meets, as urllib printed them.
const STRERROR: Record<string, string> = {
  ECONNREFUSED: "Connection refused",
  ECONNRESET: "Connection reset by peer",
  ETIMEDOUT: "Operation timed out",
  EHOSTUNREACH: "No route to host",
  ENETUNREACH: "Network is unreachable",
};

/** Why fetch could not reach the relay, as Python's urllib said it ("[Errno 61] Connection refused"). */
function reason(e: unknown): string {
  const err = e as Error & { cause?: Error & { code?: string } };
  if (err.name === "TimeoutError" || err.name === "AbortError") return "timed out";
  const cause = err.cause;
  if (!cause) return err.message || String(e);
  const code = cause.code ?? "";
  const errno = (os.constants.errno as Record<string, number>)[code];
  if (STRERROR[code] && errno !== undefined) return `[Errno ${errno}] ${STRERROR[code]}`;
  return cause.message || String(cause);
}

/** One relay call. Returns the decoded JSON answer, or throws RelayError saying why not. */
export async function call(url: string, key: string | null, method: string, p: string, body: Dict | null = null,
                           query: Record<string, string> | null = null): Promise<Dict> {
  let full = rstrip(url, "/") + p;
  if (query) full += "?" + new URLSearchParams(query).toString();
  const headers: Record<string, string> = { Accept: "application/json" };
  const data = body !== null ? dumps(body) : undefined;
  if (data !== undefined) headers["Content-Type"] = "application/json";
  if (key) headers.Authorization = `Bearer ${key}`;
  let resp: Response;
  let raw: string;
  try {
    resp = await fetch(full, { method, headers, body: data, signal: AbortSignal.timeout(TIMEOUT * 1000) });
    raw = await resp.text();
  } catch (e) {
    throw new RelayError(`the relay at ${url} could not be reached: ${reason(e)}`);
  }
  if (resp.status >= 400) {
    let detail: unknown;
    try {
      detail = loads(raw || "{}");
    } catch (e) {
      if (!(e instanceof JSONDecodeError)) throw e;
      detail = {};
    }
    throw new RelayError(explain(resp.status, isDict(detail) ? detail : {}), resp.status);
  }
  if (!raw) return {};
  try {
    return loads(raw) as Dict;
  } catch (e) {
    if (!(e instanceof JSONDecodeError)) throw e;
    throw new RelayError(`the relay at ${url} answered with something that is not JSON`);
  }
}

function messages(answer: Dict): Dict[] {
  const m = answer.messages;
  return Array.isArray(m) && m.length ? (m as Dict[]) : [];
}

/** Throw RelayError unless the relay answers `GET /healthz` (no key needed). */
export async function health(url: string): Promise<void> {
  await call(url, null, "GET", "/healthz");
}

/** Every message queued for the key's user, oldest first. Reading deletes nothing. */
export async function inbox(url: string, key: string): Promise<Dict[]> {
  return messages(await call(url, key, "GET", "/v1/inbox"));
}

/** Tell the relay these messages are safely on disk. The relay deletes them. */
export async function ack(url: string, key: string, ids: unknown[]): Promise<number> {
  if (!ids.length) return 0;
  const answer = await call(url, key, "POST", "/v1/inbox/ack", { ids: ids.map((i) => String(i)) });
  return (answer.acknowledged as number) ?? 0;
}

/** A thread's root and replies, if sous chef may read it. */
export async function thread(url: string, key: string, conversationId: string, parentId: string): Promise<Dict[]> {
  return messages(await call(url, key, "GET", `/v1/conversations/${quote(conversationId)}/messages`, null,
    { parent_id: parentId }));
}

/** Up to `limit` messages before a message the owner tagged the bot in at top level. */
export async function before(url: string, key: string, conversationId: string, messageId: string, limit: number):
  Promise<Dict[]> {
  return messages(await call(url, key, "GET", `/v1/conversations/${quote(conversationId)}/messages`, null,
    { before: messageId, limit: String(limit) }));
}

/** Post as the bot. No conversation: the owner's DM with the bot. Returns conversation_id, message_id, parent_id. */
export async function post(url: string, key: string, text: string, conversationId: string | null = null,
                           parentId: string | null = null): Promise<Dict> {
  const body: Dict = { text };
  if (conversationId) body.conversation_id = conversationId;
  if (parentId) body.parent_id = parentId;
  return call(url, key, "POST", "/v1/messages", body);
}

/** urllib.parse.quote: everything but letters, digits, "_.-~" and "/" percent-encoded. */
function quote(text: string): string {
  return encodeURIComponent(text).replace(/%2F/gi, "/").replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}
