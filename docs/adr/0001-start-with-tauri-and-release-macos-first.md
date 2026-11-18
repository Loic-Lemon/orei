# Start with Tauri and release macOS first

Start orei with Tauri 2, TypeScript, and Vite to reuse Pele and CSS tooling while avoiding a bundled browser engine. Electron's bundled runtime conflicts with the small-distribution goal; Swift with WKWebView remains a viable macOS alternative but would require a separate Windows shell.

Measure installed size and total app, webview, and helper-process memory in a representative release build before committing to the shell for release. Include React/Radix Themes (added in [ADR-0004](./0004-use-react-radix-themes-and-apple-hig.md)), the source/CSS editors, palette, required offline math renderer, and chosen icon resources in this assessment. This is a starting choice, not a claim that orei already meets a size or memory budget; workloads and acceptance thresholds remain to be settled.

Validate and release macOS first, preserve Windows compatibility, and add Windows build checks early. Treat Windows as experimental until editing, styling, saving, exports, clipboard behavior, and packaging have been tested there; compilation alone does not establish support.
