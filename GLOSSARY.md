# orei

orei ("O Rei") is a local diagram editor for authoring text-based diagrams and styling their appearance through Pele.

## Language

**Diagram source**:
The Mermaid text that defines a diagram's content and relationships.
_Avoid_: Diagram code

**Diagram stylesheet**:
The CSS that controls a diagram's appearance.
_Avoid_: App theme

**Diagram document**:
One editable diagram consisting of its diagram source and diagram stylesheet.
_Avoid_: Rendered image

**Paired document**:
A diagram document stored as a same-basename `.mmd` diagram source, an optional `.css` stylesheet companion, and an optional `<stem>.orei-assets.json` asset index. A missing stylesheet companion opens with in-memory defaults and is not created until the stylesheet is edited.

**Paired asset index**:
The adjacent JSON file that carries a paired document's custom icon definitions and embedded local images, so reopening does not depend on the original import library or image files. It records a format and version plus typed, encoded entries; malformed indexes are refused rather than rewritten.

**Markdown note**:
One `.md` file holding a single Mermaid fenced block, a marked CSS block, and an optional `<!-- orei:assets:v1 {...} -->` manifest. It opens as one diagram document.

**Attachments folder**:
The user-approved folder that holds a Markdown note's sidecar files: images, custom icons, and an external stylesheet when the note has one. The note's manifest records each path relative to the note; the folder is read-only until the user approves it for writing in that session.

**Preview**:
The rendered view of the diagram document being edited.

**Palette panel**:
The visual controls for editing a diagram's theme colors.

**Icon library**:
The locally available collection of named icons, supplied by bundled packs or imported SVG files and Iconify JSON collections.

**Document asset**:
An icon definition or local image used by a diagram document, carried with that document for rendering and sharing.

**Untitled draft**:
A diagram document that has not yet been assigned a filename and format, retained locally so it can be recovered.

**Fixed preview**:
A view of the diagram whose composition stays the same when the viewing area is resized, with zoom and pan for navigation.

**Responsive preview**:
A view of the diagram whose composition adapts to the width of the viewing area. The preview auto-fits the pane width until a manual zoom takes over.

**Diagram export**:
A rendered diagram prepared for use outside orei, distinct from the editable diagram document.
