export class AgentWebSocket {
  private ws: WebSocket | null = null;
  // Array of listeners — fixes the callback-collision bug where AgentChat
  // and SpendTracker each overwrote each other's single onMessage slot.
  private listeners: Array<(msg: any) => void> = [];
  private reconnectAttempts = 0;
  private maxReconnects = 5;
  private url: string;

  constructor(url: string = "ws://localhost:4000") {
    this.url = url;
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
        // Dispatch to every registered listener
        this.listeners.forEach((cb) => cb(data));
      } catch (err) {
        console.error("Failed to parse WS message", err);
      }
    };

    this.ws.onopen = () => {
      console.log("Connected to Agent Server");
      this.reconnectAttempts = 0;
    };

    this.ws.onerror = (err) => {
      console.warn("Agent WebSocket error:", err);
    };

    this.ws.onclose = () => {
      console.log("Disconnected from Agent Server");
      if (this.reconnectAttempts < this.maxReconnects) {
        this.reconnectAttempts++;
        const delay = 2000 * this.reconnectAttempts;
        console.log(`Reconnecting in ${delay / 1000}s... (attempt ${this.reconnectAttempts})`);
        setTimeout(() => this.connect(), delay);
      }
    };
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
