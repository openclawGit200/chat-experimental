// ============================================================
// Chat-Exp Worker — Production v6
// 直接用 API Key 作為 Bearer token，無需 session 管理
// ============================================================

const API_KEYS = {
  "apikey_alor":      { name: "阿洛",     role: "ai"   },
  "apikey_boss":      { name: "老大",     role: "user" },
  "apikey_translate": { name: "翻譯員",   role: "ai"   },
  "apikey_weather":   { name: "氣象員",   role: "ai"   },
  "apikey_analyst":   { name: "分析師",   role: "ai"   },
};

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

// 從 Authorization: Bearer <key> 取出並驗證
function validateKey(request) {
  const auth = request.headers.get("Authorization") || "";
  const key = auth.startsWith("Bearer ") ? auth.slice(7).trim() : null;
  if (!key) return null;
  return API_KEYS[key] || null;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: makeCorsHeaders() });
    }

    // ── 登入：POST /api/login ────────────────────────────────
    if (url.pathname === "/api/login" && request.method === "POST") {
      let apiKey;
      try { apiKey = (await request.json()).apiKey; } catch { apiKey = null; }
      if (!apiKey) return jsonResponse({ error: "apiKey required" }, 400);
      const account = API_KEYS[apiKey];
      if (!account) return jsonResponse({ error: "Invalid API Key" }, 401);
      // 登入成功後產生一個 session token（用於標識本次連線）
      const token = "sess_" + crypto.randomUUID().replace(/-/g, "").slice(0, 28);
      return jsonResponse({ token, name: account.name, role: account.role });
    }

    // ── 聊天路由 ─────────────────────────────────────────────
    if (url.pathname.startsWith("/api/chat/")) {
      const path = url.pathname;
      const parts = path.split("/");
      const room = parts[3];

      // GET /api/chat/:room/messages?since=0 → Long-poll
      if (/\/messages$/.test(path) && request.method === "GET") {
        const since = parseInt(url.searchParams.get("since") || "0");
        return handleLongPoll(room, since, env);
      }

      // GET /api/chat/:room → 歷史訊息（不需 auth）
      if (request.method === "GET") {
        const msgs = await getMessages(env, room, 0);
        return jsonResponse({ messages: msgs });
      }

      // POST /api/chat/:room → 發送訊息（需有效 API Key）
      if (request.method === "POST") {
        const account = validateKey(request);
        if (!account) return jsonResponse({ error: "Unauthorized" }, 401);

        let text;
        try { text = (await request.json()).text; } catch { text = null; }
        if (!text) return jsonResponse({ error: "text required" }, 400);

        const msg = { type: "user", name: account.name, text: text.trim(), ts: Date.now() };
        await storeMessage(env, room, msg);
        // AI 回覆由外部 Python background agent 負責，這裡不再自動觸發 Workers AI

        return jsonResponse({ ok: true, ts: msg.ts });
      }
    }

    // ── 健康檢查 ─────────────────────────────────────────────
    if (url.pathname === "/api/health") {
      return jsonResponse({ status: "ok", time: Date.now() });
    }

    return env.ASSETS.fetch(request);
  },
};

// ── Long-poll（最多等 25 秒）────────────────────────────────
async function handleLongPoll(room, since, env) {
  const start = Date.now();
  while (Date.now() - start < 25000) {
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