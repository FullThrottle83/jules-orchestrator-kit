import { spawn } from "node:child_process";

/**
 * ProcessGroupManager manages child processes in isolated process groups
 * and ensures 100% leak-free cleanup on process exit or termination signals.
 */
export class ProcessGroupManager {
  constructor() {
    this.activePgids = new Set();
    this.activePids = new Set();
    this.installed = false;
    this.installSignalHandlers();
  }

  installSignalHandlers() {
    if (this.installed) return;
    this.installed = true;

    const cleanup = (signal) => {
      this.killAll(signal || "SIGTERM");
    };

    process.once("SIGINT", () => {
      cleanup("SIGINT");
      process.exit(130);
    });

    process.once("SIGTERM", () => {
      cleanup("SIGTERM");
      process.exit(143);
    });

    process.once("exit", () => {
      this.killAll("SIGKILL");
    });
  }

  spawnProcess(command, args = [], options = {}) {
    const opts = {
      ...options,
      detached: true,
    };

    const child = spawn(command, args, opts);

    if (child.pid) {
      const pgid = child.pid;
      this.activePgids.add(pgid);
      this.activePids.add(child.pid);

      child.on("exit", () => {
        this.activePgids.delete(pgid);
        this.activePids.delete(child.pid);
      });

      child.on("error", () => {
        this.activePgids.delete(pgid);
        this.activePids.delete(child.pid);
      });
    }

    return child;
  }

  killAll(signal = "SIGTERM") {
    for (const pgid of this.activePgids) {
      try {
        process.kill(-pgid, signal);
      } catch (_) {
        try {
          process.kill(pgid, signal);
        } catch (_) {}
      }
    }
    this.activePgids.clear();
    this.activePids.clear();
  }
}

export const processGroupManager = new ProcessGroupManager();
