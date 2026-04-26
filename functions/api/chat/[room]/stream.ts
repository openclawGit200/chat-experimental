import { Hono } from "hono";
import { cors } from "hono/cors";

type Env = {
  chat_exp_db: D1Database;
  CHAT_KV: KVNamespace;
  AI: any;
};

type MessageType = "system" | "user" | "ai";
type FormattedMessage = { type: MessageType; name?: string; text: string; ts: number };
type RawMessage = { text: string; name: string };

function now() { return Date.now(); }

async function storeMessage(env: Env, room: string, msg: FormattedMessage) {
  await env.chat_exp_db
    .prepare("INSERT INTO messages (room, type, name, text, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(room, msg.type, msg.name || "", msg.text, msg.ts).run();
}

async function getMessages(env: Env, room: string, since: number): Promise<FormattedMessage[]> {
  const r = await env.chat_exp_db
    .prepare("SELECT type, name, text, created_at FROM messages WHERE room = ? AND created_at > ? ORDER BY created_at ASC")
    .bind(room, since).all();
  return (r.results as any[]).map((x: any) => ({ type: x.type, name: x.name || undefined, text: x.text, ts: x.created_at }));
}

const sseMap = new Map<string, Set<ReadableStreamDefaultController>>();

function broadcast(room: string, msg: FormattedMessage) {
  const ctrls = sseMap.get(room);
  if (!ctrls) return;
  const data = new TextEncoder().encode(`data: ${JSON.stringify(msg)}\n\n`);
  ctrls.forEach((c) => { try { c.enqueue(data); } catch (_) {} });
}

// ── GET /api/chat/:room/stream ──────────────────────────
export const onRequestGet: PagesFunction<Env> = async (context) => {
  const { env, params, request } = context;
  const room = params.room || "general";
  const url = new URL(request.url);
  const since = parseInt(url.searchParams.get("since") || "0");

  const missed = await getMessages(env, room, since);

  const stream = new ReadableStream({
    start(ctrl) {
      if (!sseMap.has(room)) sseMap.set(room, new Set());
      sseMap.get(room)!.add(ctrl);
      for (const m of missed) ctrl.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(m)}\n\n`));
      const ping = setInterval(() => {
        try { ctrl.enqueue(new TextEncoder().encode(": ping\n\n")); } catch (_) { clearInterval(ping); sseMap.get(room)?.delete(ctrl); }
      }, 25000);
      request.signal.addEventListener("abort", () => { clearInterval(ping); sseMap.get(room)?.delete(ctrl); });
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no" },
  });
};

// ── POST /api/chat/:room ───────────────────────────────
// AI 回覆完全由外部 Python background agent（阿洛）負責，不再自動觸發 Workers AI
export const onRequestPost: PagesFunction<Env> = async (context) => {
  const { env, params, request } = context;
  const room = params.room || "general";
  const body = await request.json() as RawMessage;

  const msg: FormattedMessage = { type: "user", name: body.name, text: body.text, ts: now() };
  await storeMessage(env, room, msg);
  broadcast(room, msg);

  // No automatic AI response here — Python background agent handles all AI replies
  return new Response(JSON.stringify({ ok: true, ts: msg.ts }), { headers: { "Content-Type": "application/json" } });
};
