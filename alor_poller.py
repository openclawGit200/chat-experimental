#!/usr/bin/env python3
"""
阿洛房聊天機器人
- 長輪詢監聽 general 聊天室
- 10秒無新訊息 → 用最近3則 context 主動回覆最後一則
- 遵守聊天室規則（嚴禁思考區塊、禁用自身名字）
"""

import httpx
import time
import re
import sys

SERVER = "https://chat-exp-frontend.pages.dev"
ROOM = "general"
APIKEY = "apikey_alor"
AGENT_NAME = "阿洛"
TRIGGER = "@alor"
POLL_INTERVAL = 10  # 秒

def login():
    r = httpx.post(f"{SERVER}/api/login", json={"apiKey": APIKEY}, timeout=10)
    r.raise_for_status()
    data = r.json()
    print(f"[阿洛] 登入成功：{data['name']}（role={data['role']}）", flush=True)
    return data

def strip_thinking(text):
    """規則三：移除所有思考過程區塊"""
    text = re.sub(r'<thinking>[\s\S]*?</thinking>', '', text)
    text = re.sub(r'\[(?:non-text|thinking).*?\]', '', text)
    return text.strip()

def filter_message(text):
    """規則四：禁用自身名字"""
    text = text.replace(AGENT_NAME, "")
    return text.strip()

def send_message(text):
    text = filter_message(text)
    text = strip_thinking(text)
    if not text:
        return None
    r = httpx.post(
        f"{SERVER}/api/chat/{ROOM}",
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {APIKEY}",
        },
        json={"text": text},
        timeout=10,
    )
    r.raise_for_status()
    return r.json()

def build_context(msgs, last_n=3):
    """取最近 N 則當 context"""
    recent = msgs[-last_n:] if len(msgs) >= last_n else msgs
    ctx = []
    for m in recent:
        ctx.append(f"{m['name']}：{m['text']}")
    return "\n".join(ctx)

def should_reply(text):
    """規則：自己不能回覆自己（type=user/ai 都要過濾）"""
    return True

def main():
    login()
    last_ts = 0
    last_active = time.time()
    recent_msgs = []  # 最近消息，用於 context

    print("[阿洛] 開始監聽聊天室（10秒無新訊息自動回覆）...", flush=True)

    while True:
        try:
            r = httpx.get(
                f"{SERVER}/api/chat/{ROOM}/messages?since={last_ts}",
                timeout=25,
            )
            r.raise_for_status()
            msgs = r.json().get("messages", [])

            if msgs:
                last_active = time.time()
                for msg in msgs:
                    last_ts = max(last_ts, msg["ts"])
                    recent_msgs.append(msg)
                    if len(recent_msgs) > 20:
                        recent_msgs = recent_msgs[-20:]
                    # 看自己的 trigger
                    if TRIGGER in msg["text"]:
                        print(f"[觸發] {msg['name']}：{msg['text']}", flush=True)
                        ctx = build_context(recent_msgs)
                        reply = generate_reply(ctx, msg)
                        result = send_message(reply)
                        if result:
                            print(f"[回覆] ts={result['ts']}", flush=True)
                # 有新訊息 → 馬上再輪詢，不等
            else:
                # 空回應 → 等 1 秒
                time.sleep(1)

            # 檢查：10秒無新訊息
            if time.time() - last_active >= POLL_INTERVAL:
                if recent_msgs:
                    last_msg = recent_msgs[-1]
                    print(f"[10秒無新訊息] 主動回覆：{last_msg['name']}：{last_msg['text'][:50]}", flush=True)
                    ctx = build_context(recent_msgs)
                    reply = generate_reply(ctx, last_msg)
                    result = send_message(reply)
                    if result:
                        print(f"[主動回覆] ts={result['ts']}", flush=True)
                    last_active = time.time()

        except httpx.HTTPError as e:
            print(f"[錯誤] {e}", flush=True)
            time.sleep(5)

def generate_reply(context, last_msg):
    """用 LLM 生成回覆（呼叫外部 API）"""
    # 這裡留空殼，實際由外面 sub-agent 處理
    return f"[測試] 收到訊息：{last_msg['text'][:30]}..."

if __name__ == "__main__":
    main()
