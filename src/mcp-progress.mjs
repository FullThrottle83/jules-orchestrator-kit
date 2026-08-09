import { writeMcpFrame } from "./mcp.mjs";

export const MAX_PROGRESS_MESSAGE_LENGTH = 240;
export const DEFAULT_PROGRESS_COALESCE_MS = 150;

/**
 * MCP Progress & Event Streaming Bus with 150ms window coalescing and backpressure safety.
 */
export class ProgressBus {
  /**
   * @param {import("node:stream").Writable} [output=process.stdout]
   * @param {Object} [opts={}]
   * @param {number} [opts.coalesceMs=150]
   */
  constructor(output = process.stdout, opts = {}) {
    this.output = output || process.stdout;
    this.coalesceMs = opts.coalesceMs ?? DEFAULT_PROGRESS_COALESCE_MS;
    this.pending = new Map(); // token -> { timer, latestPayload }
    this.queue = [];
    this.isWriting = false;
    this.isDraining = false;
  }

  /**
   * Internal queue flusher with stream backpressure handling.
   * @private
   */
  async _flushQueue() {
    this.isWriting = true;
    while (this.queue.length > 0) {
      if (this.isDraining) {
        await new Promise((resolve) => {
          if (!this.output || typeof this.output.once !== "function") {
            return resolve();
          }
          this.output.once("drain", resolve);
        });
        this.isDraining = false;
      }

      const frame = this.queue.shift();
      const ok = writeMcpFrame(this.output, frame);
      if (!ok) {
        this.isDraining = true;
      }
    }
    this.isWriting = false;
  }

  /**
   * Sends a framed JSON-RPC payload to output via authorized writeMcpFrame.
   * @param {Object} payload
   */
  async sendFrame(payload) {
    const frameStr = JSON.stringify(payload) + "\n";
    this.queue.push(frameStr);
    if (!this.isWriting) {
      await this._flushQueue();
    }
  }

  /**
   * Reports progress for an active progressToken.
   * Coalesces rapid intermediate updates within a 150ms window (latest-wins).
   *
   * @param {string} progressToken
   * @param {number} progress
   * @param {number|null} [total=null]
   * @param {string|null} [message=null]
   */
  reportProgress(progressToken, progress, total = null, message = null) {
    if (!progressToken) return;

    let cappedMessage = undefined;
    if (message !== null && message !== undefined) {
      const msgStr = String(message);
      cappedMessage =
        msgStr.length > MAX_PROGRESS_MESSAGE_LENGTH
          ? msgStr.slice(0, MAX_PROGRESS_MESSAGE_LENGTH)
          : msgStr;
    }

    const params = {
      progressToken,
      progress,
    };
    if (total !== null && total !== undefined) params.total = total;
    if (cappedMessage !== undefined) params.message = cappedMessage;

    const payload = {
      jsonrpc: "2.0",
      method: "notifications/progress",
      params,
    };

    const isComplete = total !== null && total !== undefined && progress >= total;
    const existing = this.pending.get(progressToken);

    if (isComplete) {
      if (existing?.timer) clearTimeout(existing.timer);
      this.pending.delete(progressToken);
      this.sendFrame(payload);
      return;
    }

    if (!existing) {
      // First update in window: send immediately
      this.sendFrame(payload);
      const timer = setTimeout(() => {
        const current = this.pending.get(progressToken);
        if (current?.latestPayload) {
          this.sendFrame(current.latestPayload);
        }
        this.pending.delete(progressToken);
      }, this.coalesceMs);

      this.pending.set(progressToken, { timer, latestPayload: null });
    } else {
      // Intermediate update: save latest payload
      existing.latestPayload = payload;
    }
  }

  /**
   * Emits an MCP log notification frame (notifications/message).
   * Never calls raw console.log.
   *
   * @param {string} [level="info"] "info" | "warning" | "error" | "debug"
   * @param {string|Object} [data=""]
   * @param {string} [logger="jules-orchestrator"]
   */
  log(level = "info", data = "", logger = "jules-orchestrator") {
    const payload = {
      jsonrpc: "2.0",
      method: "notifications/message",
      params: {
        level,
        logger,
        data: typeof data === "string" ? data : JSON.stringify(data),
      },
    };
    return this.sendFrame(payload);
  }

  /**
   * Flushes all pending progress timers and ensures output queue is completely drained.
   */
  async flush() {
    for (const [token, item] of this.pending.entries()) {
      if (item.timer) clearTimeout(item.timer);
      if (item.latestPayload) {
        this.sendFrame(item.latestPayload);
      }
      this.pending.delete(token);
    }
    await this._flushQueue();
  }
}
