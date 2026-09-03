import { spawn } from "node:child_process";

const children = new Set();
let shuttingDown = false;

function start(command, args) {
  const child = spawn(command, args, {
    env: process.env,
    stdio: "inherit",
  });
  children.add(child);
  return child;
}

function stop(signal = "SIGTERM") {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) child.kill(signal);
  }
}

const api = start(process.execPath, ["scripts/mfa-local-api.mjs"]);
const web = start(process.execPath, [
  "node_modules/.bin/vinext",
  "start",
  "--hostname",
  "0.0.0.0",
  "--port",
  "3000",
]);

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => stop(signal));
}

for (const child of [api, web]) {
  child.on("exit", (code, signal) => {
    children.delete(child);
    if (!shuttingDown) {
      stop();
      process.exitCode = code ?? (signal ? 1 : 0);
    }
  });
}
