import { t } from "i18next";
import { Fragment, type Node } from "prosemirror-model";
import type { EditorState, Transaction } from "prosemirror-state";
import { Plugin, PluginKey, TextSelection } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { Decoration, DecorationSet } from "prosemirror-view";
import env from "../../env";
import { UserPreference, type UserPreferences } from "../../types";
import {
  HTML_DATA_LANGUAGE,
  HTML_FILES_LANGUAGE,
  isHtmlArtifact,
  isHtmlData,
  isHtmlFiles,
  isHtmlPage,
} from "../lib/isCode";
import { findBlockNodes } from "../queries/findChildren";
import { EditorStyleHelper } from "../styles/EditorStyleHelper";
import type { NodeWithPos } from "../types";
import type { Editor } from "../../../app/editor";

export const pluginKey = new PluginKey<HtmlArtifactState>("html-artifact");

/** Message types exchanged with the renderer page. */
export const MessageType = {
  Ready: "outline-artifact:ready",
  Render: "outline-artifact:render",
  Height: "outline-artifact:height",
  /** Artifact to Outline: a storage call (save, upload, file). */
  Rpc: "outline-artifact:rpc",
  /** Outline to artifact: the answer to a storage call. */
  RpcResult: "outline-artifact:rpc-result",
  /** Outline to artifact: the saved data changed, for example on another device. */
  Data: "outline-artifact:data",
} as const;

/** Transaction meta set on writes of page data and the uploaded-files list. */
export const ARTIFACT_DATA_META = "htmlArtifactData";

/** Largest saved data, in characters of JSON. */
export const MAX_DATA_CHARS = 256 * 1024;

/** Largest file an artifact may upload, in bytes. */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/** Most files one artifact may upload each time its doc is opened. */
export const MAX_UPLOADS_PER_LOAD = 20;

/** What a frame needs from the editor to store data and files. */
export type StorageHost = {
  /** Saves the artifact's data into the doc. Rejects with a readable reason. */
  save: (frame: ArtifactFrame, data: unknown) => Promise<void>;
  /** Uploads a file as an Outline attachment and returns its absolute URL. */
  upload: (file: File) => Promise<string>;
  /** Records an uploaded file in the artifact's html-files block. */
  recordFile: (frame: ArtifactFrame, url: string) => Promise<void>;
};

/**
 * Parses the text of an html-files block: a JSON array of attachment URLs.
 *
 * @param text the block's text.
 * @returns the URLs, or an empty list when the block is empty or invalid.
 */
export function parseFiles(text: string | undefined): string[] {
  const value = parseData(text);
  return Array.isArray(value)
    ? value.filter((url): url is string => typeof url === "string")
    : [];
}

/**
 * Parses the text of an html-data block.
 *
 * @param text the block's text.
 * @returns the data, or null when the block is empty or not valid JSON.
 */
export function parseData(text: string | undefined): unknown {
  if (!text || !text.trim()) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Returns true if the URL points at this Outline's own files, which are the
 * only files an artifact may ask Outline to fetch for it.
 *
 * @param url the URL to check.
 * @returns whether Outline may fetch it.
 */
export function isOwnFileUrl(url: unknown): url is string {
  if (typeof url !== "string") {
    return false;
  }
  try {
    const parsed = new URL(url, window.location.origin);
    return (
      parsed.origin === window.location.origin &&
      (parsed.pathname.startsWith("/api/attachments.redirect") ||
        parsed.pathname.startsWith("/api/files.get"))
    );
  } catch {
    return false;
  }
}

/** Sandbox flags for the renderer frame. Never includes allow-same-origin. */
// allow-popups-to-escape-sandbox: links (target=_blank) open a normal tab. Without it the new
// tab keeps this sandbox (no scripts, opaque origin) and most pages, Outline included, go blank.
export const SANDBOX =
  "allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox";

/** Smallest and largest height, in pixels, a frame may report. */
const MIN_HEIGHT = 40;
const MAX_HEIGHT = 20000;

export type FrameOptions = {
  /** Whether the document can be edited. */
  editable: boolean;
  /**
   * Whether the person may save page data: true when editing, and also in
   * view mode when they have permission to edit the doc (like ticking a
   * checklist without entering edit mode).
   */
  canSave: boolean;
  /** Whether the block is a full page ("html-page") rather than a widget. */
  page: boolean;
  /** Whether the editor uses a dark theme. */
  dark: boolean;
};

/** Delay before an edited source is re-rendered, in milliseconds. */
const RENDER_DEBOUNCE = 500;

/** How long after a doc opens its first full page may still open full screen. */
export const AUTO_OPEN_WINDOW_MS = 15000;

export type HtmlArtifactState = {
  decorationSet: DecorationSet;
  blocks: NodeWithPos[];
  /**
   * Whether the doc's first full page should still open full screen. The
   * editor starts empty and receives the doc from the collaboration server
   * afterwards, so this waits for the page to arrive instead of only looking
   * at the first state. It is cleared once a page opens or the person edits.
   */
  autoOpenPending?: boolean;
};

export type ArtifactMeta = {
  /** The text of the HTML's title element, if any. */
  title?: string;
  /** The content of the HTML's meta description, if any. */
  description?: string;
};

/**
 * Returns the configured renderer URL, or undefined if live HTML is disabled.
 *
 * @returns the renderer URL.
 */
export function getRendererUrl(): string | undefined {
  const url = env.HTML_ARTIFACT_RENDERER_URL;
  if (typeof url !== "string" || !/^https?:\/\//i.test(url)) {
    return undefined;
  }
  return url;
}

/**
 * Reads the title and description from an artifact's HTML, so the artifact
 * can be captioned and found by search tools that read the raw source.
 *
 * @param html the artifact source.
 * @returns the title and description, where present.
 */
export function getArtifactMeta(html: string): ArtifactMeta {
  const decode = (value: string) =>
    value
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, "&")
      .replace(/\s+/g, " ")
      .trim();

  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  const metaTag = html.match(
    /<meta\s+[^>]*name\s*=\s*["']description["'][^>]*>/i
  )?.[0];
  const description = metaTag?.match(
    /content\s*=\s*"([^"]*)"|content\s*=\s*'([^']*)'/i
  );

  return {
    title: title ? decode(title) || undefined : undefined,
    description: description
      ? decode(description[1] ?? description[2] ?? "") || undefined
      : undefined,
  };
}

/**
 * Clamps a height reported by a frame to a sensible range.
 *
 * @param value the reported height.
 * @returns the height to apply, or undefined if the value is not a number.
 */
export function clampHeight(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.ceil(value)));
}

/** Where a person changes the "open full pages full screen" preference. */
export const PREFERENCES_PATH = "/settings/preferences";

/**
 * Returns whether the signed-in person chose to open full pages full screen.
 * It is an account preference (Settings, Preferences), so it follows them to
 * every device.
 *
 * @param preferences the person's preferences, if signed in.
 * @returns true when the preference is on.
 */
export function prefersFullscreen(
  preferences: UserPreferences | null | undefined
): boolean {
  return !!preferences?.[UserPreference.OpenPagesFullscreen];
}

/**
 * Returns whether the current URL asks to open the doc's page full screen,
 * for example /doc/my-page-abc123?app.
 *
 * @returns true when the URL has an "app" query parameter.
 */
export function urlWantsFullscreen(): boolean {
  try {
    return new URLSearchParams(window.location.search).has("app");
  } catch {
    return false;
  }
}

/** Frames created on this page. */
const frames = new Set<ArtifactFrame>();

let listening = false;

let nextId = 0;

/**
 * Routes messages from renderer frames to the frame that sent them. Frames
 * are sandboxed without allow-same-origin, so their origin is always "null"
 * and the sender is identified by its window instead.
 */
function listen() {
  if (listening || typeof window === "undefined") {
    return;
  }
  listening = true;
  window.addEventListener("message", (event: MessageEvent) => {
    if (!event.source) {
      return;
    }
    for (const frame of frames) {
      if (frame.iframe.contentWindow === event.source) {
        frame.handleMessage(event.data);
        return;
      }
    }
  });
}

/** Owns the DOM for one rendered artifact. */
export class ArtifactFrame {
  readonly element: HTMLElement;
  readonly iframe: HTMLIFrameElement;

  /** Position of the code block this frame renders, updated on every change. */
  pos = 0;

  /** The view that owns this frame, set when the widget is drawn. */
  view?: EditorView;

  private readonly rendererUrl: string;
  private readonly caption: HTMLElement;
  private readonly title: HTMLElement;
  private readonly warning: HTMLElement;
  private readonly editButton: HTMLButtonElement;
  private readonly fullscreenButton: HTMLButtonElement;
  private readonly autoButton: HTMLButtonElement;
  private readonly linkButton: HTMLButtonElement;
  private page = false;
  private overlay?: HTMLElement;
  private savedHeight?: string;
  private onKeyDown?: (event: KeyboardEvent) => void;
  private renderedHtml?: string;
  private pendingHtml?: string;
  private ready = false;
  private loads = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private readonly host?: StorageHost;
  private canSave = false;

  /** The artifact's saved data, as the JSON text last read from the doc. */
  private dataText = "";

  /** Attachment URLs this frame uploaded since the doc was opened. */
  private readonly uploaded = new Set<string>();

  /** Uploads started since the doc was opened, including failed ones. */
  private uploadCount = 0;

  /** Attachment URLs recorded in the html-files block, which only Outline writes. */
  recordedFiles: string[] = [];

  /** Stable key for the widget decoration that shows this frame. */
  readonly id = `html-artifact-${++nextId}`;

  constructor(rendererUrl: string, host?: StorageHost) {
    listen();
    frames.add(this);
    this.rendererUrl = rendererUrl;
    this.host = host;

    this.element = document.createElement("div");
    this.element.classList.add(EditorStyleHelper.htmlArtifact);
    this.element.contentEditable = "false";

    this.caption = document.createElement("div");
    this.caption.className = "html-artifact-caption";

    this.title = document.createElement("span");
    this.title.className = "html-artifact-title";

    this.warning = document.createElement("span");
    this.warning.className = "html-artifact-warning";
    this.warning.textContent = t(
      'Add a <title> and <meta name="description"> so search can find this'
    );

    this.editButton = document.createElement("button");
    this.editButton.type = "button";
    this.editButton.className = "html-artifact-edit";
    this.editButton.textContent = t("Edit source");
    this.editButton.addEventListener("mousedown", (event) => {
      event.preventDefault();
      this.editSource();
    });

    this.fullscreenButton = document.createElement("button");
    this.fullscreenButton.type = "button";
    this.fullscreenButton.className = "html-artifact-fullscreen";
    this.fullscreenButton.textContent = t("Full screen");
    this.fullscreenButton.addEventListener("click", () => {
      this.setFullscreen(!this.isFullscreen);
    });

    // Shown only while a full page is full screen: opens the account
    // preference that makes full pages open like this every time.
    this.autoButton = document.createElement("button");
    this.autoButton.type = "button";
    this.autoButton.className = "html-artifact-auto";
    this.autoButton.textContent = t("Settings");
    this.autoButton.addEventListener("click", () => {
      this.setFullscreen(false);
      window.location.assign(PREFERENCES_PATH);
    });

    this.linkButton = document.createElement("button");
    this.linkButton.type = "button";
    this.linkButton.className = "html-artifact-link";
    this.linkButton.textContent = t("Copy link");
    this.linkButton.addEventListener("click", () => {
      void this.copyLink();
    });

    this.caption.append(
      this.title,
      this.warning,
      this.editButton,
      this.autoButton,
      this.linkButton,
      this.fullscreenButton
    );

    this.iframe = document.createElement("iframe");
    this.iframe.setAttribute("sandbox", SANDBOX);
    this.iframe.setAttribute("referrerpolicy", "no-referrer");
    this.iframe.setAttribute("loading", "lazy");
    this.iframe.title = t("Live HTML");
    this.iframe.style.height = "150px";

    this.element.append(this.caption, this.iframe);
  }

  /**
   * Shows the given HTML, reloading the renderer if it changed.
   *
   * @param html the artifact source.
   * @param options how the frame is shown.
   */
  update(html: string, { editable, canSave, page, dark }: FrameOptions) {
    const meta = getArtifactMeta(html);
    this.title.textContent = meta.title ?? t("Live HTML");
    this.warning.hidden = !editable || !!(meta.title && meta.description);
    this.editButton.hidden = !editable;
    this.canSave = canSave;
    this.page = page;
    this.element.classList.toggle("is-page", page);
    this.syncButtons();

    // A frame's prefers-color-scheme follows the color-scheme of its element,
    // so artifacts follow Outline's theme rather than the operating system's.
    this.iframe.style.colorScheme = dark ? "dark" : "light";

    if (html === this.renderedHtml || html === this.pendingHtml) {
      return;
    }
    this.pendingHtml = html;

    clearTimeout(this.timer);
    const delay = this.renderedHtml === undefined ? 0 : RENDER_DEBOUNCE;
    this.timer = setTimeout(() => this.load(), delay);
  }

  /**
   * Gives the frame the text of its html-data block. When it changed, for
   * example after a save on another device, the running artifact is told
   * without being reloaded.
   *
   * @param text the JSON text of the data block, or "" when there is none.
   */
  setData(text: string) {
    if (text === this.dataText) {
      return;
    }
    this.dataText = text;
    const win = this.iframe.contentWindow;
    if (win && this.ready && this.pendingHtml === undefined) {
      win.postMessage({ type: MessageType.Data, data: parseData(text) }, "*");
    }
  }

  /**
   * Handles a message posted by this frame's renderer.
   *
   * @param data the message payload.
   */
  handleMessage(data: unknown) {
    if (!data || typeof data !== "object") {
      return;
    }
    const message = data as {
      type?: unknown;
      height?: unknown;
      id?: unknown;
      method?: unknown;
      args?: unknown;
    };

    if (message.type === MessageType.Ready) {
      this.ready = true;
      this.send();
      return;
    }

    if (message.type === MessageType.Rpc) {
      void this.handleRpc(message.id, message.method, message.args);
      return;
    }

    if (message.type === MessageType.Height) {
      const height = clampHeight(message.height);
      if (height === undefined) {
        return;
      }

      // In full screen the frame fills the window; remember the height for
      // when it returns to the doc.
      if (this.overlay) {
        this.savedHeight = `${height}px`;
      } else {
        this.iframe.style.height = `${height}px`;
      }
    }
  }

  private load() {
    this.ready = false;

    // Reloading gives the artifact a fresh document, scripts and timers. The
    // query string changes so the browser always navigates.
    const url = new URL(this.rendererUrl);
    url.searchParams.set("r", String(++this.loads));
    this.iframe.src = url.toString();
  }

  private send() {
    const win = this.iframe.contentWindow;
    if (!win || !this.ready || this.pendingHtml === undefined) {
      return;
    }

    // The renderer has an opaque origin, so "*" is the only target that works.
    win.postMessage(
      {
        type: MessageType.Render,
        html: this.pendingHtml,
        data: parseData(this.dataText),
        canEdit: this.canSave && !!this.host,
      },
      "*"
    );
    this.renderedHtml = this.pendingHtml;
    this.pendingHtml = undefined;
  }

  /**
   * Runs one storage call from the artifact and posts the answer back.
   * Only three calls exist: save its own data, upload a file, and fetch a
   * file that lives in this Outline.
   */
  private async handleRpc(id: unknown, method: unknown, args: unknown) {
    const win = this.iframe.contentWindow;
    if (!win || (typeof id !== "number" && typeof id !== "string")) {
      return;
    }
    const reply = (ok: boolean, payload: unknown) =>
      win.postMessage(
        ok
          ? { type: MessageType.RpcResult, id, ok, result: payload }
          : { type: MessageType.RpcResult, id, ok, error: String(payload) },
        "*"
      );
    const [arg] = Array.isArray(args) ? args : [];

    try {
      if (method === "save") {
        if (!this.host || !this.canSave) {
          throw new Error("This doc is read-only, so changes cannot be saved");
        }
        await this.host.save(this, arg);
        reply(true, null);
        return;
      }

      if (method === "upload") {
        if (!this.host || !this.canSave) {
          throw new Error("This doc is read-only, so files cannot be uploaded");
        }
        if (!(arg instanceof File)) {
          throw new Error("Pass a File to upload");
        }
        if (arg.size > MAX_UPLOAD_BYTES) {
          throw new Error("Files must be 25 MB or smaller");
        }
        // Reserve the slot before awaiting, so parallel calls cannot pass
        // the cap together.
        if (this.uploadCount >= MAX_UPLOADS_PER_LOAD) {
          throw new Error(
            `A page can upload at most ${MAX_UPLOADS_PER_LOAD} files each time the doc is opened`
          );
        }
        this.uploadCount++;
        const url = await this.host.upload(arg);
        this.uploaded.add(url);
        await this.host.recordFile(this, url);
        reply(true, { url, name: arg.name, size: arg.size, type: arg.type });
        return;
      }

      if (method === "file") {
        // A page may only open files it uploaded: in this session, or
        // earlier, as recorded in its html-files block. Only Outline writes
        // that block (save() cannot), so a page cannot use the viewer's
        // login to read any other attachment.
        if (
          !isOwnFileUrl(arg) ||
          (!this.uploaded.has(arg) && !this.recordedFiles.includes(arg))
        ) {
          throw new Error("A page can only open files it uploaded");
        }
        const response = await fetch(new URL(arg, window.location.origin), {
          credentials: "same-origin",
        });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        reply(true, await response.blob());
        return;
      }

      throw new Error(`Unknown storage call: ${String(method)}`);
    } catch (error) {
      reply(false, error instanceof Error ? error.message : error);
    }
  }

  /** Whether the frame currently covers the whole window. */
  get isFullscreen() {
    return !!this.overlay;
  }

  /**
   * Covers the whole window with the artifact, like a Claude artifact page.
   * This is a fixed overlay on document.body rather than the Fullscreen API,
   * which iPhone Safari only supports for video. The caption and iframe move
   * into the overlay, so no editor ancestor can clip or offset it.
   *
   * @param on whether to cover the window.
   */
  setFullscreen(on: boolean) {
    if (on === this.isFullscreen) {
      return;
    }

    // Moving an iframe in the DOM reloads it, so resend the HTML once the
    // renderer is ready again.
    if (this.renderedHtml !== undefined) {
      this.pendingHtml = this.renderedHtml;
      this.renderedHtml = undefined;
    }
    this.ready = false;

    if (on) {
      const background = getComputedStyle(this.element).backgroundColor;
      const overlay = document.createElement("div");
      overlay.className = "html-artifact-overlay";
      Object.assign(overlay.style, {
        position: "fixed",
        inset: "0",
        zIndex: "3000",
        display: "flex",
        flexDirection: "column",
        background:
          background && background !== "rgba(0, 0, 0, 0)"
            ? background
            : "Canvas",
      });
      // A slim bar above the page, like the header of a Claude artifact. It
      // takes its own space, so it never covers the page's content.
      const color = getComputedStyle(this.element).color || "CanvasText";
      Object.assign(this.caption.style, {
        position: "static",
        flex: "none",
        display: "flex",
        alignItems: "center",
        gap: "6px",
        minHeight: "40px",
        padding: "4px 8px",
        paddingTop: "calc(4px + env(safe-area-inset-top, 0px))",
        paddingLeft: "calc(8px + env(safe-area-inset-left, 0px))",
        paddingRight: "calc(8px + env(safe-area-inset-right, 0px))",
        borderBottom: "1px solid rgba(128, 128, 128, 0.25)",
        background: overlay.style.background,
        color,
        font: "13px system-ui, -apple-system, sans-serif",
        opacity: "1",
      });
      Object.assign(this.title.style, {
        flex: "1",
        minWidth: "0",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        fontWeight: "600",
      });
      for (const button of [
        this.autoButton,
        this.linkButton,
        this.fullscreenButton,
      ]) {
        Object.assign(button.style, {
          font: "inherit",
          color: "inherit",
          background: "transparent",
          border: "1px solid rgba(128, 128, 128, 0.35)",
          borderRadius: "6px",
          padding: "4px 10px",
          minHeight: "32px",
          cursor: "pointer",
          whiteSpace: "nowrap",
        });
      }
      this.title.hidden = false;
      this.warning.hidden = true;
      this.savedHeight = this.iframe.style.height;
      Object.assign(this.iframe.style, {
        flex: "1",
        height: "auto",
        minHeight: "0",
      });
      overlay.append(this.caption, this.iframe);
      document.body.append(overlay);
      this.overlay = overlay;
    } else {
      this.caption.removeAttribute("style");
      this.title.removeAttribute("style");
      for (const button of [
        this.autoButton,
        this.linkButton,
        this.fullscreenButton,
      ]) {
        button.removeAttribute("style");
      }
      this.title.hidden = false;
      this.iframe.style.flex = "";
      this.iframe.style.minHeight = "";
      this.iframe.style.height = this.savedHeight ?? "150px";
      this.element.append(this.caption, this.iframe);
      this.overlay?.remove();
      this.overlay = undefined;
    }
    // Stop the doc behind the overlay from scrolling.
    document.documentElement.style.overflow = on ? "hidden" : "";
    document.body.style.overflow = on ? "hidden" : "";

    if (on) {
      this.onKeyDown = (event) => {
        if (event.key === "Escape") {
          this.setFullscreen(false);
        }
      };
      document.addEventListener("keydown", this.onKeyDown);
    } else if (this.onKeyDown) {
      document.removeEventListener("keydown", this.onKeyDown);
      this.onKeyDown = undefined;
    }
    this.syncButtons();
  }

  private syncButtons() {
    const on = this.isFullscreen;
    this.fullscreenButton.textContent = on ? t("Close") : t("Full screen");
    this.autoButton.hidden = !on || !this.page;
    this.linkButton.hidden = !on || !this.page;
  }

  private async copyLink() {
    const url = new URL(window.location.href);
    url.searchParams.set("app", "");
    const link = url
      .toString()
      .replace(/app=$/, "app")
      .replace(/app=&/, "app&");
    try {
      await navigator.clipboard.writeText(link);
      this.linkButton.textContent = t("Link copied");
    } catch {
      this.linkButton.textContent = link;
    }
    setTimeout(() => {
      this.linkButton.textContent = t("Copy link");
    }, 2000);
  }

  private editSource() {
    const view = this.view;
    if (!view || !view.editable) {
      return;
    }
    const node = view.state.doc.nodeAt(this.pos);
    if (!node || !isHtmlArtifact(node)) {
      return;
    }
    const tr = view.state.tr.setSelection(
      TextSelection.create(view.state.doc, this.pos + 1)
    );
    view.dispatch(tr.scrollIntoView());
    view.focus();
  }
}

/**
 * Finds the live HTML blocks in a document.
 *
 * @param doc the document.
 * @returns the blocks with their positions.
 */
export function findArtifactBlocks(doc: Node): NodeWithPos[] {
  return findBlockNodes(doc, true).filter((item) => isHtmlArtifact(item.node));
}

/**
 * Saves an artifact's data into the html-data block right after it, creating
 * the block if there is none. The change is an ordinary edit, so it syncs to
 * other viewers, shows in the doc history and can be undone.
 *
 * @param view the editor view.
 * @param pos the position of the artifact's code block.
 * @param data the data to save; anything JSON can represent.
 */
export function saveArtifactData(view: EditorView, pos: number, data: unknown) {
  let json: string | undefined;
  try {
    json = JSON.stringify(data ?? null, null, 2);
  } catch {
    json = undefined;
  }
  if (json === undefined) {
    throw new Error("Only data that JSON can represent can be saved");
  }
  if (json.length > MAX_DATA_CHARS) {
    throw new Error("Saved data must be 256 KB or smaller");
  }

  writeCompanion(view, pos, "data", json);
}

/**
 * Adds an uploaded file's URL to the html-files block of the artifact at pos.
 * Only trusted editor code calls this, never the page, which is what lets
 * fileUrl() trust the list.
 *
 * @param view the editor view.
 * @param pos the position of the artifact's code block.
 * @param url the attachment URL.
 */
export function recordArtifactFile(view: EditorView, pos: number, url: string) {
  const node = artifactAt(view.state.doc, pos);
  const files = parseFiles(
    companions(view.state.doc, pos, node).files?.node.textContent
  );
  if (files.includes(url)) {
    return;
  }
  writeCompanion(view, pos, "files", JSON.stringify([...files, url], null, 2));
}

/**
 * Returns the artifact block at pos, or throws when it is gone.
 */
function artifactAt(doc: Node, pos: number): Node {
  const inside = pos >= 0 && pos < doc.content.size;
  const node = inside ? doc.nodeAt(pos) : null;
  if (!node || !isHtmlArtifact(node)) {
    throw new Error("The page was moved or removed, so it cannot save");
  }
  return node;
}

/**
 * Finds the blocks that belong to the artifact at pos: an html-data block
 * right after it, then an html-files block.
 */
export function companions(
  doc: Node,
  pos: number,
  node: Node
): { data?: NodeWithPos; files?: NodeWithPos } {
  const result: { data?: NodeWithPos; files?: NodeWithPos } = {};
  let at = pos + node.nodeSize;
  let next = at < doc.content.size ? doc.nodeAt(at) : null;
  if (next && isHtmlData(next)) {
    result.data = { node: next, pos: at };
    at += next.nodeSize;
    next = at < doc.content.size ? doc.nodeAt(at) : null;
  }
  if (next && isHtmlFiles(next)) {
    result.files = { node: next, pos: at };
  }
  return result;
}

function writeCompanion(
  view: EditorView,
  pos: number,
  kind: "data" | "files",
  text: string
) {
  const { state } = view;
  const node = artifactAt(state.doc, pos);
  const found = companions(state.doc, pos, node);
  const existing = found[kind];
  const content = state.schema.text(text);
  const tr = state.tr;

  if (existing) {
    if (existing.node.textContent === text) {
      return;
    }
    tr.replaceWith(
      existing.pos + 1,
      existing.pos + existing.node.nodeSize - 1,
      Fragment.from(content)
    );
  } else {
    // Data goes right after the page; files go after the data, if any.
    const insertAt =
      kind === "files" && found.data
        ? found.data.pos + found.data.node.nodeSize
        : pos + node.nodeSize;
    const language = kind === "data" ? HTML_DATA_LANGUAGE : HTML_FILES_LANGUAGE;
    tr.insert(insertAt, node.type.create({ ...node.attrs, language }, content));
  }
  // Marked so the editor saves it even in view mode for people who may
  // edit the doc (see app/editor, like checklist ticks).
  view.dispatch(tr.setMeta(ARTIFACT_DATA_META, true));
}

function getNewState(
  doc: Node,
  previous: HtmlArtifactState,
  rendererUrl: string,
  options: Omit<FrameOptions, "page">,
  autoOpen = false,
  host?: StorageHost
): HtmlArtifactState {
  let opened = false;
  const blocks = findArtifactBlocks(doc);
  const dataBlocks: NodeWithPos[] = [];
  const used = new Set<ArtifactFrame>();
  const decorations: Decoration[] = [];

  for (const block of blocks) {
    const end = block.pos + block.node.nodeSize;

    // Reuse the frame already drawn for this block so it is not reloaded.
    const existing = previous.decorationSet
      .find(block.pos, end, (spec) => spec.frame instanceof ArtifactFrame)
      .map((decoration) => decoration.spec.frame as ArtifactFrame)
      .find((candidate) => !used.has(candidate));

    const frame = existing ?? new ArtifactFrame(rendererUrl, host);
    used.add(frame);
    frame.pos = block.pos;
    const page = isHtmlPage(block.node);
    frame.update(block.node.textContent, { ...options, page });

    // Saved data and the uploaded-files list sit right after the page.
    const found = companions(doc, block.pos, block.node);
    if (found.data) {
      dataBlocks.push(found.data);
    }
    if (found.files) {
      dataBlocks.push(found.files);
    }
    frame.setData(found.data?.node.textContent ?? "");
    frame.recordedFiles = parseFiles(found.files?.node.textContent);

    // Only the doc's first full page opens full screen, and only on load.
    if (autoOpen && page && !opened) {
      opened = true;
      frame.setFullscreen(true);
    }

    decorations.push(
      Decoration.widget(
        end,
        (view) => {
          frame.view = view;
          return frame.element;
        },
        { frame, side: -10, key: frame.id }
      )
    );
  }

  return {
    blocks: [...blocks, ...dataBlocks],
    decorationSet: DecorationSet.create(doc, decorations),
    autoOpenPending: autoOpen && !opened,
  };
}

/**
 * Hides the source of every live HTML block except the one being edited.
 *
 * @param state the editor state.
 * @param pluginState the plugin state.
 * @returns node decorations that hide the source.
 */
function sourceDecorations(
  state: EditorState,
  pluginState: HtmlArtifactState
): Decoration[] {
  const { from, to } = state.selection;
  return pluginState.blocks
    .filter((block) => {
      const end = block.pos + block.node.nodeSize;
      return !(from > block.pos && to < end);
    })
    .map((block) =>
      Decoration.node(block.pos, block.pos + block.node.nodeSize, {
        class: EditorStyleHelper.htmlArtifactSourceHidden,
      })
    );
}

/**
 * Renders code blocks with the "html-live" language as sandboxed, live HTML,
 * in the same way that Mermaid code blocks render as diagrams. "html-page"
 * blocks render the same way but as a full page: no border or caption bar,
 * at least as tall as the screen. The source stays in the document as an
 * ordinary code block, so it survives the markdown API and stays readable by
 * search.
 */
export default function HtmlArtifact({ editor }: { editor: Editor }) {
  const rendererUrl = getRendererUrl();
  const createdAt = Date.now();
  const options = () => ({
    editable: !editor.props.readOnly,
    canSave: !editor.props.readOnly || !!editor.props.canUpdate,
    dark: !!editor.props.theme?.isDark,
  });
  const host: StorageHost = {
    save: async (frame, data) => {
      if (!frame.view) {
        throw new Error("The page is not ready yet, try again");
      }
      saveArtifactData(frame.view, frame.pos, data);
    },
    upload: async (file) => {
      const upload = editor.props.uploadFile;
      if (!upload) {
        throw new Error("Uploads are not available here");
      }
      const url = await upload(file);
      return new URL(url, window.location.origin).toString();
    },
    recordFile: async (frame, url) => {
      if (!frame.view) {
        throw new Error("The page is not ready yet, try again");
      }
      recordArtifactFile(frame.view, frame.pos, url);
    },
  };

  return new Plugin<HtmlArtifactState>({
    key: pluginKey,
    state: {
      init: (_, { doc }) => {
        const empty = { blocks: [], decorationSet: DecorationSet.empty };
        if (!rendererUrl || typeof document === "undefined") {
          return empty;
        }
        return getNewState(
          doc,
          empty,
          rendererUrl,
          options(),
          urlWantsFullscreen() ||
            prefersFullscreen(editor.props.userPreferences),
          host
        );
      },
      apply: (tr: Transaction, pluginState: HtmlArtifactState) => {
        if (!rendererUrl || typeof document === "undefined") {
          return pluginState;
        }
        if (!tr.docChanged) {
          return pluginState;
        }

        // Keep waiting for the page while the doc is still arriving from the
        // collaboration server, for a few seconds after the doc opens. Later
        // on, a new page block is someone's edit, not a doc being opened.
        const autoOpen =
          !!pluginState.autoOpenPending &&
          Date.now() - createdAt < AUTO_OPEN_WINDOW_MS &&
          !tr.getMeta("uiEvent");
        return getNewState(
          tr.doc,
          {
            ...pluginState,
            decorationSet: pluginState.decorationSet.map(tr.mapping, tr.doc),
          },
          rendererUrl,
          options(),
          autoOpen,
          host
        );
      },
    },
    view: (editorView) => ({
      destroy() {
        // Leaving the doc must not leave a full-screen overlay behind. Only
        // this editor's own frames are closed: Outline briefly shows a cached
        // copy of the doc in a second editor, and removing that one must not
        // close the page the live editor just opened.
        const state = pluginKey.getState(editorView.state);
        for (const decoration of state?.decorationSet.find() ?? []) {
          const frame = decoration.spec.frame as ArtifactFrame | undefined;
          if (frame?.isFullscreen) {
            frame.setFullscreen(false);
          }
        }
      },
    }),
    props: {
      decorations(state) {
        const pluginState = this.getState(state);
        if (!pluginState || pluginState.blocks.length === 0) {
          return null;
        }
        return pluginState.decorationSet.add(
          state.doc,
          sourceDecorations(state, pluginState)
        );
      },
    },
  });
}
