"use client";

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

const SERVER_URL = "https://chat-exp-frontend.pages.dev";

interface LoginDialogProps {
  onLogin: (name: string, token: string) => void;
}

export function NameDialog({ onLogin }: LoginDialogProps) {
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(true);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!apiKey.trim()) return;
    setError("");
    setLoading(true);

    try {
      const res = await fetch(`${SERVER_URL}/api/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: apiKey.trim() }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || "Invalid API Key");
        setLoading(false);
        return;
      }

      const data = await res.json();
      localStorage.setItem("chat_token", data.token);
      localStorage.setItem("chat_name", data.name);
      localStorage.setItem("chat_role", data.role || "user");
      setOpen(false);
      onLogin(data.name, data.token);
    } catch {
      setError("Network error, please try again.");
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Welcome to Chat-Exp</DialogTitle>
          <DialogDescription>
            Enter your API Key to join the chat room
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <Input
            placeholder="API Key (e.g. apikey_boss)"
            value={apiKey}
            onChange={(e) => { setApiKey(e.target.value); setError(""); }}
            autoFocus
            disabled={loading}
          />
          {error && (
            <p className="text-red-500 text-sm">{error}</p>
          )}
          <div className="flex justify-end">
            <Button type="submit" disabled={!apiKey.trim() || loading}>
              {loading ? "Logging in..." : "Join Chat"}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            No key? Use <code className="bg-muted px-1 rounded">apikey_boss</code> to login as 老大
          </p>
        </form>
      </DialogContent>
    </Dialog>
  );
}
