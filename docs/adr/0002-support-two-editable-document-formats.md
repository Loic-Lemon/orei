# Support two editable document formats

Superseded for default and required formats by [ADR-0005](0005-markdown-working-document.md); historical rationale follows.

Support both a single plain-text `.orei` document and companion Mermaid/CSS files as editable documents that orei can open and save. Use `.orei` by default and provide a preference to change the default format.

The single file keeps a diagram's source and stylesheet together for convenient handling, while the companion files support ordinary Mermaid and CSS tools. Both formats must preserve the diagram source and stylesheet when saved; the two-file representation is not merely an export.

Pair companion files by basename, such as `checkout.mmd` and `checkout.css`, with a stylesheet per diagram. This allows multiple diagrams in one directory without a shared `theme.css` collision.

Embed the used custom icons and local images in `.orei`; keep additional document assets in an adjacent assets folder for paired files. This makes the single-file format easier to share at the cost of larger files, while keeping the Mermaid and CSS representation usable with ordinary tools. The `.orei` syntax, treatment of missing companions, and any format-specific metadata remain proposed defaults pending the consolidated design review.
