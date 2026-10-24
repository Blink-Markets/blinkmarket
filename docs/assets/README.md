# Architecture illustration source

Final asset: `architecture-sketch-light.png`, embedded in the root README.

The image was generated and edited with the built-in image_gen tool (not the CLI). The imagegen skill was used for the hand-drawn style, for checking labels and arrows, and for saving the asset into the workspace. The image shows only a simplified target architecture and does not mean the services are deployed. The original generated drafts stay in the tool's generated_images directory; the project keeps only the final white-background version.

## Initial prompt

```text
Use case: infographic-diagram.
Asset type: a single README architecture illustration for the Blink Market software repository.
Primary request: a SIMPLE hand-drawn sketch / doodle explaining the project's target architecture. This is an illustration, not a screenshot or polished corporate flowchart. Landscape roughly 3:2, generous white margins, white paper background, dark hand-inked wobbly outlines and arrows, modest pencil texture, sparse soft highlighter accents, highly legible large hand-lettered English labels. Friendly and technically clear, no decorative clutter or characters.
Top title verbatim: "Blink Market". Subtitle verbatim: "Target architecture".
Layout: left a browser sketch labeled "Web + Wallet" with small sublabel "Next.js". Center a large loosely drawn container labeled "Backend" and sublabel "TypeScript / Node.js". Inside it two small boxes: "API" with sublabel "Fastify", and "Worker" with sublabel "Research + jobs". Below that container a cylinder labeled "PostgreSQL" and next to it a folder labeled "Evidence". Right a separate chain-ledger sketch labeled "Base Sepolia" with exactly two contract names inside: "BlinkMarket" and "BlinkTestUSD", and sublabel "Funds + positions + settlement". Between Backend and chain, above the connecting paths, a small padlock box labeled "Private Signer" and sublabel "Policy checks". Below the chain a magnifying glass box labeled "Indexer" and sublabel "Events to DB".
Connections, exactly these conceptual directions: Web -> API arrow labeled "RFQ"; Backend -> PostgreSQL and Backend -> Evidence unlabeled short arrows; Backend -> Private Signer arrow labeled "Sign request"; Private Signer -> Backend arrow labeled "Signed quote" (two distinct arrows can be curved); Web + Wallet -> Base Sepolia as a long clearly routed TOP arc labeled "Wallet: fill / redeem"; Base Sepolia -> Indexer arrow labeled "Events"; Indexer -> PostgreSQL long BOTTOM arrow labeled "Sync". Avoid crossing labels with arrows. No direct arrow from Signer to chain, no model keys.
Bottom footnote verbatim, clear readable: "M0/M1 built locally. Service integration planned."
Constraints: fit complete drawing in canvas, no cropped nodes, no logos, no watermark, no code, no extra components, do not imply production deployment. Prioritize simple doodle explanation and readable labels over exhaustive detail.
```

## Final edit prompt

```text
Edit this architecture illustration ONLY to replace the entire dark/gray/black background outside the diagram shapes with flat solid opaque WHITE paper (#FFFFFF). Remove all dark gradients, glows and shadows. Preserve every word, every node, every arrow direction, every icon, layout and hand-drawn sketch strokes exactly as in the original. Preserve soft colored highlighter accents within nodes and under labels. Make all text dark charcoal ink for high contrast on the new white paper background. No other additions or changes. This is a clean, simple hand-drawn doodle diagram on uniformly white paper for a GitHub README.
```
