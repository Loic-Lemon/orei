# Use React, Radix Themes, and Apple HIG

Use React with Radix Themes for orei's application interface, and Apple's Human Interface Guidelines for macOS interaction conventions. The owner selected this approach after comparing packaged Radix styling with shadcn/ui's copied component source and React Aria's unstyled controls.

Radix Themes provides a coordinated visual system without requiring Tailwind or maintaining copied component styling. Use its supported props and tokens, and build custom document controls from those same tokens when necessary. React is now an explicit addition to the Tauri, TypeScript, and Vite baseline; it was not implied by that earlier choice.

Keep the app theme separate from diagram CSS. Follow platform conventions for menus, shortcuts, focus, and native file dialogs rather than treating a web component as a native OS control. The [UI style guide](../ui-style-guide.md) records orei's starting visual defaults; those defaults can be tuned during the first build without changing this foundation.

Include React and the selected controls in the early release-build size and process-memory assessment. Their footprint and embedded-webview accessibility have not yet been measured for orei.
