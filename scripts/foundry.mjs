import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
export function foundryBinary(tool) {
  if (!["forge", "anvil"].includes(tool))
    throw new Error("Unknown Foundry tool");
  const require = createRequire(import.meta.url);
  const local = createRequire(
    require.resolve(`@foundry-rs/${tool}/package.json`),
  );
  const arch = process.arch === "x64" ? "amd64" : process.arch;
  return local.resolve(
    `@foundry-rs/${tool}-${process.platform}-${arch}/bin/${tool}${process.platform === "win32" ? ".exe" : ""}`,
  );
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const child = spawn(foundryBinary(process.argv[2]), process.argv.slice(3), {
    stdio: "inherit",
  });
  child.once("error", (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
  child.once("exit", (code, signal) => {
    process.exitCode = code ?? (signal ? 1 : 0);
  });
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, () => child.kill(signal));
}
