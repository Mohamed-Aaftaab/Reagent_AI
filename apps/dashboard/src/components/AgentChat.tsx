import { useState, useEffect, useRef } from "react";
import { agentWs } from "../lib/websocket";
import { Card, CardHeader, CardContent } from "./ui/card";
import { ScrollArea } from "./ui/scroll-area";
import { Textarea } from "./ui/textarea";
import { Button } from "./ui/button";
import { Bot, Send } from "lucide-react";

// Maximum time to wait for any agent response before auto-resetting
// the thinking state. Prevents the UI from locking up if the server
// crashes or the WebSocket drops mid-task.
const THINKING_TIMEOUT_MS = 90_000; // 90 seconds

// Block explorer for the active chain. Update to basescan.org for mainnet.
const BASESCAN_TX_URL = "https://sepolia.basescan.org/tx";

export function AgentChat({ smartAccountAddress }: { smartAccountAddress: string | null }) {
  const [task, setTask] = useState("");
  const [logs, setLogs] = useState<{ type: string; message?: string; report?: string; href?: string }[]>([]);
  const [isThinking, setIsThinking] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  // Timeout ref — cleared ONLY on terminal messages (report/error) or explicit reset.
  // Must NOT be cleared by intermediate log/step messages — that would disarm the 90s safety net.
  const thinkingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs, isThinking]);

  useEffect(() => {
    // App.tsx owns connect()/close(). AgentChat only registers its listener.
    const unsubscribe = agentWs.onMessage((msg) => {
      // ── Handle tx_update relay events ──────────────────────────────────
      // Surface 1Shot relay status updates as informational log entries with a
      // clickable Basescan link so users (and judges) can verify the real tx.
      if (msg.type === "tx_update" && msg.event?.status) {
        const taskId: string | undefined = msg.event.taskId;
        const txHash: string | undefined = msg.event.txHash;
        
        setLogs((prev) => [
          ...prev,
          {
            type: "tx_link",
            message: `🔗 1Shot relay: ${msg.event.status}${txHash ? ` (${txHash.slice(0, 10)}...)` : taskId ? ` (${taskId.slice(0, 10)}...)` : ""}`,
            // Only generate a link if we have a real txHash. taskId will 404 on Basescan.
            href: txHash ? `${BASESCAN_TX_URL}/${txHash}` : undefined,
          },
        ]);
        return;
      }

      // These message types are handled by other components — skip entirely.
      // task_started is also filtered here: it has no message field and would
      // add a blank entry to the chat log if it fell through to setLogs().
      if (
        msg.type === "step_spent" ||
        msg.type === "budget_allocated" ||
        msg.type === "task_started"
      ) return;

      // ── Terminal messages: reset thinking indicator + cancel safety timeout ──
      // The 90s timeout is a SAFETY NET for when the server crashes mid-task and
      // never sends a terminal message. It must NOT be cleared by intermediate
      // log messages (which would disarm it before Groq even responds).
      // Only clear it here, when we know the task has definitively ended.
      if (msg.type === "report" || msg.type === "error") {
        setIsThinking(false);
        if (thinkingTimeoutRef.current) {
          clearTimeout(thinkingTimeoutRef.current);
          thinkingTimeoutRef.current = null;
        }
      }

      setLogs((prev) => [...prev, msg]);
    });
    return unsubscribe;
  }, []);

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (thinkingTimeoutRef.current) clearTimeout(thinkingTimeoutRef.current);
    };
  }, []);

  const resetThinking = () => {
    setIsThinking(false);
    if (thinkingTimeoutRef.current) {
      clearTimeout(thinkingTimeoutRef.current);
      thinkingTimeoutRef.current = null;
    }
  };

  const submitTask = () => {
    if (isThinking) return; // Guard: prevent re-submission while a task is already running.
                            // Ctrl+Enter can bypass the button's disabled prop without this.
    if (!smartAccountAddress) {
      alert("Please connect your MetaMask Smart Account and delegate a budget first.");
      return;
    }
    if (!task.trim()) return;

    // Guard: show a user-visible error if WebSocket is not ready,
    // instead of silently dropping the message to console.error only.
    if (!agentWs.isConnected()) {
      setLogs([{
        type: "error",
        message: "⚠️ Not connected to agent server. Please wait a moment for reconnection and try again.",
      }]);
      return;
    }

    setLogs([]);
    setIsThinking(true);
    agentWs.sendTask(task, smartAccountAddress);

    // Safety timeout — if no response arrives within THINKING_TIMEOUT_MS,
    // reset the UI so the user is not permanently locked out.
    thinkingTimeoutRef.current = setTimeout(() => {
      resetThinking();
      setLogs([{
        type: "error",
        message: "⏱️ Request timed out after 90 seconds. The agent server may be busy or offline — please try again.",
      }]);
    }, THINKING_TIMEOUT_MS);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Ctrl+Enter or Cmd+Enter submits.
    // isThinking check here mirrors the button's disabled prop — without it,
    // the keyboard shortcut bypasses the disabled state and can submit a
    // second concurrent task while one is already running.
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && !isThinking) {
      e.preventDefault();
      submitTask();
    }
  };

  return (
    <Card className="glass flex flex-col h-full max-h-[800px] bg-black/40 border-white/5 backdrop-blur-xl relative overflow-hidden">
      <div className="absolute inset-0 bg-accent-glow opacity-20 pointer-events-none" />
      <CardHeader className="flex flex-row justify-between items-center border-b border-white/10 pb-4 relative z-10">
        <div className="text-xs tracking-widest text-muted-foreground uppercase font-mono">The Agent</div>
        {isThinking && (
          <div className="flex items-center gap-2 px-3 py-1 rounded-full border border-accent/30 bg-accent/10">
            <div className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse shadow-[0_0_8px_rgba(255,0,255,0.8)]" />
            <span className="text-xs text-accent font-medium tracking-wide">Agent thinking...</span>
          </div>
        )}
      </CardHeader>

      <CardContent className="flex-1 flex flex-col p-0 relative z-10 overflow-hidden">
        <ScrollArea className="flex-1 p-6">
          <div className="space-y-6">
            {logs.map((log, i) => (
              <div
                key={i}
                className={`p-4 rounded-xl border backdrop-blur-sm ${
                  log.type === "error" 
                    ? "bg-destructive/10 border-destructive/20 text-destructive-foreground" 
                    : log.type === "report" 
                      ? "bg-white/5 border-white/10 text-foreground font-mono text-sm shadow-soft" 
                      : "bg-primary/5 border-primary/20 text-primary-foreground"
                }`}
              >
                {log.type === "report" ? (
                <pre className="whitespace-pre-wrap">{log.report}</pre>
              ) : log.type === "tx_link" && log.href ? (
                <p className="leading-relaxed">
                  {log.message}{" "}
                  <a
                    href={log.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline opacity-80 hover:opacity-100 transition-opacity"
                  >
                    View on Basescan ↗️
                  </a>
                </p>
              ) : (
                <p className="leading-relaxed">{log.message}</p>
              )}
              </div>
            ))}

            {isThinking && logs.length === 0 && (
              <div className="p-4 rounded-xl border border-white/10 bg-white/5 backdrop-blur-sm shadow-soft animate-pulse">
                <div className="flex gap-2 mb-2">
                  <div className="w-2 h-2 rounded-full bg-accent/50 animate-bounce" style={{ animationDelay: "0ms" }} />
                  <div className="w-2 h-2 rounded-full bg-accent/50 animate-bounce" style={{ animationDelay: "150ms" }} />
                  <div className="w-2 h-2 rounded-full bg-accent/50 animate-bounce" style={{ animationDelay: "300ms" }} />
                </div>
                <p className="text-sm text-muted-foreground">Agent is planning your task...</p>
              </div>
            )}

            {!isThinking && logs.length === 0 && (
              <div className="flex flex-col items-center justify-center h-40 text-muted-foreground opacity-60">
                <Bot className="w-10 h-10 mb-4 opacity-50" />
                <p className="text-sm">Awaiting research task...</p>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>
        </ScrollArea>

        <div className="p-4 border-t border-white/10 bg-black/20 backdrop-blur-md">
          <div className="relative">
            <Textarea
              className="min-h-[100px] resize-none pr-16 bg-white/5 border-white/10 focus-visible:ring-accent text-foreground placeholder:text-muted-foreground/50 rounded-xl"
              placeholder="I'm setting up RT-qPCR to measure IL-6 expression... (Ctrl+Enter to send)"
              value={task}
              onChange={(e) => setTask(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={isThinking}
            />
            <Button
              size="icon"
              className="absolute bottom-3 right-3 rounded-full bg-accent hover:bg-accent/80 text-black shadow-[0_0_15px_rgba(255,0,255,0.4)] transition-all"
              onClick={submitTask}
              disabled={isThinking || !task.trim()}
            >
              <Send className="w-4 h-4" />
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
