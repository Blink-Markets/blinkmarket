import { AudienceSeg } from "./AudienceSeg";
import { ThemeToggle } from "./ThemeToggle";

export function AudienceBar() {
  return (
    <div className="docs-audience">
      <AudienceSeg />
      <p>Layered guides with copyable commands and prompts.</p>
      <ThemeToggle />
    </div>
  );
}
