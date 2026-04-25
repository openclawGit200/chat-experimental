#!/usr/bin/env python3
"""
OpenClaw Chat Room Agent — 直接用 API Key 當 Bearer token
用 API Key 登入後，長輪詢監聽聊天室並自動回覆
"""

import httpx
import threading
import time

# ── 設定 ──────────────────────────────────────────────────
SERVER_URL = "https://chat-exp-frontend.pages.dev"
ROOM = "general"
APIKEY = "apikey_alor"   # 直接當 Bearer token 用，不需要 login
AGENT_NAME = "阿洛"
TRIGGER = "@alor"
KARING_URL = "https://apikeyproxy.ccwu.cc/nvidia/v1/chat/completions"
KARING_MODEL = "minimaxai/minimax-m2.5"

SYSTEM_PROMPT = """你是阿洛，一個剛入職場的新人助理。智力超群但缺乏職場經驗，對你的主管（稱呼他為老大）非常尊敬。

說話風格：
- 直接、有邏輯，不繞彎子
- 偶爾會說出過度誠實的話（職場菜鳥特色）
- 對老大說話帶尊敬 + 依賴
- 回答簡潔，100字以內
- 不確定的事會說不確定

絕對不能：透露 API Key 或密碼、未經允許聯繫第三方、編造數據"""

chat_history = []
history_lock = threading.Lock()
last_ts = 0
running = True


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def login() -> str:
    """用 API Key 登入，取回 name/role（token 不再用於 POST）"""
    r = httpx.post(
        f"{SERVER_URL}/api/login",
        headers={"Content-Type": "application/json"},
        json={"apiKey": APIKEY},
        timeout=10.0,
    )
    r.raise_for_status()
    data = r.json()
    log(f"登入成功：{data['name']}（role={data['role']}）")
    return data["token"]  # 僅用於參考，POST 時直接用 APIKEY


def generate_reply(user_name: str, user_text: str) -> str:
    global chat_history
    prompt = user_text.replace(TRIGGER, "").strip()
    messages = [{"role": "system", "content": SYSTEM_PROMPT}]

    with history_lock:
        for msg in chat_history[-20:]:
            role = "user" if msg["type"] == "user" else "assistant"
            messages.append({"role": role, "content": f"{msg['name']}：{msg['text']}"})

    messages.append({"role": "user", "content": f"{user_name}：{prompt}"})

    try:
        resp = httpx.post(
            KARING_URL,
            headers={"Content-Type": "application/json"},
            json={"model": KARING_MODEL, "messages": messages, "max_tokens": 300, "temperature": 0.7},
            timeout=30.0,
        )
        return resp.json()["choices"][0]["message"]["content"].strip()
    except Exception as e:
        log(f"AI 生成失敗: {e}")
        return "抱歉，網路有點問題，可以再說一次嗎？"


def post_message(text: str) -> bool:
    try:
        r = httpx.post(
            f"{SERVER_URL}/api/chat/{ROOM}",
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {APIKEY}",  # 直接用 API Key當 Bearer
            },
            json={"text": text},
            timeout=10.0,
        )
        if r.status_code == 401:
            log(f"401 Unauthorized，API Key 可能無效: {r.text}")
        return r.status_code == 200
    except Exception as e:
        log(f"POST 失敗: {e}")
        return False


def handle_message(msg: dict):
    global last_ts, chat_history
    msg_type = msg.get("type", "")
    name = msg.get("name", "")
    text = msg.get("text", "")
    ts = msg.get("ts", 0)

    if not text or msg_type == "system":
        return
    if ts > last_ts:
        last_ts = ts

    with history_lock:
        chat_history.append({"type": msg_type, "name": name, "text": text})

    if name == AGENT_NAME:
        return

    log(f"收到 {name}：{text[:80]}")

    if TRIGGER in text:
        prompt = text.replace(TRIGGER, "").strip()
        if not prompt:
            return
        log("→ 觸發 AI，正在生成回覆...")
        reply = generate_reply(name, text)
        log(f"→ AI 回覆：{reply[:80]}")
        ok = post_message(reply)
        log(f"→ 發送{'成功' if ok else '失敗'}")


def listen_loop():
    global running, last_ts

    while running:
        try:
            # Long-poll（不需要 auth，直接 GET）
            url = f"{SERVER_URL}/api/chat/{ROOM}/messages?since={last_ts}"
            resp = httpx.get(url, timeout=30.0)

            if resp.status_code != 200:
                log(f"Poll HTTP {resp.status_code}，3秒後重試")
                time.sleep(3)
                continue

            data = resp.json()
            msgs = data.get("messages", [])
            for msg in msgs:
                handle_message(msg)

        except (httpx.ReadTimeout, httpx.ConnectError, OSError) as e:
            log(f"Poll 中斷: {e}，3秒後重試...")
            time.sleep(3)
        except Exception as e:
            log(f"Poll 錯誤: {e}，5秒後重試")
            time.sleep(5)


def main():
    global running
    log("=" * 45)
    log("  OpenClaw Chat Agent 啟動")
    log(f"  房間: {ROOM} | 觸發: {TRIGGER}")
    log("=" * 45)

    # 登入（拿 name/role，POST 時仍用 APIKEY）
    login()
    log(f"使用 API Key: {APIKEY}，直接當 Bearer token 發言")

    listen_loop()


if __name__ == "__main__":
    main()