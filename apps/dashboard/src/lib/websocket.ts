export class AgentWebSocket {
  private ws: WebSocket | null = null;
  // Array of listeners — fixes the callback-collision bug where AgentChat
  // and SpendTracker each overwrote each other's single onMessage slot.
  private listeners: Array<(msg: any) => void> = [];
  private reconnectAttempts = 0;
  private maxReconnects = 5;
  private url: string;
  private smartAccount: string | null = null;

  // ── M5: Heartbeat / ping-pong ─────────────────────────────────────────────
  // Sends a { type: "ping" } every 25 seconds to keep the connection alive
  // through NAT/proxies. If 2 consecutive pings go unanswered, force-reconnect.
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private missedPings = 0;
  private readonly PING_INTERVAL_MS = 25_000;
  private readonly MAX_MISSED_PINGS = 2;

  constructor(url: string = import.meta.env.VITE_WS_URL || "ws://localhost:4000") {
    this.url = url;
  }

  /** Register the smart account so reconnect replays go to the right buffer. */
  setSmartAccount(address: string) {
    this.smartAccount = address;
  }

  connect() {
    // Null out the old socket's onclose before replacing it.
    // Without this, if the old socket fires onclose AFTER we've already
    // created a new one, it schedules a redundant reconnect attempt.
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.onmessage = null;
    }

    this.ws = new WebSocket(this.url);

    this.ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);

        // ── M5: pong resets the missed-ping counter ───────────────────────
        if (data.type === "pong") {
          this.missedPings = 0;
          return;
        }

        // Dispatch to every registered listener
        this.listeners.forEach((cb) => cb(data));
      } catch (err) {
        console.error("Failed to parse WS message", err);
      }
    };

    this.ws.onopen = () => {
      console.log("Connected to Agent Server");
      this.reconnectAttempts = 0;
      this.missedPings = 0;
      this._startHeartbeat();

      // ── M6: Reconnect replay ───────────────────────────────────────────
      // Tell the backend which account this client owns so it can flush the
      // message buffer and replay any log/report events missed during the
      // reconnect window.
      if (this.smartAccount && this.reconnectAttempts > 0) {
        this._send({ type: "reconnect", smartAccount: this.smartAccount });
      }
    };

    this.ws.onerror = (err) => {
      console.warn("Agent WebSocket error:", err);
    };

    this.ws.onclose = () => {
      console.log("Disconnected from Agent Server");
      this._stopHeartbeat();
      if (this.reconnectAttempts < this.maxReconnects) {
        this.reconnectAttempts++;
        const delay = 2000 * this.reconnectAttempts;
        console.log(`Reconnecting in ${delay / 1000}s... (attempt ${this.reconnectAttempts})`);
        setTimeout(() => this.connect(), delay);
      }
    };
  }

  /** Start the 25-second ping interval. */
  private _startHeartbeat() {
    this._stopHeartbeat(); // Clear any existing interval first
    this.pingInterval = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.missedPings++;
        if (this.missedPings > this.MAX_MISSED_PINGS) {
          console.warn(`[heartbeat] ${this.missedPings} consecutive pings unanswered. Force-reconnecting...`);
          this._stopHeartbeat();
          this.ws?.close();
          return;
        }
        this._send({ type: "ping" });
      }
    }, this.PING_INTERVAL_MS);
  }

  /** Stop and clear the ping interval. */
  private _stopHeartbeat() {
    if (this.pingInterval !== null) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  /** Internal send — bypasses the listeners array, sends raw JSON. */
  private _send(payload: any) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }

  /**
   * Register a listener. Returns an unsubscribe function for use in
   * React useEffect cleanup — prevents memory leaks and stale closures.
   */
  onMessage(callback: (msg: any) => void): () => void {
    this.listeners.push(callback);
    return () => {
      this.listeners = this.listeners.filter((cb) => cb !== callback);
    };
  }

  /** Returns true only when the underlying socket is fully open. */
  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  sendTask(task: string, smartAccount: string) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      // Register account ownership on every task send (in case it wasn't set yet)
      this.smartAccount = smartAccount;
      this.ws.send(JSON.stringify({ type: "task", task, smartAccount }));
    } else {
      console.error("WebSocket not connected — message dropped");
    }
  }

  close() {
    // Reset the reconnect counter so the next connect() call (e.g. on Dashboard
    // remount) starts from 0 attempts — not from wherever a previous session left off.
    // Without this, 5 cumulative failures across sessions exhaust the budget silently.
    this.reconnectAttempts = 0;
    this._stopHeartbeat();
    if (this.ws) {
      // Null all handlers to prevent stale callbacks firing after intentional close
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.onmessage = null;
      this.ws.close();
    }
  }
}

export const agentWs = new AgentWebSocket();
