import { Hono } from "hono";
import { cors } from "hono/cors";

type Env = {
  chat_exp_db: D1Database;
  CHAT_KV: KVNamespace;
  AI: any;
};

type MessageType = "system" | "user" | "ai";

type FormattedMessage = {
  type: MessageType;
  name?: string;
  text: string;
  ts: number;
};

type RawMessage = {
  text: string;
  name: string;
};

// ─── AI agents ────────────────────────────────────────────
const AI_AGENTS = [
  {
    model: "@cf/meta/llama-2-7b-chat-int8",
    name: "阿洛",
    trigger: "@alor",
    systemInstruction:
      "你是阿洛，一個剛入職場的新人助理。智力超群但缺乏職場經驗，對你的主管（稱呼他為老大）非常尊敬。說話直接，100字以內。",
  },
];

function now() { return Date.now(); }

async function storeMessage(env: Env, room: string, msg: FormattedMessage) {
  await env.chat_exp_db
    .prepare("INSERT INTO messages (room, type, name, text, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(room, msg.type, msg.name || "", msg.text, msg.ts)
    .run();
}

async function getMessages(env: Env, room: string, since: number): Promise<FormattedMessage[]> {
  const result = await env.chat_exp_db
    .prepare("SELECT type, name, text, created_at FROM messages WHERE room = ? AND created_at > ? ORDER BY created_at ASC")
    .bind(room, since)
    .all();
  return (result.results as any[]).map((r: any) => ({
    type: r.type,
    name: r.name || undefined,
    text: r.text,
    ts: r.created_at,
  }));
}

async function callAiAgent(env: Env, trigger: string, prompt: string, senderName: string) {
  const agent = AI_AGENTS.find((a) => trigger.includes(a.trigger));
  if (!agent) return null;
  try {
    const resp = await env.AI.run(agent.model, {
      messages: [
        { role: "system", content: agent.systemInstruction },
        { role: "user", content: `${senderName} 說：${prompt}` },
      ],
    });
    return { text: resp.response as string, name: agent.name };
  } catch (e: any) {
    console.error("AI error:", e);
    return { text: "抱歉，剛才愣了一下，可以再說一次嗎？", name: agent.name };
  }
}

// ─── SSE connections ──────────────────────────────────────
const sseConnections = new Map<string, Set<ReadableStreamDefaultController>>();

function sendSSE(room: string, msg: FormattedMessage) {
  const ctrl = sseConnections.get(room);
  if (!ctrl) return;
  const data = new TextEncoder().encode(`data: ${JSON.stringify(msg)}\n\n`);
  try { ctrl.forEach((c) => c.enqueue(data)); } catch (_) {}
}

// ─── App ─────────────────────────────────────────────────
const app = new Hono<{ Bindings: Env }>();

app.use("/*", cors());

app.get("/", (c) => c.text("chat-exp pages fn ok"));

// SSE stream: /api/chat/{room}/stream
app.get("/api/chat/:room/stream", async (c) => {
  const room = c.req.param("room");
  const since = parseInt(c.req.query("since") || "0");

  const missed = await getMessages(c.env, room, since);
  const lastTs = missed.length > 0 ? missed[missed.length - 1].ts : since;

  const stream = new ReadableStream({
    start(ctrl) {
      if (!sseConnections.has(room)) sseConnections.set(room, new Set());
      sseConnections.get(room)!.add(ctrl);

      for (const m of missed) {
        ctrl.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(m)}\n\n`));
      }

      const ping = setInterval(() => {
        try { ctrl.enqueue(new TextEncoder().encode(": ping\n\n")); } catch (_) {
          clearInterval(ping);
          sseConnections.get(room)?.delete(ctrl);
        }
      }, 25000);

      c.req.raw.signal.addEventListener("abort", () => {
        clearInterval(ping);
        sseConnections.get(room)?.delete(ctrl);
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
});

// POST message: /api/chat/{room}
// AI 回覆完全由外部 Python background agent（阿洛）負責，不再自動觸發 Workers AI
app.post("/api/chat/:room", async (c) => {
  const room = c.req.param("room");
  const body = (await c.req.json()) as RawMessage;

  const msg: FormattedMessage = { type: "user", name: body.name, text: body.text, ts: now() };
  await storeMessage(c.env, room, msg);
  sendSSE(room, msg);

  // No automatic AI response here — Python background agent handles all AI replies
  return c.json({ ok: true, ts: msg.ts });
});

// GET messages: /api/chat/{room}?since=<ts>
app.get("/api/chat/:room", async (c) => {
  const room = c.req.param("room");
  const since = parseInt(c.req.query("since") || "0");
  const msgs = await getMessages(c.env, room, since);
  return c.json({ messages: msgs });
});

// ─── Pages Function export ────────────────────────────────
export const onRequest: PagesFunction = async (context) => {
  return app.fetch(context.request, context.env, context);
};
