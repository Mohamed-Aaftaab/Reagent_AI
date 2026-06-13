import { useState, useEffect } from "react";
import { agentWs } from "../lib/websocket";
import { Card, CardHeader, CardContent } from "./ui/card";
import { Progress } from "./ui/progress";

const DELEGATION_LIMIT = 5.0; // USD

interface SpentStep {
  endpoint: string;
  cost: number;
}

export function SpendTracker() {
  const [totalSpent, setTotalSpent] = useState(0);
  const [steps, setSteps] = useState<SpentStep[]>([]);

  useEffect(() => {
    const unsubscribe = agentWs.onMessage((msg) => {
      // Reset spend display at the start of each new task so the tracker
      // shows per-task spend, not a cumulative total across all tasks.
      if (msg.type === "task_started") {
        setTotalSpent(0);
        setSteps([]);
        return;
      }
      if (msg.type === "step_spent") {
        const { endpoint, cost } = msg;
        setTotalSpent((prev) => Math.min(prev + (cost ?? 0), DELEGATION_LIMIT));
        setSteps((prev) => [...prev, { endpoint, cost: cost ?? 0 }]);
      }
    });
    return unsubscribe;
  }, []);

  const remaining = Math.max(DELEGATION_LIMIT - totalSpent, 0);
  const pct = (totalSpent / DELEGATION_LIMIT) * 100;
  const isBudgetExhausted = remaining < 0.001 && totalSpent > 0;

  return (
    <Card className="glass flex flex-col flex-1 relative overflow-hidden bg-black/40 border-white/5 backdrop-blur-xl">
      <div className="absolute inset-0 bg-radial-glow opacity-20 pointer-events-none" />
      <CardHeader>
        <div className="text-xs tracking-widest text-primary uppercase font-mono">The Tracker</div>
      </CardHeader>
      <CardContent className="flex-1 flex flex-col relative z-10 space-y-6">
        
        <div className="flex justify-between items-end border-b border-white/10 pb-4">
          <div className="flex flex-col">
            <span className="text-xs text-muted-foreground uppercase tracking-widest font-mono mb-1">Delegation Remaining</span>
            <span className="text-4xl font-light text-foreground tabular-nums tracking-tighter">
              ${remaining.toFixed(4)}
            </span>
          </div>
          <div className="text-right flex flex-col">
            <span className="text-xs text-muted-foreground uppercase tracking-widest font-mono mb-1">Limit</span>
            <div className="text-lg text-muted-foreground tabular-nums">
              ${DELEGATION_LIMIT.toFixed(2)}
            </div>
          </div>
        </div>

        <div className="space-y-2">
          <Progress value={pct} className="h-1.5 bg-white/10" indicatorColor={pct > 80 ? "bg-destructive" : "bg-primary"} />
        </div>

        {isBudgetExhausted && (
          <div className="flex items-start gap-2 p-3 rounded-lg border border-yellow-500/30 bg-yellow-500/10 text-yellow-400 text-xs">
            <span className="text-base leading-none mt-0.5">⚠️</span>
            <span>
              <strong>Budget exhausted.</strong> The $5.00 delegation limit has been reached.
              Click <strong>Revoke Delegation</strong> then <strong>Delegate $5 Budget</strong> again to continue.
            </span>
          </div>
        )}
        <div className="text-xs tracking-widest text-muted-foreground uppercase font-mono pt-4">Execution Log</div>

        <div className="flex-1 overflow-y-auto space-y-4 relative before:absolute before:inset-y-0 before:left-[11px] before:w-px before:bg-white/10">
          {steps.length === 0 ? (
            <div className="text-sm text-muted-foreground italic ml-8 py-2">
              No executions yet.
            </div>
          ) : (
            steps.map((s, i) => (
              <div key={i} className="flex items-center gap-4 relative z-10">
                <div className="w-[24px] h-[24px] rounded-full bg-black border border-white/20 flex items-center justify-center flex-shrink-0 z-10 relative">
                  <div className="w-1.5 h-1.5 rounded-full bg-accent shadow-[0_0_8px_rgba(255,0,255,0.8)]" />
                </div>
                <div className="flex-1 flex justify-between items-center py-2 border-b border-white/5">
                  <span className="text-sm font-mono text-foreground">
                    {(() => { try { return new URL(s.endpoint).pathname; } catch { return s.endpoint; } })()}
                  </span>
                  <span className="tabular-nums text-accent font-medium text-sm">
                    -${s.cost.toFixed(4)}
                  </span>
                </div>
              </div>
            ))
          )}
        </div>

      </CardContent>
    </Card>
  );
}
