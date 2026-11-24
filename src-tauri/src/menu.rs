//! Native application menu.
//!
//! The menu is installed through `Builder::menu`, before the first window exists, so macOS
//! always receives one app-wide menu bar rather than whatever the active window last set.
//! Menu ids are the IPC contract with the webview and must stay stable; the layout below is
//! the single source for both the native menu and the unit tests.

use std::collections::HashMap;
use std::sync::Mutex;

use tauri::menu::{Menu, MenuBuilder, MenuItem, PredefinedMenuItem, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Manager, Wry};

/// Handles for the menu items whose enabled state the webview commands drive.
/// `Menu::get` only searches top-level children, so nested File/Edit items cannot be found
/// through it; the handles are kept from the same `MenuItem` values the submenus use.
pub(crate) struct MenuItems {
    items: HashMap<&'static str, MenuItem<Wry>>,
}

impl MenuItems {
    pub(crate) fn set_enabled(&self, id: &str, enabled: bool) -> Result<(), String> {
        self.items
            .get(id)
            .ok_or_else(|| format!("Menu item {id} unavailable"))?
            .set_enabled(enabled)
            .map_err(|error| error.to_string())
    }
}

/// What selecting a native menu command does. Predefined items (Cut/Copy/Paste, Hide,
/// Services, Minimize, …) are handled by AppKit and never reach this mapping.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum MenuAction {
    Copy(&'static str),
    Document(&'static str),
    Edit(&'static str),
    Export,
    Quit,
    Settings,
}

impl MenuAction {
    fn webview_event(self) -> Option<(&'static str, Option<&'static str>)> {
        match self {
            Self::Copy(payload) => Some(("diagram-copy-request", Some(payload))),
            Self::Document(payload) => Some(("document-request", Some(payload))),
            Self::Edit(payload) => Some(("edit-request", Some(payload))),
            Self::Export => Some(("export-request", None)),
            Self::Quit => None,
            Self::Settings => Some(("settings-request", None)),
        }
    }
}

/// The single owner of every command id emitted to the webview. Quit deliberately closes
/// the main window instead of calling `app.exit`, so the close guard can save or recover
/// pending work before `exit_after_recovery` exits the process.
pub(crate) fn action(id: &str) -> Option<MenuAction> {
    match id {
        "copy-image" => Some(MenuAction::Copy("image")),
        "copy-svg" => Some(MenuAction::Copy("svg")),
        "copy-source" => Some(MenuAction::Copy("source")),
        "new-document" => Some(MenuAction::Document("new")),
        "open-document" => Some(MenuAction::Document("open")),
        "save" => Some(MenuAction::Document("save")),
        "save-as" => Some(MenuAction::Document("save-as")),
        "save-copy" => Some(MenuAction::Document("save-copy")),
        "close-document" => Some(MenuAction::Document("close")),
        "undo" => Some(MenuAction::Edit("undo")),
        "redo" => Some(MenuAction::Edit("redo")),
        "find" => Some(MenuAction::Edit("find")),
        "export" => Some(MenuAction::Export),
        "quit-orei" => Some(MenuAction::Quit),
        "settings" => Some(MenuAction::Settings),
        _ => None,
    }
}

/// Routes a native menu selection to the webview event contract, or to the guarded close.
pub(crate) fn on_menu_event(app: &AppHandle, id: &str) {
    let Some(action) = action(id) else { return };
    match action.webview_event() {
        Some((event, Some(payload))) => { let _ = app.emit(event, payload); }
        Some((event, None)) => { let _ = app.emit(event, ()); }
        None => {
            // With a live editor, let the webview flush saves and recovery before exiting.
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.close();
            } else {
                app.exit(0);
            }
        }
    }
}

/// One entry in a native submenu. Commands are custom items because their availability and
/// routing are controlled here; everything else keeps the platform's standard behaviour.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Entry {
    Command {
        id: &'static str,
        label: &'static str,
        accelerator: Option<&'static str>,
        enabled: bool,
    },
    Separator,
    About,
    Services,
    Hide,
    HideOthers,
    ShowAll,
    Cut,
    Copy,
    Paste,
    SelectAll,
    Minimize,
    Zoom,
    BringAllToFront,
}

const fn command(
    id: &'static str,
    label: &'static str,
    accelerator: Option<&'static str>,
    enabled: bool,
) -> Entry {
    Entry::Command {
        id,
        label,
        accelerator,
        enabled,
    }
}

pub(crate) struct SubmenuSpec {
    pub(crate) title: &'static str,
    /// Tauri recognises this exact id and registers the submenu as the macOS Window menu.
    pub(crate) id: Option<&'static str>,
    pub(crate) entries: &'static [Entry],
}

/// Conventional macOS order: application, File, Edit, Window. The application submenu
/// title is replaced by the app name on macOS; the name here keeps other platforms sane.
pub(crate) const LAYOUT: &[SubmenuSpec] = &[
    SubmenuSpec {
        title: "orei",
        id: None,
        entries: &[
            Entry::About,
            Entry::Separator,
            // Apple's menu-bar guidance puts Settings directly below About; Services and the
            // window/application commands follow in the usual order. Document save variants
            // sit with Settings in the app menu on macOS.
            command("settings", "Settings…", Some("CmdOrCtrl+,"), true),
            Entry::Separator,
            command("save-as", "Save As…", Some("CmdOrCtrl+Shift+S"), true),
            command("save-copy", "Save Copy…", None, true),
            Entry::Separator,
            Entry::Services,
            Entry::Separator,
            Entry::Hide,
            Entry::HideOthers,
            Entry::ShowAll,
            Entry::Separator,
            command("quit-orei", "Quit orei", Some("CmdOrCtrl+Q"), true),
        ],
    },
    SubmenuSpec {
        title: "File",
        id: None,
        entries: &[
            command("new-document", "New", Some("CmdOrCtrl+N"), true),
            command("open-document", "Open…", Some("CmdOrCtrl+O"), true),
            command("save", "Save", Some("CmdOrCtrl+S"), true),
            Entry::Separator,
            command("close-document", "Close Document", Some("CmdOrCtrl+W"), true),
            Entry::Separator,
            command("export", "Export…", Some("CmdOrCtrl+Shift+E"), false),
            Entry::Separator,
            command("copy-image", "Copy Diagram Image", None, false),
            command("copy-svg", "Copy Diagram SVG", None, false),
            command("copy-source", "Copy Mermaid Source", None, true),
        ],
    },
    SubmenuSpec {
        title: "Edit",
        id: None,
        entries: &[
            command("undo", "Undo", Some("CmdOrCtrl+Z"), false),
            command("redo", "Redo", Some("CmdOrCtrl+Shift+Z"), false),
            Entry::Separator,
            Entry::Cut,
            Entry::Copy,
            Entry::Paste,
            Entry::SelectAll,
            Entry::Separator,
            command("find", "Find…", Some("CmdOrCtrl+F"), true),
        ],
    },
    SubmenuSpec {
        title: "Window",
        id: Some(tauri::menu::WINDOW_SUBMENU_ID),
        entries: &[
            Entry::Minimize,
            Entry::Zoom,
            Entry::Separator,
            Entry::BringAllToFront,
        ],
    },
];

fn predefined(app: &AppHandle, entry: &Entry) -> tauri::Result<PredefinedMenuItem<Wry>> {
    Ok(match entry {
        Entry::Separator => PredefinedMenuItem::separator(app)?,
        Entry::About => PredefinedMenuItem::about(app, None, None)?,
        Entry::Services => PredefinedMenuItem::services(app, None)?,
        Entry::Hide => PredefinedMenuItem::hide(app, None)?,
        Entry::HideOthers => PredefinedMenuItem::hide_others(app, None)?,
        Entry::ShowAll => PredefinedMenuItem::show_all(app, None)?,
        Entry::Cut => PredefinedMenuItem::cut(app, None)?,
        Entry::Copy => PredefinedMenuItem::copy(app, None)?,
        Entry::Paste => PredefinedMenuItem::paste(app, None)?,
        Entry::SelectAll => PredefinedMenuItem::select_all(app, None)?,
        Entry::Minimize => PredefinedMenuItem::minimize(app, None)?,
        Entry::Zoom => PredefinedMenuItem::maximize(app, None)?,
        Entry::BringAllToFront => PredefinedMenuItem::bring_all_to_front(app, None)?,
        Entry::Command { .. } => unreachable!("commands are built as menu items"),
    })
}

/// Builds the app-wide menu and retains the item handles the webview commands toggle.
pub(crate) fn build(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let mut items = HashMap::new();
    let mut menu = MenuBuilder::new(app);
    for spec in LAYOUT {
        let mut submenu = SubmenuBuilder::new(app, spec.title);
        if let Some(id) = spec.id {
            submenu = submenu.id(id);
        }
        for entry in spec.entries {
            submenu = match entry {
                Entry::Command {
                    id,
                    label,
                    accelerator,
                    enabled,
                } => {
                    let item = MenuItem::with_id(app, *id, *label, *enabled, *accelerator)?;
                    items.insert(*id, item.clone());
                    submenu.item(&item)
                }
                predefined_entry => submenu.item(&predefined(app, predefined_entry)?),
            };
        }
        menu = menu.item(&submenu.build()?);
    }
    app.manage(Mutex::new(MenuItems { items }));
    menu.build()
}

#[cfg(test)]
mod tests {
    use super::{action, Entry, MenuAction, LAYOUT, SubmenuSpec};

    fn submenu(title: &str) -> &'static SubmenuSpec {
        LAYOUT
            .iter()
            .find(|spec| spec.title == title)
            .unwrap_or_else(|| panic!("{title} submenu missing"))
    }

    fn command_id(entry: &Entry) -> Option<&'static str> {
        match entry {
            Entry::Command { id, .. } => Some(*id),
            _ => None,
        }
    }

    fn find_command(id: &str) -> &'static Entry {
        LAYOUT
            .iter()
            .flat_map(|spec| spec.entries)
            .find(|entry| command_id(entry) == Some(id))
            .unwrap_or_else(|| panic!("{id} command missing"))
    }

    fn accelerator(id: &str) -> Option<&'static str> {
        match find_command(id) {
            Entry::Command { accelerator, .. } => *accelerator,
            _ => unreachable!(),
        }
    }

    fn enabled(id: &str) -> bool {
        match find_command(id) {
            Entry::Command { enabled, .. } => *enabled,
            _ => unreachable!(),
        }
    }

    #[test]
    fn menu_is_app_file_edit_window_in_conventional_order() {
        let titles: Vec<_> = LAYOUT.iter().map(|spec| spec.title).collect();
        assert_eq!(titles, ["orei", "File", "Edit", "Window"]);
    }

    #[test]
    fn application_menu_is_the_regular_app_menu_with_guarded_quit() {
        let entries = submenu("orei").entries;
        let position = |wanted: Entry| {
            entries
                .iter()
                .position(|entry| *entry == wanted)
                .unwrap_or_else(|| panic!("{wanted:?} missing from the application menu"))
        };
        assert_eq!(entries.first(), Some(&Entry::About));
        assert_eq!(command_id(&entries[1]), None, "About must be followed by its separator");
        assert_eq!(command_id(&entries[2]), Some("settings"));
        assert!(position(Entry::About) < position(Entry::Services));
        assert!(position(Entry::Services) < position(Entry::Hide));
        assert!(position(Entry::Hide) < position(Entry::HideOthers));
        assert!(position(Entry::HideOthers) < position(Entry::ShowAll));
        assert_eq!(entries.last().and_then(|entry| command_id(entry)), Some("quit-orei"));
        // Quit must stay a command: the predefined quit item terminates in AppKit and
        // would bypass the close guard's save/recovery step.
        assert_eq!(action("quit-orei"), Some(MenuAction::Quit));
        assert_eq!(accelerator("quit-orei"), Some("CmdOrCtrl+Q"));
        assert_eq!(action("settings"), Some(MenuAction::Settings));
        assert_eq!(accelerator("settings"), Some("CmdOrCtrl+,"));
        assert_eq!(action("settings").and_then(MenuAction::webview_event), Some(("settings-request", None)));
    }

    #[test]
    fn save_variants_are_unique_commands_near_settings_in_the_application_menu() {
        let app = submenu("orei").entries;
        let file = submenu("File").entries;
        let ids = |entries: &[Entry]| {
            entries
                .iter()
                .filter_map(command_id)
                .collect::<Vec<_>>()
        };

        assert!(ids(app).contains(&"save-as"));
        assert!(ids(app).contains(&"save-copy"));
        assert!(!ids(file).contains(&"save-as"));
        assert!(!ids(file).contains(&"save-copy"));
        assert!(ids(file).contains(&"save"), "ordinary Save must remain in File");

        let settings = app
            .iter()
            .position(|entry| command_id(entry) == Some("settings"))
            .expect("Settings missing from the application menu");
        assert_eq!(app[settings + 1], Entry::Separator);
        assert_eq!(command_id(&app[settings + 2]), Some("save-as"));
        assert_eq!(command_id(&app[settings + 3]), Some("save-copy"));
        assert_eq!(app[settings + 4], Entry::Separator);

        assert_eq!(action("save-as"), Some(MenuAction::Document("save-as")));
        assert_eq!(action("save-copy"), Some(MenuAction::Document("save-copy")));
        assert_eq!(accelerator("save-as"), Some("CmdOrCtrl+Shift+S"));
        assert_eq!(accelerator("save-copy"), None);
        assert!(enabled("save-as"));
        assert!(enabled("save-copy"));
    }

    #[test]
    fn file_menu_keeps_the_existing_ipc_command_shortcuts() {
        assert_eq!(accelerator("new-document"), Some("CmdOrCtrl+N"));
        assert_eq!(accelerator("open-document"), Some("CmdOrCtrl+O"));
        assert_eq!(accelerator("save"), Some("CmdOrCtrl+S"));
        assert_eq!(accelerator("save-as"), Some("CmdOrCtrl+Shift+S"));
        assert_eq!(accelerator("save-copy"), None);
        assert_eq!(accelerator("close-document"), Some("CmdOrCtrl+W"));
        assert_eq!(accelerator("export"), Some("CmdOrCtrl+Shift+E"));
        for id in ["copy-image", "copy-svg", "copy-source"] {
            assert_eq!(accelerator(id), None, "{id} must not steal text editing shortcuts");
        }
        assert_eq!(action("close-document"), Some(MenuAction::Document("close")));
    }

    #[test]
    fn edit_menu_keeps_native_text_editing_and_existing_shortcuts() {
        let edit = submenu("Edit");
        for item in [Entry::Cut, Entry::Copy, Entry::Paste, Entry::SelectAll] {
            assert!(edit.entries.contains(&item), "{item:?} must use the native item");
        }
        assert_eq!(accelerator("undo"), Some("CmdOrCtrl+Z"));
        assert_eq!(accelerator("redo"), Some("CmdOrCtrl+Shift+Z"));
        assert_eq!(accelerator("find"), Some("CmdOrCtrl+F"));
    }

    #[test]
    fn window_menu_is_registered_with_tauri_and_uses_conventional_items() {
        let window = submenu("Window");
        assert_eq!(window.id, Some(tauri::menu::WINDOW_SUBMENU_ID));
        for item in [Entry::Minimize, Entry::Zoom, Entry::BringAllToFront] {
            assert!(window.entries.contains(&item), "{item:?} missing from Window");
        }
    }

    #[test]
    fn command_ids_map_to_the_frontend_event_payload_contract() {
        for (id, payload) in [("copy-image", "image"), ("copy-svg", "svg"), ("copy-source", "source")] {
            assert_eq!(action(id).and_then(MenuAction::webview_event), Some(("diagram-copy-request", Some(payload))));
        }
        for (id, payload) in [("new-document", "new"), ("open-document", "open"), ("save", "save"), ("save-as", "save-as"), ("save-copy", "save-copy"), ("close-document", "close")] {
            assert_eq!(action(id).and_then(MenuAction::webview_event), Some(("document-request", Some(payload))));
        }
        for (id, payload) in [("undo", "undo"), ("redo", "redo"), ("find", "find")] {
            assert_eq!(action(id).and_then(MenuAction::webview_event), Some(("edit-request", Some(payload))));
        }
        assert_eq!(action("export").and_then(MenuAction::webview_event), Some(("export-request", None)));
        assert_eq!(action("quit-orei"), Some(MenuAction::Quit));
    }

    #[test]
    fn every_command_id_has_exactly_one_action_and_unknown_ids_do_nothing() {
        let commands: Vec<_> = LAYOUT
            .iter()
            .flat_map(|spec| spec.entries)
            .filter_map(|entry| match entry {
                Entry::Command { id, .. } => Some(*id),
                _ => None,
            })
            .collect();
        for id in &commands {
            assert!(action(id).is_some(), "{id} has no action");
        }
        assert_eq!(
            commands.len(),
            commands.iter().collect::<std::collections::HashSet<_>>().len(),
            "command ids must be unique"
        );
        for id in ["", "copy_image", "Export", "quit", "window-close"] {
            assert_eq!(action(id), None, "{id} must not be routed");
        }
    }

    #[test]
    fn guarded_items_start_in_the_states_the_frontend_commands_drive() {
        assert!(!enabled("export"));
        assert!(!enabled("copy-image"));
        assert!(!enabled("copy-svg"));
        assert!(enabled("copy-source"));
        assert!(!enabled("undo"));
        assert!(!enabled("redo"));
        assert!(enabled("find"));
    }
}
