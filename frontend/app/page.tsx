"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { ChannelList } from "@/components/channel-list";
import { NameDialog } from "@/components/name-dialog";
import { User } from "lucide-react";
import { getUserColor } from "@/lib/colors";

interface Message {
  type: "system" | "user" | "ai";
  name?: string;
  text: string;
  ts?: number;
}

interface ChatState {
  messages: Message[];
  lastTs: number;
}

const SERVER_URL = "https://chat-exp-frontend.pages.dev";
const MAX_MESSAGES = 200;

function formatTime(ts: number): string {
  if (!ts) return "";
  const d = new Date(ts * 1000); // ts from D1 is unix seconds
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}

export default function Home() {
  const [activeChannel, setActiveChannel] = useState("general");
  const [chatStates, setChatStates] = useState<Record<string, ChatState>>({
    general: { messages: [], lastTs: 0 },
  });
  const [userName, setUserName] = useState("");
  const [token, setToken] = useState("");
  const [inputMessage, setInputMessage] = useState("");
  const [isConnected, setIsConnected] = useState(false);
  const scrollAreaRef = useRef<HTMLDivElement>(null);

  // Restore session from localStorage on mount
  useEffect(() => {
    const savedApiKey = localStorage.getItem("chat_api_key");
    const savedToken  = localStorage.getItem("chat_token");
    const savedName  = localStorage.getItem("chat_name");
    if (savedApiKey && savedName) {
      setToken(savedApiKey);
      setUserName(savedName);
    } else if (savedToken && savedName) {
      // migrate legacy sessions
      setToken(savedToken);
      setUserName(savedName);
    }
  }, []);

  const currentChatState = chatStates[activeChannel] || { messages: [], lastTs: 0 };

  const scrollToBottom = useCallback(() => {
    const timeoutId = setTimeout(() => {
      if (scrollAreaRef.current) {
        const scrollContainer = scrollAreaRef.current.querySelector(
          "[data-radix-scroll-area-viewport]"
        );
        if (scrollContainer) {
          scrollContainer.scrollTop = scrollContainer.scrollHeight;
        }
      }
    }, 100);
    return () => clearTimeout(timeoutId);
  }, []);

  useEffect(() => {
    const cleanup = scrollToBottom();
    return cleanup;
  }, [currentChatState.messages, scrollToBottom]);

  // Poll for messages using long-poll
  const pollMessages = useCallback(async (room: string, since: number) => {
    try {
      const res = await fetch(
        `${SERVER_URL}/api/chat/${room}/messages?since=${since}`,
        { cache: "no-store" }
      );
      if (!res.ok) throw new Error("poll failed");
      const data = await res.json();
      const msgs: Message[] = data.messages || [];
      if (msgs.length > 0) {
        setChatStates((prev) => {
          const roomState = prev[room] || { messages: [], lastTs: since };
          const newMsgs = msgs.filter((m) => !roomState.messages.some((em) => em.ts === m.ts));
          if (newMsgs.length === 0) return prev;
          const lastMsg = msgs[msgs.length - 1];
          const combined = [...roomState.messages, ...newMsgs];
          return {
            ...prev,
            [room]: {
              messages: combined.slice(-MAX_MESSAGES),
              lastTs: lastMsg.ts ?? roomState.lastTs,
            },
          };
        });
        setIsConnected(true);
        return msgs[msgs.length - 1].ts ?? since;
      } else {
        setIsConnected(true);
        return since;
      }
    } catch {
      setIsConnected(false);
      return since;
    }
  }, []);

  // Start polling loop
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!userName) return;

    const state = chatStates[activeChannel] || { messages: [], lastTs: 0 };
    let currentSince = state.lastTs;
    let polling = true;

    const loop = async () => {
      while (polling) {
        currentSince = await pollMessages(activeChannel, currentSince);
        if (polling) await new Promise((r) => setTimeout(r, 1000));
      }
    };

    loop();
    return () => { polling = false; };
  }, [activeChannel, userName, pollMessages]);

  // Load history on mount / channel switch
  useEffect(() => {
    if (!userName) return;

    const loadHistory = async () => {
      try {
        const res = await fetch(`${SERVER_URL}/api/chat/${activeChannel}?since=0`);
        const data = await res.json();
        const msgs: Message[] = data.messages || [];
        if (msgs.length > 0) {
          setChatStates((prev) => ({
            ...prev,
            [activeChannel]: {
              messages: msgs.slice(-MAX_MESSAGES),
              lastTs: msgs[msgs.length - 1].ts ?? 0,
            },
          }));
        }
      } catch {
        console.error("Failed to load history");
      }
    };

    loadHistory();
  }, [activeChannel, userName]);

  const sendMessage = useCallback(async () => {
    if (!inputMessage.trim() || !token) return;
    const text = inputMessage;
    setInputMessage("");

    try {
      const res = await fetch(`${SERVER_URL}/api/chat/${activeChannel}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`,
        },
        body: JSON.stringify({ text }),
      });
      if (!res.ok && res.status === 401) {
        // Token expired, clear and re-login
        localStorage.removeItem("chat_token");
        localStorage.removeItem("chat_name");
        localStorage.removeItem("chat_role");
        setToken("");
        setUserName("");
      }
    } catch {
      console.error("Send error");
      setInputMessage(text);
    }
  }, [inputMessage, activeChannel, token]);

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") sendMessage();
  };

  const handleChannelSelect = (channel: string) => {
    setActiveChannel(channel);
    setChatStates((prev) => ({
      ...prev,
      [channel]: prev[channel] || { messages: [], lastTs: 0 },
    }));
  };

  const handleLogin = (name: string, authToken: string) => {
    setUserName(name);
    setToken(authToken);
  };

  return (
    <>
      {!userName && <NameDialog onLogin={handleLogin} />}
      <div className="flex h-screen overflow-hidden">
        <aside className="hidden w-64 border-r md:block">
          <div className="flex h-full flex-col">
            <div className="shrink-0 p-4 font-semibold border-b">
              Chat Experimental
            </div>
            <div className="flex-1 overflow-auto">
              <ChannelList
                activeChannel={activeChannel}
                onChannelSelect={handleChannelSelect}
              />
            </div>
            {userName && (
              <div className="shrink-0 border-t p-4 flex items-center gap-2 text-sm text-muted-foreground">
                <User className="h-4 w-4" />
                <span>{userName}</span>
              </div>
            )}
          </div>
        </aside>

        <main className="flex-1 min-w-0">
          <div className="flex h-full">
            <Card className="flex-1 flex flex-col m-4">
              <div className="shrink-0 border-b p-4 font-medium flex items-center gap-2">
                #{activeChannel}
                <span
                  className={`text-xs px-2 py-0.5 rounded-full ${
                    isConnected
                      ? "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300"
                      : "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300"
                  }`}
                >
                  {isConnected ? "● Live" : "○ Reconnecting..."}
                </span>
                <span className="text-xs text-muted-foreground ml-auto">
                  對 AI 說話用 @alor
                </span>
              </div>

              <ScrollArea className="flex-1 min-h-0" ref={scrollAreaRef}>
                <div className="p-4 space-y-2">
                  {currentChatState.messages.length === 0 && (
                    <p className="text-center text-muted-foreground text-sm py-8">
                      還沒有訊息，開始聊天吧！
                    </p>
                  )}
                  {currentChatState.messages.map((message, index) => (
                    <div
                      key={index}
                      className={`rounded-lg p-2 ${
                        message.type === "system"
                          ? "bg-muted font-medium text-center text-sm"
                          : message.type === "ai"
                          ? "bg-blue-100 dark:bg-blue-900/50"
                          : ""
                      }`}
                      style={
                        (message.type === "system" || message.type === "ai")
                          ? {}
                          : { backgroundColor: getUserColor(message.name || "") }
                      }
                    >
                      {message.type === "system" ? (
                        message.text
                      ) : (
                        <>
                          <span className="font-medium">
                            {message.name}
                          </span>
                          <span className="text-xs text-muted-foreground ml-2">
                            {formatTime(message.ts ?? 0)}
                          </span>
                          : {message.text}
                        </>
                      )}
                    </div>
                  ))}
                </div>
              </ScrollArea>

              <Separator />

              <div className="shrink-0 p-4">
                <div className="flex gap-2">
                  <Input
                    placeholder={`說點什麼，或用 @alor 叫 AI 幫忙...`}
                    value={inputMessage}
                    onChange={(e) => setInputMessage(e.target.value)}
                    onKeyDown={handleKeyPress}
                    disabled={!isConnected || !token}
                  />
                  <Button onClick={sendMessage} disabled={!token}>
                    Send
                  </Button>
                </div>
              </div>
            </Card>
          </div>
        </main>
      </div>
    </>
  );
}
