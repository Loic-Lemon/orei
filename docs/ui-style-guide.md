# orei UI style guide

Foundation: [React + Radix Themes + Apple HIG](./adr/0004-use-react-radix-themes-and-apple-hig.md). This guide styles the application interface. Diagram colors and fonts belong to the document stylesheet.

The foundation is confirmed. The visual defaults below are initial design decisions to validate in the first build, rather than a claim that a finished interface has been tested.

## Theme defaults

| Setting | Starting value | Purpose |
| --- | --- | --- |
| Accent | Radix `blue` | Primary actions, focus, and selected controls |
| Neutral scale | Radix `slate` | Quiet surfaces, borders, and text |
| Radius | `small` | Consistent, restrained control geometry |
| Scaling | `100%` | Keep the supplied proportions; choose compact component sizes locally |
| Panel background | `solid` | Predictable surfaces for long editing sessions |
| Appearance | System by default; explicit Light/Dark override | Respect the platform while retaining user control |
| Interface font | System UI stack | No remote font or required custom font download |
| Source font | Local monospace stack | Distinguish diagram/CSS text from controls |
| UI icons | Lucide | One consistent command-icon family |

Use a shared Radix `Theme` configuration rather than repeating colors, radii, and density decisions across views. [Theme configuration](https://www.radix-ui.com/themes/docs/theme/overview), [radius](https://www.radix-ui.com/themes/docs/theme/radius).

## Typography and spacing

- Start with Radix text size `2` for controls and body copy, `1` for secondary status text, and `3` for compact section headings. Use weight to clarify hierarchy before introducing a larger type size.
- Keep source text independently readable; start at 14 px with a comfortable editor line height. Avoid using a monospace font for the whole interface.
- Use the Radix spacing scale. Prefer steps `1`/`2` within control groups, `3`/`4` between related groups, and `4`/`5` for panel/dialog padding. Avoid unrelated pixel values for each screen.
- Use the supplied control sizes, initially size `2` for fields/buttons and size `1` only for genuinely secondary compact controls. Keep hit areas, labels, and focus indicators usable at narrow window sizes.

Radix defines coordinated typography and spacing scales and supports system fonts. These choices select from those scales for orei; they are not upstream mandates. [Typography](https://www.radix-ui.com/themes/docs/theme/typography), [spacing](https://www.radix-ui.com/themes/docs/theme/spacing).

## Component rules

- Use Radix components for ordinary buttons, fields, switches, menus, dialogs, tooltips, and segmented controls. Prefer their props and theme tokens over overrides of internal selectors.
- Use solid buttons for the main action in a dialog, soft/outline variants for supporting actions, and quiet buttons for routine toolbar commands. Reserve destructive treatment for actions that actually discard or replace data.
- Build document tabs with close controls, save/conflict indicators, and overflow behavior using the same tokens. A generic content tab is not the complete document-tab interaction.
- Keep the split editor/preview layout simple. The left pane switches between Diagram and Styling; Styling contains the CSS editor and a collapsible palette. No inspector is part of v1.
- Avoid decorative cards around every region. Use shared panel surfaces and separators for the persistent editing workspace; use shadows mainly for floating surfaces.

These rules follow Radix's supported customization approach. [Styling guidance](https://www.radix-ui.com/themes/docs/overview/styling).

## States and feedback

- Define default, hover, pressed, selected, focus-visible, disabled, pending, and error states wherever applicable. Selected and keyboard-focused are different states.
- Show autosave status with a short label and, where useful, an icon. Saving, saved, failed, and conflicted must remain understandable without color alone.
- Mark an invalid-source preview as out of date and place the diagnostic near its source. Disable unavailable rendered-export commands with an explanation; preserve source editing and recovery.
- Label color controls with their variable/name and editable value. Display a swatch as supporting information, not the sole label.
- Name icon-only commands accessibly and supply tooltips. Respect reduced-motion preferences; avoid animation that delays routine editing.

## Desktop behavior

- Use Tauri's native application menus and native open/save dialogs. Use Radix dialogs for application-specific preferences, imports, and conflict choices.
- Preserve standard New/Open/Save/Close/Undo/Redo/Find/Preferences/Quit conventions. Use Command on macOS and the appropriate Windows conventions when that platform is validated.
- Keep native menu actions and toolbar actions connected to the same document commands so their availability agrees.
- Support keyboard access, visible focus, Escape dismissal, and focus restoration after dialogs. Restore focus to the initiating control or a sensible surviving target.
- Keep split panes resizable and content usable at compact widths. Fixed preview composition remains fixed as its viewing area changes.

Apple's guidance informs these behaviors; the webview implementation still needs validation. [macOS design](https://developer.apple.com/design/human-interface-guidelines/designing-for-macos), [keyboard conventions](https://developer.apple.com/design/human-interface-guidelines/keyboards), [Tauri menus](https://v2.tauri.app/learn/window-menu/).

## Theme isolation and offline use

- Resolve System/Light/Dark explicitly; switching app appearance must not change a document's colors. Author-written media queries in the document CSS remain intentional document behavior.
- Keep application theme tokens, CSS resets, font inheritance, and overlay styling from leaking into the preview. Diagram CSS must likewise stay inside its rendering scope.
- Scope the source editor's syntax theme separately from the diagram stylesheet.
- Bundle all required styles and icons. Do not copy demo CDN imports, remote fonts, or image URLs into the shipped app.
- Use the supplied light/dark scales consistently and verify contrast and focus in both appearances; a library choice alone does not establish accessibility in WKWebView or WebView2.

[Radix appearance integration](https://www.radix-ui.com/themes/docs/theme/dark-mode).

## Visual review

Check one representative workspace and its export dialog, preferences, icon import, and file-conflict state in both light and dark appearances. Review readability, keyboard navigation, focus restoration, compact sizing, and unchanged diagram colors. Measure the actual release build; this guide does not establish a RAM or bundle-size result.
