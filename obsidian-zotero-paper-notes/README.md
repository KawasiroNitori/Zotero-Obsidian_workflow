# Zotero Paper Notes

This Obsidian desktop plugin polls the Zotero Local API and creates a note for each newly added top-level Zotero item.

Defaults:

- Zotero API: `http://localhost:23119/api`
- Zotero library: `users/0`
- Template: `Templates/Paper Template.md`
- Note folder: vault root
- Polling interval: 15 seconds

Before use, enable Zotero's local API:

`Zotero Settings > Advanced > Allow other applications on this computer to communicate with Zotero`

The plugin fills these properties from Zotero:

- `author`
- `publishedIn`
- `year`
- `Created`
- `zoteroUri`

It also includes a command named `Create note from latest Zotero item` for manual testing.
