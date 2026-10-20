# Explainer assets

`islands/theme.css`, `islands/runtime.js` and `islands/chunks/*` were copied from the supplied local reference's packaged assets in `presentation-experiments/public/experiments/islands` on 2026-10-14. This is a local/private reuse of the user's reference material, not a published library distribution.

The stylesheet embeds IBM Plex Sans Condensed, IBM Plex Mono and Literata fonts as data URIs. Their OFL license notices are in `islands/licenses/`. The packaged Markdown and Mermaid dependencies have MIT notices beside them (`marked-LICENSE` and `beautiful-mermaid-LICENSE`).

`explainer-layout.css` adjusts the reading controls for these documents and adds a print view. It preserves the reference's theme tokens and typography.

The six SVG files are original explanatory diagrams for the conversation. They contain accessible titles/descriptions and use theme colors. HTML embeds them with unique IDs and the reference's zoom wrapper. Markdown refers to the same SVG assets. Their arrows and proposed/current meanings are stated in each document.

Prepared diagrams do not execute a live model, Portal operation, approval or VM request. The runtime only supplies reading interactions.
