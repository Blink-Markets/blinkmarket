import { spawn } from "node:child_process";

/** Own the whole detached group, including when the launcher is interrupted or exits. */
export function runProcessGroup(args: string[], env: NodeJS.ProcessEnv = process.env, hardTimeoutMs = 28 * 60_000) {
  return new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    let output = "";
    let closed = false;
    let exitCode: number | null = null;
    let failure: Error | undefined;
    let cleanup: NodeJS.Timeout | undefined;
    let killStarted: number | undefined;
    let cleanupTimedOut = false;
    const groupExists = () => {
      if (child.pid === undefined) return false;
      try { process.kill(-child.pid, 0); return true; } catch { return false; }
    };
    const killGroup = (signal: NodeJS.Signals) => {
      if (child.pid === undefined) return;
      try { process.kill(-child.pid, signal); } catch { /* the process group has already exited */ }
    };
    const unregister = () => {
      clearTimeout(timeout);
      clearInterval(cleanup);
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
      process.off("exit", onExit);
    };
    const check = () => {
      if (!groupExists()) {
        if (closed) {
          unregister();
          if (failure) reject(failure); else resolve({ code: exitCode, output });
        }
        return;
      }
      if (!cleanupTimedOut && killStarted !== undefined && Date.now() - killStarted >= 2000) {
        cleanupTimedOut = true;
        cleanup?.unref();
        reject(new Error("PROCESS_GROUP_CLEANUP_TIMEOUT"));
      }
    };
    const terminate = (signal: NodeJS.Signals) => {
      killGroup(signal);
      if (cleanup) return;
      clearTimeout(timeout);
      const graceStarted = Date.now();
      cleanup = setInterval(() => {
        if (killStarted === undefined && Date.now() - graceStarted >= 10_000) {
          killGroup("SIGKILL");
          killStarted = Date.now();
        }
        check();
      }, 100);
      check();
    };
    const onSigint = () => { process.exitCode = 130; terminate("SIGINT"); };
    const onSigterm = () => { process.exitCode = 143; terminate("SIGTERM"); };
    const onExit = () => killGroup("SIGKILL");
    process.on("SIGINT", onSigint);
    process.on("SIGTERM", onSigterm);
    process.once("exit", onExit);
    const timeout = setTimeout(() => terminate("SIGTERM"), hardTimeoutMs);
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.once("error", (error) => { failure = error; terminate("SIGTERM"); });
    child.once("close", (code) => {
      closed = true;
      exitCode = code;
      terminate("SIGTERM");
    });
  });
}
