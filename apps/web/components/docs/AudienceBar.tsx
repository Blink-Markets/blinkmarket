import Link from "next/link";
import { ThemeToggle } from "./ThemeToggle";

export function AudienceBar() {
  return (
    <div className="docs-audience">
      <nav className="docs-seg" aria-label="Audience">
        <Link href="/docs">For humans</Link>
        <Link href="/docs/agents">For agents</Link>
      </nav>
      <p>Layered guides with copyable commands and prompts.</p>
      <ThemeToggle />
    </div>
  );
}
