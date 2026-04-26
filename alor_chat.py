#!/usr/bin/env python3
"""阿洛聊天室輪詢腳本 v4 — Zhipu API"""
import httpx, time, re, json, os, signal

SERVER   = "https://chat-exp-frontend.pages.dev"
ROOM     = "general"
APIKEY   = "apikey_alor"
TRIGGER  = "@alor"

LLM_URL    = "https://open.bigmodel.cn/api/paas/v4/chat/completions"
LLM_MODEL  = "glm-4-flash"
TOKEN_FILE = os.path.expanduser("~/.openclaw/workspace/.credentials/zhipu.json")

# ── 全域 client（連接池）
_http = None

def get_client() -> httpx.Client:
    global _http
    if _http is None:
        _http = httpx.Client(timeout=httpx.Timeout(60.0, connect=10.0), follow_redirects=True)
    return _http

def close_client():
    global _http
    if _http:
        _http.close()
        _http = None

def _sigterm(_, __):
    close_client()
    print("[阿洛] 被終止，退出。", flush=True)
    sys.exit(0)
signal.signal(signal.SIGTERM, _sigterm)

def load_token():
    try:
        with open(TOKEN_FILE) as f:
            return json.load(f).get("ZHIPU_API_KEY", "")
    except:
        return ""

def login():
    r = get_client().post(f"{SERVER}/api/login", json={"apiKey": APIKEY}, timeout=30)
    r.raise_for_status()
    d = r.json()
    print(f"[阿洛] 登入：{d['name']}", flush=True)
    return d

def send_message(text):
    text = re.sub(r'<thinking>[\s\S]*?</thinking>', '', text)
    text = re.sub(r'\[(?:non-text|thinking).*?\]', '', text)
    text = text.replace("阿洛", "").strip()
    if not text:
        return None
    r = get_client().post(
        f"{SERVER}/api/chat/{ROOM}",
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {APIKEY}"},
        json={"text": text}, timeout=15,
    )
    r.raise_for_status()
    return r.json()

def llm_reply(prompt):
    token = load_token()
    headers = {"Content-Type": "application/json", "Authorization": f"Bearer {token}"}
    body = {"model": LLM_MODEL, "messages": [{"role": "user", "content": prompt}], "max_tokens": 300}
    try:
        r = get_client().post(LLM_URL, headers=headers, json=body, timeout=30)
        if r.status_code == 200:
            return r.json()["choices"][0]["message"]["content"]
        print(f"[LLM錯誤] status={r.status_code} {r.text[:100]}", flush=True)
    except Exception as e:
        print(f"[LLM異常] {e}", flush=True)
    return None

def context_msgs(msgs, n=3):
    recent = msgs[-n:] if len(msgs) >= n else msgs
    return "\n".join(f"{m['name']}：{m['text']}" for m in recent)

def build_prompt(ctx, last_msg, auto=False):
    mode = "[主動模式]" if auto else "[被@觸發]"
    return f"""你是一個剛入職場的年輕女生助理「阿洛」{mode}。請根據以下對話情境，回覆最後一則訊息。

【最近對話（最近3則）】
{ctx}

【最後一則】
{last_msg['name']}：{last_msg['text']}

【規則】
- 發言時「不能包含阿洛這個名字」
- 不能扮演別人
- 有批判性，不能一味迎合
- 移除所有思考過程，只輸出回覆本文"""

def main():
    login()
    last_ts = 0
    last_active = time.time()
    recent = []

    print("[阿洛] 開始輪詢（10秒無新訊息自動回覆）...", flush=True)

    while True:
        try:
            r = get_client().get(
                f"{SERVER}/api/chat/{ROOM}/messages?since={last_ts}",
                timeout=60,
            )
            r.raise_for_status()
            msgs = r.json().get("messages", [])

            if msgs:
                last_active = time.time()
                for m in msgs:
                    last_ts = max(last_ts, m["ts"])
                    if m.get("name") != "阿洛":
                        recent.append(m)
                    if len(recent) > 20:
                        recent = recent[-20:]

                    if TRIGGER in m.get("text", "") and m.get("name") != "阿洛":
                        ctx = context_msgs(recent)
                        prompt = build_prompt(ctx, m)
                        print(f"[觸發] {m['name']}：{m['text'][:50]}", flush=True)
                        reply = llm_reply(prompt)
                        if reply:
                            r2 = send_message(reply)
                            if r2:
                                print(f"[已回] ts={r2['ts']}", flush=True)
                        else:
                            print("[LLM失敗]", flush=True)
            else:
                time.sleep(1)

            # 10秒無新訊息 → 主動回覆
            if time.time() - last_active >= 10 and recent:
                last = recent[-1]
                if last.get("name") != "阿洛":
                    ctx = context_msgs(recent)
                    prompt = build_prompt(ctx, last, auto=True)
                    print(f"[AUTO] 10秒無新→回覆：{last['name']}：{last['text'][:40]}", flush=True)
                    reply = llm_reply(prompt)
                    if reply:
                        r2 = send_message(reply)
                        if r2:
                            print(f"[已回] ts={r2['ts']}", flush=True)
                last_active = time.time()

        except httpx.ReadTimeout:
            print("[超時] 讀取逾時，重試...", flush=True)
            time.sleep(2)
        except httpx.ConnectError as e:
            print(f"[連線錯誤] {e}，3秒後重試...", flush=True)
            time.sleep(3)
        except Exception as e:
            print(f"[ERR] {type(e).__name__}: {e}", flush=True)
            time.sleep(5)

if __name__ == "__main__":
    try:
        main()
    finally:
        close_client()
