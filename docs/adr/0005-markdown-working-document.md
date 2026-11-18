# Use Markdown as the default working document

Status: accepted. Supersedes ADR-0002 for the default and required formats.

One `.md` note is the default working document, containing one standard Mermaid fenced block and an embedded, explicitly marked CSS block. Obsidian can edit the note and render the Mermaid; orei applies the full stylesheet. An Obsidian CSS plugin is deferred. The existing `.orei` implementation is retained, but `.orei` is not a required default or a third mandatory format. Retain the paired Mermaid/CSS workflow where its ordinary-tool interoperability remains useful.

The CSS block is exactly `<!-- orei:css:start -->`, followed by a `css` fenced block, then `<!-- orei:css:end -->`, each on its own line. New notes use triple backticks; a writer must use a sufficiently long fence if content contains closing-fence sequences. The markers must occur once and wrap exactly one CSS fence. A note must contain exactly one Mermaid fence outside the CSS block. Absent, duplicated, malformed or ambiguous markers or diagram fences require a diagnostic and no automatic rewrite; never guess which content belongs to orei. New notes include an empty marked CSS block when necessary.

Edits replace only the selected Mermaid and CSS contents, retaining fence delimiters, line endings, frontmatter, surrounding Markdown, and all unrelated content byte-for-byte. If safe boundaries or encoding cannot be established, do not save over the note. Opening alone never modifies it.

Markdown does not itself guarantee portable icons or images. Preserve references and existing assets; report missing or unsupported resources and block any operation that would discard them. Do not claim self-contained portability until a safe, specified asset representation exists. Conversion must retain the original and recovery on failure.
