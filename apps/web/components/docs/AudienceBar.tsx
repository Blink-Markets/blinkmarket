import { AudienceSeg } from "./AudienceSeg";
import { ThemeToggle } from "./ThemeToggle";

export function AudienceBar() {
  return (
    <div className="docs-audience">
      <AudienceSeg />
      <p>How Blink markets work, the roles, and prompts to hand to your agent.</p>
      <ThemeToggle />
    </div>
  );
}
