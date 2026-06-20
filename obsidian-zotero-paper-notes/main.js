const {
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  normalizePath,
  requestUrl,
} = require("obsidian");

const DEFAULT_SETTINGS = {
  zoteroBaseUrl: "http://localhost:23119/api",
  zoteroLibrary: "users/0",
  templatePath: "Templates/Paper Template.md",
  notesFolder: "",
  pollIntervalSeconds: 15,
  recentItemLimit: 20,
  autoOpenNewTab: true,
  installedAt: "",
  processedItemKeys: {},
};

const PAPER_ITEM_TYPES_TO_SKIP = new Set(["attachment", "note", "annotation"]);

module.exports = class ZoteroPaperNotesPlugin extends Plugin {
  async onload() {
    await this.loadSettings();
    await this.ensureInstalledAt();

    this.polling = false;
    this.noticeKeys = new Set();
    this.statusEl = this.addStatusBarItem();
    this.setStatus("Zotero: waiting");

    this.addCommand({
      id: "poll-zotero-now",
      name: "Check Zotero for new papers now",
      callback: () => this.pollZotero({ manual: true }),
    });

    this.addCommand({
      id: "create-note-from-latest-zotero-item",
      name: "Create note from latest Zotero item",
      callback: () => this.createNoteFromLatestItem(),
    });

    this.addSettingTab(new ZoteroPaperNotesSettingTab(this.app, this));

    this.app.workspace.onLayoutReady(() => {
      this.pollZotero({ startup: true });
      this.registerInterval(
        window.setInterval(
          () => this.pollZotero(),
          Math.max(5, Number(this.settings.pollIntervalSeconds) || 15) * 1000,
        ),
      );
    });
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.settings.processedItemKeys = this.settings.processedItemKeys || {};
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  async ensureInstalledAt() {
    if (!this.settings.installedAt) {
      this.settings.installedAt = new Date().toISOString();
      await this.saveSettings();
    }
  }

  setStatus(text) {
    if (this.statusEl) {
      this.statusEl.setText(text);
    }
  }

  async pollZotero(options = {}) {
    if (this.polling) {
      return;
    }

    this.polling = true;

    try {
      const items = await this.fetchRecentItems();
      this.setStatus("Zotero: connected");
      this.noticeKeys.delete("zotero-offline");
      this.noticeKeys.delete("zotero-forbidden");

      const candidates = items
        .filter((item) => this.isPaperItem(item))
        .filter((item) => this.isNewEnough(item))
        .filter((item) => !this.settings.processedItemKeys[item.key])
        .reverse();

      let createdCount = 0;
      for (const item of candidates) {
        const result = await this.createOrOpenNoteForItem(item, {
          openNote: this.settings.autoOpenNewTab,
        });
        if (result.created) {
          createdCount += 1;
        }
      }

      if (options.manual) {
        new Notice(
          createdCount > 0
            ? `Created ${createdCount} Zotero paper note(s).`
            : "No new Zotero papers found.",
        );
      }
    } catch (error) {
      this.handleZoteroError(error, Boolean(options.manual));
    } finally {
      this.polling = false;
    }
  }

  async createNoteFromLatestItem() {
    try {
      const items = await this.fetchRecentItems();
      const item = items.find((candidate) => this.isPaperItem(candidate));
      if (!item) {
        new Notice("No Zotero paper item was found.");
        return;
      }

      const result = await this.createOrOpenNoteForItem(item, { openNote: true });
      new Notice(
        result.created
          ? `Created note for: ${item.data.title}`
          : `Opened existing note for: ${item.data.title}`,
      );
    } catch (error) {
      this.handleZoteroError(error, true);
    }
  }

  async fetchRecentItems() {
    const baseUrl = trimTrailingSlash(this.settings.zoteroBaseUrl);
    const library = trimSlashes(this.settings.zoteroLibrary || "users/0");
    const limit = Math.max(1, Number(this.settings.recentItemLimit) || 20);
    const url =
      `${baseUrl}/${library}/items/top` +
      `?sort=dateAdded&direction=desc&limit=${encodeURIComponent(limit)}` +
      "&format=json&include=data";

    let response;
    try {
      response = await requestUrl({
        url,
        method: "GET",
        headers: {
          "Zotero-API-Version": "3",
        },
      });
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      throw new Error(`Zotero Local API is unavailable. ${message}`);
    }

    if (response.status === 403) {
      throw new Error(
        "Zotero Local API returned 403. Enable Zotero Settings > Advanced > Allow other applications on this computer to communicate with Zotero.",
      );
    }

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Zotero Local API returned HTTP ${response.status}.`);
    }

    return Array.isArray(response.json) ? response.json : [];
  }

  handleZoteroError(error, manual) {
    const message = error && error.message ? error.message : String(error);
    const isForbidden = message.includes("403");
    const key = isForbidden ? "zotero-forbidden" : "zotero-offline";
    const shortMessage = isForbidden
      ? "Zotero Local API is disabled."
      : "Zotero Local API is offline.";

    this.setStatus(shortMessage);

    if (manual || !this.noticeKeys.has(key)) {
      new Notice(message, 9000);
      this.noticeKeys.add(key);
    }
  }

  isPaperItem(item) {
    if (!item || !item.key || !item.data) {
      return false;
    }

    if (!item.data.title) {
      return false;
    }

    return !PAPER_ITEM_TYPES_TO_SKIP.has(item.data.itemType);
  }

  isNewEnough(item) {
    if (!item || !item.data || !item.data.dateAdded || !this.settings.installedAt) {
      return false;
    }

    const itemTime = Date.parse(item.data.dateAdded);
    const installedTime = Date.parse(this.settings.installedAt);

    if (!Number.isFinite(itemTime) || !Number.isFinite(installedTime)) {
      return false;
    }

    return itemTime >= installedTime;
  }

  async createOrOpenNoteForItem(item, options = {}) {
    const metadata = this.extractPaperMetadata(item);
    const existingFile = await this.findExistingNoteForZoteroUri(metadata.zoteroUri);

    if (existingFile) {
      await this.markItemProcessed(item.key);
      if (options.openNote) {
        await this.openFileInNewTab(existingFile);
      }
      return { created: false, file: existingFile };
    }

    const template = await this.readTemplate();
    const noteContent = this.renderNote(template, metadata);
    const path = await this.nextAvailablePath(metadata.title);
    const file = await this.app.vault.create(path, noteContent);

    await this.markItemProcessed(item.key);
    if (options.openNote) {
      await this.openFileInNewTab(file);
    }

    return { created: true, file };
  }

  extractPaperMetadata(item) {
    const data = item.data || {};
    const authors = (data.creators || [])
      .filter((creator) => creator.creatorType === "author")
      .map(formatCreatorName)
      .filter(Boolean);

    const fallbackCreators = authors.length
      ? authors
      : (data.creators || []).map(formatCreatorName).filter(Boolean);

    const publishedIn =
      data.publicationTitle ||
      data.proceedingsTitle ||
      data.bookTitle ||
      data.conferenceName ||
      data.publisher ||
      data.university ||
      "";

    return {
      title: data.title || item.key,
      authors: fallbackCreators,
      publishedIn,
      year: extractYear(data.date),
      created: formatDateLink(new Date()),
      zoteroUri: `zotero://select/library/items/${item.key}`,
    };
  }

  async readTemplate() {
    const path = normalizePath(this.settings.templatePath || DEFAULT_SETTINGS.templatePath);
    const file = this.app.vault.getAbstractFileByPath(path);

    if (file && file.extension === "md") {
      return this.app.vault.read(file);
    }

    new Notice(`Template not found: ${path}. Using a minimal paper template.`);
    return [
      "---",
      "aliases:",
      "author:",
      "hasTopic:",
      "project:",
      "publishedIn:",
      "year:",
      "Created:",
      "zoteroUri:",
      "---",
      "",
      "--- ",
      "#source/paper",
      "",
    ].join("\n");
  }

  renderNote(template, metadata) {
    const parts = splitFrontmatter(template);
    const frontmatter = renderMergedFrontmatter(parts.frontmatter, metadata);
    const body = stripTemplaterCursor(parts.body).replace(/^\s+/, "\n\n");
    return `${frontmatter}${body.endsWith("\n") ? body : `${body}\n`}`;
  }

  async nextAvailablePath(title) {
    await this.ensureNotesFolder();

    const folder = normalizePath(this.settings.notesFolder || "");
    const baseName = sanitizeFileName(title) || "Untitled";
    const prefix = folder ? `${folder}/` : "";

    let index = 0;
    while (true) {
      const suffix = index === 0 ? "" : ` ${index}`;
      const path = `${prefix}${baseName}${suffix}.md`;
      if (!this.app.vault.getAbstractFileByPath(path)) {
        return path;
      }
      index += 1;
    }
  }

  async ensureNotesFolder() {
    const folder = normalizePath((this.settings.notesFolder || "").trim());
    if (!folder) {
      return;
    }

    const parts = folder.split("/").filter(Boolean);
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      const existing = this.app.vault.getAbstractFileByPath(current);
      if (!existing) {
        await this.app.vault.createFolder(current);
      }
    }
  }

  async findExistingNoteForZoteroUri(zoteroUri) {
    const files = this.app.vault.getMarkdownFiles();

    for (const file of files) {
      const cache = this.app.metadataCache.getFileCache(file);
      const frontmatter = cache && cache.frontmatter;
      if (frontmatter && frontmatter.zoteroUri === zoteroUri) {
        return file;
      }
    }

    const needles = [
      `zoteroUri: ${zoteroUri}`,
      `zoteroUri: "${zoteroUri}"`,
      `zoteroUri: '${zoteroUri}'`,
    ];

    for (const file of files) {
      const content = await this.app.vault.cachedRead(file);
      if (needles.some((needle) => content.includes(needle))) {
        return file;
      }
    }

    return null;
  }

  async openFileInNewTab(file) {
    let leaf;
    try {
      leaf = this.app.workspace.getLeaf("tab");
    } catch (error) {
      leaf = this.app.workspace.getLeaf(true);
    }

    await leaf.openFile(file, { active: true });
  }

  async markItemProcessed(itemKey) {
    this.settings.processedItemKeys[itemKey] = new Date().toISOString();
    this.pruneProcessedItemKeys();
    await this.saveSettings();
  }

  pruneProcessedItemKeys() {
    const entries = Object.entries(this.settings.processedItemKeys || {});
    if (entries.length <= 1000) {
      return;
    }

    this.settings.processedItemKeys = Object.fromEntries(
      entries
        .sort((a, b) => String(b[1]).localeCompare(String(a[1])))
        .slice(0, 1000),
    );
  }
};

class ZoteroPaperNotesSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Zotero Local API base URL")
      .setDesc("Default: http://localhost:23119/api")
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.zoteroBaseUrl)
          .setValue(this.plugin.settings.zoteroBaseUrl)
          .onChange(async (value) => {
            this.plugin.settings.zoteroBaseUrl =
              value.trim() || DEFAULT_SETTINGS.zoteroBaseUrl;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Zotero library")
      .setDesc("Use users/0 for the local user's personal library.")
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.zoteroLibrary)
          .setValue(this.plugin.settings.zoteroLibrary)
          .onChange(async (value) => {
            this.plugin.settings.zoteroLibrary =
              value.trim() || DEFAULT_SETTINGS.zoteroLibrary;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Paper template path")
      .setDesc("Path inside this vault.")
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.templatePath)
          .setValue(this.plugin.settings.templatePath)
          .onChange(async (value) => {
            this.plugin.settings.templatePath =
              value.trim() || DEFAULT_SETTINGS.templatePath;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("New note folder")
      .setDesc("Leave blank to create paper notes in the vault root.")
      .addText((text) =>
        text
          .setPlaceholder("Papers")
          .setValue(this.plugin.settings.notesFolder)
          .onChange(async (value) => {
            this.plugin.settings.notesFolder = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Polling interval")
      .setDesc("Seconds between Zotero checks. Minimum: 5.")
      .addText((text) =>
        text
          .setPlaceholder(String(DEFAULT_SETTINGS.pollIntervalSeconds))
          .setValue(String(this.plugin.settings.pollIntervalSeconds))
          .onChange(async (value) => {
            const interval = Math.max(5, Number(value) || DEFAULT_SETTINGS.pollIntervalSeconds);
            this.plugin.settings.pollIntervalSeconds = interval;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Open created note in a new tab")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.autoOpenNewTab)
          .onChange(async (value) => {
            this.plugin.settings.autoOpenNewTab = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Reset first-run baseline")
      .setDesc("Use this only if you want future checks to ignore all currently existing Zotero items.")
      .addButton((button) =>
        button.setButtonText("Reset").onClick(async () => {
          this.plugin.settings.installedAt = new Date().toISOString();
          await this.plugin.saveSettings();
          new Notice("Zotero paper note baseline reset.");
        }),
      );
  }
}

function splitFrontmatter(content) {
  const normalized = String(content || "").replace(/\r\n/g, "\n");

  if (!normalized.startsWith("---\n")) {
    return { frontmatter: "", body: normalized };
  }

  const closingIndex = normalized.indexOf("\n---", 4);
  if (closingIndex === -1) {
    return { frontmatter: "", body: normalized };
  }

  const afterClosing = normalized.indexOf("\n", closingIndex + 1);
  const frontmatter = normalized.slice(4, closingIndex).replace(/^\n/, "");
  const body = afterClosing === -1 ? "" : normalized.slice(afterClosing + 1);
  return { frontmatter, body };
}

function renderMergedFrontmatter(templateFrontmatter, metadata) {
  const replacements = {
    author: renderListProperty("author", metadata.authors.map(wikiLink)),
    publishedIn: metadata.publishedIn
      ? `publishedIn: ${yamlDoubleQuoted(wikiLink(metadata.publishedIn))}`
      : "publishedIn:",
    year: metadata.year ? `year: ${metadata.year}` : "year:",
    Created: renderListProperty("Created", [metadata.created]),
    zoteroUri: `zoteroUri: ${metadata.zoteroUri}`,
  };

  const seen = new Set();
  const entries = splitYamlTopLevelEntries(templateFrontmatter);
  const rendered = [];

  for (const entry of entries) {
    if (Object.prototype.hasOwnProperty.call(replacements, entry.key)) {
      rendered.push(replacements[entry.key]);
      seen.add(entry.key);
    } else {
      rendered.push(entry.text);
    }
  }

  for (const key of Object.keys(replacements)) {
    if (!seen.has(key)) {
      rendered.push(replacements[key]);
    }
  }

  return `---\n${rendered.join("\n")}\n---\n`;
}

function splitYamlTopLevelEntries(frontmatter) {
  const lines = String(frontmatter || "").replace(/\r\n/g, "\n").split("\n");
  const entries = [];
  let current = null;

  for (const line of lines) {
    const match = line.match(/^([A-Za-z0-9_-]+):(?:\s.*)?$/);

    if (match) {
      if (current) {
        entries.push(current);
      }
      current = {
        key: match[1],
        lines: [line],
      };
    } else if (current) {
      current.lines.push(line);
    } else if (line.trim()) {
      current = {
        key: "",
        lines: [line],
      };
    }
  }

  if (current) {
    entries.push(current);
  }

  return entries
    .map((entry) => ({
      key: entry.key,
      text: entry.lines.join("\n").replace(/\s+$/g, ""),
    }))
    .filter((entry) => entry.text.trim());
}

function renderListProperty(key, values) {
  const cleanValues = values.map((value) => String(value || "").trim()).filter(Boolean);
  if (!cleanValues.length) {
    return `${key}:`;
  }

  return [`${key}:`, ...cleanValues.map((value) => `  - ${yamlDoubleQuoted(value)}`)].join("\n");
}

function yamlDoubleQuoted(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function wikiLink(value) {
  const target = String(value || "")
    .replace(/\[\[/g, "")
    .replace(/\]\]/g, "")
    .replace(/[|#]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return target ? `[[${target}]]` : "";
}

function stripTemplaterCursor(body) {
  return String(body || "").replace(/<%\s*tp\.file\.cursor\(\)\s*%>\s*/g, "");
}

function sanitizeFileName(title) {
  return String(title || "")
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .replace(/\.+$/g, "")
    .trim()
    .slice(0, 180);
}

function formatCreatorName(creator) {
  if (!creator) {
    return "";
  }

  if (creator.name) {
    return creator.name.trim();
  }

  return [creator.firstName, creator.lastName]
    .map((part) => String(part || "").trim())
    .filter(Boolean)
    .join(" ");
}

function extractYear(date) {
  const match = String(date || "").match(/\b(15|16|17|18|19|20|21)\d{2}\b/);
  return match ? match[0] : "";
}

function formatDateLink(date) {
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const year = date.getFullYear();
  return `[[${day}-${month}-${year}]]`;
}

function trimTrailingSlash(value) {
  return String(value || "").replace(/\/+$/g, "");
}

function trimSlashes(value) {
  return String(value || "").replace(/^\/+|\/+$/g, "");
}
