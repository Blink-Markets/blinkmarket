import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
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
if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log(
  "Package dependency boundaries passed (static import/manifest check, not a security sandbox).",
);
