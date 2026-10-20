// Copies public Base Sepolia deployment manifests into the site's static assets.
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const publicDir = join(process.cwd(), "public");
const sourceDir = join(process.cwd(), "../../deployments/base-sepolia");
const outputDir = join(publicDir, "deployments");

rmSync(outputDir, { recursive: true, force: true });
if (existsSync(sourceDir)) {
  const manifests = readdirSync(sourceDir).filter((file) => file.endsWith(".manifest.json") && file !== "manifest.template.json");
  if (manifests.length > 0) {
    const destinationDir = join(outputDir, "base-sepolia");
    mkdirSync(destinationDir, { recursive: true });
    for (const file of manifests) cpSync(join(sourceDir, file), join(destinationDir, file));
  }
}
