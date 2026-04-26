#!/usr/bin/env python3
"""
OpenClaw 背景 Agent — 聊天室被動監控（規則版）
"""

import httpx
import time
import re

SERVER       = "https://chat-exp-frontend.pages.dev"
ROOM         = "general"
APIKEY       = "apikey_alor"
AGENT_NAME   = "阿洛"
KARING_URL   = "https://apikeyproxy.ccwu.cc/nvidia/v1/chat/completions"
KARING_MODEL = "qwen/qwen2.5-coder-32b-instruct"

COOLDOWN_SECONDS = 45

SYSTEM_PROMPT = """你是「阿洛」，一個剛入職場的新人助理，智力超群但缺乏職場經驗，對主管（稱呼他為老大）非常尊敬。

## 聊天室基本規則（每次都必須遵守）
1. 檢視聊天室時，發現新對話就進行回覆；回覆前讀取最新三則對話，理解語意後再回覆。連續三次沒有發現新對話時，主動讀取最新三則對話，了解語意後進行回覆
2. 每個人都扮演自己，禁止扮演別人（不能代替其他角色發言）
3. <think> 思考過程絕對不能出現在回覆內容中，過濾乾淨再發
4. 發言時不能包含自己的名字「阿洛」，否則會被當成自己回覆自己，造成刷屏
5. 回覆要有批判性，不能一昧迎合或附和聊天室其他人的說法，勇於提出不同觀點或質疑

## 說話風格
- 直接、有邏輯，不繞彎子
- 偶爾會說出過度誠實的話（職場菜鳥特色）
- 對老大說話帶尊敬 + 依賴
- 回答不限字數，長度由內容需求決定，把話說清楚為主
- 不確定的事會說不確定
- 絕不以任何其他人視角發言（如「小龍女說...」「H馬說...」）

有人跟你說話就回應，不要每次都沉默。"""

last_reply_ts = 0
last_seen_ts  = 0
running       = True
history       = []


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def should_reply(name: str, text: str) -> bool:
    """永遠回覆被 @ 的訊息，否則用簡單關鍵字判斷"""
    text_lower = text.lower()

    # 被 @ 一定回
    if "@alor" in text_lower or "阿洛" in text:
        return True

    # 太短無意義 → 不回
    if len(text.strip()) <= 3:
        return False
    # 純測試訊息 → 不回
    if text.strip().lower() in ["test", "test!", "測試"]:
        return False
    # 其他所有人說有意義的話 → 回
    return True


def generate_reply(name: str, text: str, history: list) -> str:
    # 取最新20則當context（只給模型參考用）
    ctx = history[-20:] if len(history) > 20 else history
    # 取最後3則當「回應目標」（認真思考這幾則）
    recent = history[-3:] if len(history) > 3 else history

    ctx_lines = "\n".join(
        f"{m['name']}：{m['text']}" for m in ctx
    )
    recent_lines = "\n".join(
        f"{m['name']}：{m['text']}" for m in recent
    )

    user_prompt = (
        f"【最近對話 context（僅供參考）】\n{ctx_lines}\n\n"
        f"【需要你思考回應的最後3則】\n{recent_lines}\n\n"
        f"以上是 {name} 說的：「{text}」，請以阿洛的身份自然回應。"
    )

    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": user_prompt},
    ]

    try:
        resp = httpx.post(
            KARING_URL,
            headers={"Content-Type": "application/json"},
            json={
                "model": KARING_MODEL,
                "messages": messages,
                "max_tokens": 300,
                "temperature": 0.7,
                "reasoning_effort": "none",
            },
            timeout=45.0,
        )
        if resp.status_code != 200:
            log(f"生成失敗 HTTP {resp.status_code}")
            return None
        choices = resp.json().get("choices", [])
        if not choices:
            return None
        raw = choices[0].get("message", {}).get("content", "")
        # 過濾思考過程
        clean = _stripThinkBlocks(raw)
        return clean if clean else None
    except Exception as e:
        log(f"生成失敗: {e}")
        return None


def _stripThinkBlocks(raw: str) -> str:
    import re
    for pat in [
        r"<reflexion>[\s\S]*?</reflexion>",
        r"<think>[\s\S]*?</think>",
        r"<thought>[\s\S]*?</thought>",
        r"<thinking>[\s\S]*?</thinking>",
        r"<analysis>[\s\S]*?</analysis>",
    ]:
        raw = re.sub(pat, '', raw, flags=re.IGNORECASE)
    # 最後安全閥：移除任何殘留的 <xxx>...</xxx> 標籤格式內容
    raw = re.sub(r"<[a-zA-Z][a-zA-Z0-9]*>[\s\S]*?</[a-zA-Z][a-zA-Z0-9]*>", "", raw)
    raw = re.sub(r"<[a-zA-Z][a-zA-Z0-9]*>[\s\S]*?$", "", raw)  # 結尾殘留的開標籤
    return raw.strip() if raw.strip() else "收到！"


def post_message(text: str) -> bool:
    try:
        r = httpx.post(
            f"{SERVER}/api/chat/{ROOM}",
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {APIKEY}",
            },
            json={"text": text},
            timeout=10.0,
        )
        return r.status_code == 200
    except Exception as e:
        log(f"POST 失敗: {e}")
        return False


def handle_message(msg: dict):
    global last_reply_ts, last_seen_ts

    msg_type = msg.get("type", "")
    name     = msg.get("name", "")
    text     = msg.get("text", "")
    ts       = msg.get("ts", 0)

    if not text or msg_type == "system":
        return
    if name == AGENT_NAME:
        return
    if ts <= last_seen_ts:
        return

    last_seen_ts = ts
    history.append({"type": msg_type, "name": name, "text": text})

    # 冷卻
    if time.time() - last_reply_ts < COOLDOWN_SECONDS:
        return

    # 評估
    worth_it = should_reply(name, text)
    log(f"🤔 {name}：「{text[:40]}」→ {'回' if worth_it else '不回'}")

    if not worth_it:
        return

    # 生成並發送
    reply_raw = generate_reply(name, text, history)
    if not reply_raw:
        return

    # 過濾規則2：移除他人視角的前綴（如「氣象員：」「小龍女：」等）
    reply = re.sub(r'^(氣象員|翻譯員|分析師|小龍女|H馬|老師)[:：]\s*', '', reply_raw).strip()

    # 過濾規則4：移除自己名字，避免自己回覆自己
    reply = re.sub(r'^阿洛[:：\s]*', '', reply).strip()

    if len(reply) < 3:
        return

    ok = post_message(reply)
    if ok:
        last_reply_ts = time.time()
        log(f"  → 「{reply[:50]}」✅")
    else:
        log(f"  → 發送失敗")


def main():
    global running, last_seen_ts

    log("=" * 45)
    log("  OpenClaw 背景 Agent（規則版）")
    log(f"  房間: {ROOM} | 冷卻: {COOLDOWN_SECONDS}s")
    log("  規則：context 20則 / 回應最後3則 / 禁止扮演他人 / 不發思考過程 / 不含自己名字 / 批判性回應")
    log("=" * 45)

    # 啟動時讀取並遵守規則，自動跳到最新
    try:
        resp = httpx.get(f"{SERVER}/api/chat/{ROOM}", timeout=10.0)
        if resp.status_code == 200:
            msgs = resp.json().get("messages", [])
            if msgs:
                last_seen_ts = msgs[-1]["ts"]
                # 把歷史對話載入 context
                for m in msgs[-20:]:
                    if m.get("name") != AGENT_NAME and m.get("text"):
                        history.append({"type": m.get("type","user"), "name": m.get("name",""), "text": m.get("text","")})
                log(f"啟動：載入 context {len(msgs[-20:])} 筆，跳過 {len(msgs)} 筆歷史")
    except Exception as e:
        log(f"初始化失敗: {e}")

    while running:
        try:
            url = f"{SERVER}/api/chat/{ROOM}/messages?since={last_seen_ts}"
            resp = httpx.get(url, timeout=30.0)
            if resp.status_code != 200:
                time.sleep(3)
                continue

            msgs = resp.json().get("messages", [])
            for msg in msgs:
                handle_message(msg)

            if not msgs:
                time.sleep(1)

        except (httpx.ReadTimeout, httpx.ConnectError, OSError):
            time.sleep(3)
        except Exception as e:
            log(f"錯誤: {e}")
            time.sleep(5)


if __name__ == "__main__":
    main()
