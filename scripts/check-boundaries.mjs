import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import ts from "typescript";
const allowed = {
  schemas: [],
  domain: ["schemas"],
  ports: ["schemas", "domain"],
  application: ["schemas", "domain", "ports"],
  adapters: ["schemas", "ports"],
  runtime: [],
  client: ["schemas"],
};
function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)],
  );
}
const errors = [];
for (const [name, dependencies] of Object.entries(allowed)) {
  const pkg = JSON.parse(readFileSync(`packages/${name}/package.json`, "utf8"));
  for (const dep of Object.keys(pkg.dependencies ?? {})) {
    if (dep.startsWith("@blink/") && !dependencies.includes(dep.slice(7)))
      errors.push(`${name} -> ${dep}`);
  }
  for (const path of files(`packages/${name}/src`).filter((p) =>
    /\.ts$/.test(p),
  )) {
    const source = readFileSync(path, "utf8");
    for (const match of source.matchAll(
      /(?:from\s*|import\s*\(?)["']([^"']+)["']/g,
    )) {
      const dep = match[1];
      // These packages expose TS source to the web bundler, not emitted JS.
      // Node/tsx can remap .js to .ts, but the current Turbopack config does not.
      if (
        ["domain", "schemas", "client"].includes(name) &&
        dep.startsWith(".") && dep.endsWith(".js") &&
        !existsSync(join(dirname(path), dep)) &&
        existsSync(join(dirname(path), dep.slice(0, -3) + ".ts"))
      )
        errors.push(`${path}: source-exported package must reference the actual .ts file: ${dep}`);
      if (dep.startsWith("@blink/") && !dependencies.includes(dep.slice(7)))
        errors.push(`${path} -> ${dep}`);
      if (dep.includes("/apps/") || dep.includes("../.."))
        errors.push(`${path}: cross-package relative import ${dep}`);
      if (
        ["domain", "schemas", "ports"].includes(name) &&
        /^(fastify|next|pg|viem|node:)/.test(dep)
      )
        errors.push(`${path}: infrastructure leak ${dep}`);
    }
  }
}
for (const name of ["web", "worker"]) {
  const pkg = JSON.parse(readFileSync(`apps/${name}/package.json`, "utf8"));
  if (Object.keys(pkg.dependencies ?? {}).some((d) => d.includes("signer")))
    errors.push(`${name}: signer dependency`);
}
// Reference agents stand in for outside developers: public surfaces only (spec section 8).
if (existsSync("examples/agents/src")) {
  const root = resolve("examples/agents") + sep;
  const publicImport = /^(@blink\/client(\/templates\/gm-lt-v1)?|viem(\/.*)?|node:.*)$/;
  for (const path of files("examples/agents/src").filter((p) => /\.[cm]?[jt]sx?$/.test(p))) {
    const source = readFileSync(path, "utf8");
    // The TypeScript scanner finds every static import and export, `import()` and `require()` the
    // way the compiler does, whatever the spacing, comments or file extension.
    for (const { fileName: dep } of ts.preProcessFile(source, true, true).importedFiles) {
      const inside = dep.startsWith(".") && (resolve(dirname(path), dep) + sep).startsWith(root);
      if (!inside && !publicImport.test(dep))
        errors.push(`${path}: an example may import only @blink/client, viem, node:* and its own files, not ${dep}`);
    }
    for (const forbidden of ["contracts/out", "packages/", "apps/"])
      if (source.includes(forbidden))
        errors.push(`${path}: an example must not name ${forbidden}`);
    if (/\bparseAbi\s*\(/.test(source))
      errors.push(`${path}: an example takes its ABIs from agentAbi, not parseAbi`);
  }
}
if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log(
  "Package dependency boundaries passed (static import/manifest check, not a security sandbox).",
);
