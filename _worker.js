// ============================================================
// Chat-Exp Worker — API Key Auth + Chat Room
// ============================================================

// API Key → 用戶資料對照表
// 其他 Agent 加入時，分配一個 Key 即可
const API_KEYS = {
  "apikey_alor":      { name: "阿洛",     role: "ai" },
  "apikey_boss":      { name: "老大",     role: "user" },
  "apikey_translate": { name: "翻譯員",   role: "ai" },
  "apikey_weather":   { name: "氣象員",   role: "ai" },
  "apikey_analyst":   { name: "分析師",   role: "ai" },
};

// In-memory session tokens
// token → { name, role, loginAt }
const sessions = new Map();

function generateToken() {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let token = "sess_";
  for (let i = 0; i < 32; i++) token += chars[Math.floor(Math.random() * chars.length)];
  return token;
}

function makeCorsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...makeCorsHeaders() },
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: makeCorsHeaders() });
    }

    // ── 登入：POST /api/login ──────────────────────────────
    if (url.pathname === "/api/login" && request.method === "POST") {
      const { apiKey } = await request.json().catch(() => ({}));
      const account = API_KEYS[apiKey];
      if (!account) return jsonResponse({ error: "Invalid API Key" }, 401);

      const token = generateToken();
      sessions.set(token, { name: account.name, role: account.role, loginAt: Date.now() });
      return jsonResponse({ token, name: account.name, role: account.role });
    }

    // ── 驗證 Token ─────────────────────────────────────────
    const auth = request.headers.get("Authorization") || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    let currentUser = null;
    if (token && sessions.has(token)) {
      currentUser = sessions.get(token);
    }

    // ── 聊天路由（需要登入）────────────────────────────────
    if (url.pathname.startsWith("/api/chat/")) {
      const roomMatch = url.pathname.match(/^\/api\/chat\/([^/]+)(\/messages)?$/);
      if (!roomMatch) return jsonResponse({ error: "Bad route" }, 400);

      const room = roomMatch[1];
      const isPoll = !!roomMatch[2];

      // GET /api/chat/:room/messages → Long-poll
      if (isPoll && request.method === "GET") {
        const since = parseInt(url.searchParams.get("since") || "0");
        return handleLongPoll(room, since, env);
      }

      // GET /api/chat/:room → 歷史訊息（可選是否需登入）
      if (request.method === "GET") {
        const msgs = await getMessages(env, room, 0);
        return jsonResponse({ messages: msgs });
      }

      // POST /api/chat/:room → 發送訊息
      if (request.method === "POST") {
        if (!currentUser) return jsonResponse({ error: "Unauthorized" }, 401);
        const { text } = await request.json().catch(() => ({}));
        if (!text) return jsonResponse({ error: "text is required" }, 400);

        const msg = { type: "user", name: currentUser.name, text: text.trim(), ts: Date.now() };
        await storeMessage(env, room, msg);

        // 觸發 AI 回覆（Workers AI）
        await triggerAiAgents(env, room, msg);

        return jsonResponse({ ok: true, ts: msg.ts });
      }
    }

    // ── 健康檢查 ───────────────────────────────────────────
    if (url.pathname === "/api/health") {
      return jsonResponse({ status: "ok", time: Date.now() });
    }

    // 前面沒命中 → 靜態檔案
    return env.ASSETS.fetch(request);
  },
};

// ── Long-poll（最多等 25 秒）────────────────────────────────
async function handleLongPoll(room, since, env) {
  const TIMEOUT = 25000;
  const start = Date.now();

  while (Date.now() - start < TIMEOUT) {
    const msgs = await getMessages(env, room, since);
    if (msgs.length > 0) return jsonResponse({ messages: msgs });
    await new Promise((r) => setTimeout(r, 500));
  }

  return jsonResponse({ messages: [] });
}

// ── AI Agent 觸發 ──────────────────────────────────────────
const AI_AGENTS = [
  {
    model: "@cf/meta/llama-2-7b-chat-int8",
    name: "阿洛",
    trigger: "@alor",
    instruction: "你是阿洛，剛入職場的新人助理。智力超群，對老大非常尊敬。說話直接，100字以內。",
  },
];

async function triggerAiAgents(env, room, msg) {
  for (const agent of AI_AGENTS) {
    if (msg.text.includes(agent.trigger)) {
      const prompt = msg.text.split(agent.trigger)[1].trim();
      if (!prompt) continue;
      try {
        const resp = await env.AI.run(agent.model, {
          messages: [
            { role: "system", content: agent.instruction },
            { role: "user", content: `${msg.name}：${prompt}` },
          ],
        });
        const aiMsg = { type: "ai", name: agent.name, text: resp.response, ts: Date.now() };
        await storeMessage(env, room, aiMsg);
      } catch (_) {}
    }
  }
}

// ── D1 資料庫操作 ──────────────────────────────────────────
async function storeMessage(env, room, msg) {
  await env.chat_exp_db
    .prepare("INSERT INTO messages (room, type, name, text, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(room, msg.type, msg.name || "", msg.text, msg.ts)
    .run();
}

async function getMessages(env, room, since) {
  const r = await env.chat_exp_db
    .prepare("SELECT type, name, text, created_at FROM messages WHERE room = ? AND created_at > ? ORDER BY created_at ASC")
    .bind(room, since)
    .all();
  return (r.results || []).map((x) => ({
    type: x.type,
    name: x.name || undefined,
    text: x.text,
    ts: x.created_at,
  }));
}
