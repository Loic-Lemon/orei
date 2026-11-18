---
status: deprecated
---

# Preserve CSS rule scope in the inspector

The inspector was deferred from v1 during discovery on 2026-11-12. The design below records the earlier discussion and is not an active v1 requirement. Live CSS editing and the palette remain in scope, with separate Mermaid and styling undo histories. Revisit this design if an inspector is added later.

## Earlier design

The style inspector edits diagram stylesheet rules with their existing scope: changing a shared rule changes every matching diagram element. A change intended for one element requires an explicit individual override, rather than silently narrowing a shared rule's selector.

This preserves the meaning of the user's CSS across the text editor and interactive controls. Inspector edits must be reflected in the live CSS editor.

After selecting a diagram element, the Styling view shows its effective values and matching document CSS rules. The user chooses which matching rule to edit or explicitly adds an individual override. CSS text, palette changes, and inspector changes share a styling undo history; Mermaid source has a separate undo history. Cascade handling and creation of stable individual selectors remain to be resolved.
