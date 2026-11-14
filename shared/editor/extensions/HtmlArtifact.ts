import { t } from "i18next";
import type { Node } from "prosemirror-model";
import type { EditorState, Transaction } from "prosemirror-state";
import { Plugin, PluginKey, TextSelection } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { Decoration, DecorationSet } from "prosemirror-view";
import env from "../../env";
import { isHtmlArtifact, isHtmlPage } from "../lib/isCode";
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
} as const;

/** Sandbox flags for the renderer frame. Never includes allow-same-origin. */
export const SANDBOX = "allow-scripts allow-forms allow-popups";

/** Smallest and largest height, in pixels, a frame may report. */
const MIN_HEIGHT = 40;
const MAX_HEIGHT = 20000;

export type FrameOptions = {
  /** Whether the document can be edited. */
  editable: boolean;
  /** Whether the block is a full page ("html-page") rather than a widget. */
  page: boolean;
  /** Whether the editor uses a dark theme. */
  dark: boolean;
};

/** Delay before an edited source is re-rendered, in milliseconds. */
const RENDER_DEBOUNCE = 500;

export type HtmlArtifactState = {
  decorationSet: DecorationSet;
  blocks: NodeWithPos[];
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

/** localStorage key for "open full pages full screen" on this browser. */
export const AUTO_FULLSCREEN_KEY = "html-artifact:auto-fullscreen";

/**
 * Returns whether full pages should open full screen when a doc loads.
 *
 * @returns true when the viewer turned the preference on.
 */
export function getAutoFullscreen(): boolean {
  try {
    return window.localStorage.getItem(AUTO_FULLSCREEN_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * Saves the "open full pages full screen" preference for this browser.
 *
 * @param on whether the preference is on.
 */
export function setAutoFullscreen(on: boolean) {
  try {
    if (on) {
      window.localStorage.setItem(AUTO_FULLSCREEN_KEY, "1");
    } else {
      window.localStorage.removeItem(AUTO_FULLSCREEN_KEY);
    }
  } catch {
    // Storage can be unavailable, for example in a private window.
  }
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

  /** Stable key for the widget decoration that shows this frame. */
  readonly id = `html-artifact-${++nextId}`;

  constructor(rendererUrl: string) {
    listen();
    frames.add(this);
    this.rendererUrl = rendererUrl;

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

    // Shown only while a full page is full screen.
    this.autoButton = document.createElement("button");
    this.autoButton.type = "button";
    this.autoButton.className = "html-artifact-auto";
    this.autoButton.textContent = t("Always open full screen");
    this.autoButton.addEventListener("click", () => {
      setAutoFullscreen(!getAutoFullscreen());
      this.syncButtons();
    });

    this.linkButton = document.createElement("button");
    this.linkButton.type = "button";
    this.linkButton.className = "html-artifact-link";
    this.linkButton.textContent = t("Copy full-screen link");
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
  update(html: string, { editable, page, dark }: FrameOptions) {
    const meta = getArtifactMeta(html);
    this.title.textContent = meta.title ?? t("Live HTML");
    this.warning.hidden = !editable || !!(meta.title && meta.description);
    this.editButton.hidden = !editable;
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
   * Handles a message posted by this frame's renderer.
   *
   * @param data the message payload.
   */
  handleMessage(data: unknown) {
    if (!data || typeof data !== "object") {
      return;
    }
    const message = data as { type?: unknown; height?: unknown };

    if (message.type === MessageType.Ready) {
      this.ready = true;
      this.send();
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
    win.postMessage({ type: MessageType.Render, html: this.pendingHtml }, "*");
    this.renderedHtml = this.pendingHtml;
    this.pendingHtml = undefined;
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
      Object.assign(this.caption.style, {
        position: "fixed",
        top: "calc(8px + env(safe-area-inset-top, 0px))",
        right: "calc(8px + env(safe-area-inset-right, 0px))",
        zIndex: "3001",
        display: "flex",
        flexWrap: "wrap",
        justifyContent: "flex-end",
        gap: "6px",
        maxWidth: "calc(100vw - 16px)",
        padding: "4px",
        borderRadius: "8px",
        background: overlay.style.background,
        boxShadow: "0 2px 12px rgba(0, 0, 0, 0.2)",
        font: "13px system-ui, sans-serif",
        opacity: "1",
      });
      this.title.hidden = true;
      this.warning.hidden = true;
      this.savedHeight = this.iframe.style.height;
      Object.assign(this.iframe.style, { flex: "1", height: "100%" });
      overlay.append(this.iframe, this.caption);
      document.body.append(overlay);
      this.overlay = overlay;
    } else {
      this.caption.removeAttribute("style");
      this.title.hidden = false;
      this.iframe.style.flex = "";
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
    this.fullscreenButton.textContent = on
      ? t("Exit full screen")
      : t("Full screen");
    this.autoButton.hidden = !on || !this.page;
    this.linkButton.hidden = !on || !this.page;
    this.autoButton.setAttribute("aria-pressed", String(getAutoFullscreen()));
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
      this.linkButton.textContent = t("Copy full-screen link");
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

function getNewState(
  doc: Node,
  previous: HtmlArtifactState,
  rendererUrl: string,
  options: Omit<FrameOptions, "page">,
  autoOpen = false
): HtmlArtifactState {
  let opened = false;
  const blocks = findArtifactBlocks(doc);
  const used = new Set<ArtifactFrame>();
  const decorations: Decoration[] = [];

  for (const block of blocks) {
    const end = block.pos + block.node.nodeSize;

    // Reuse the frame already drawn for this block so it is not reloaded.
    const existing = previous.decorationSet
      .find(block.pos, end, (spec) => spec.frame instanceof ArtifactFrame)
      .map((decoration) => decoration.spec.frame as ArtifactFrame)
      .find((candidate) => !used.has(candidate));

    const frame = existing ?? new ArtifactFrame(rendererUrl);
    used.add(frame);
    frame.pos = block.pos;
    const page = isHtmlPage(block.node);
    frame.update(block.node.textContent, { ...options, page });

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
    blocks,
    decorationSet: DecorationSet.create(doc, decorations),
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
  const options = () => ({
    editable: !editor.props.readOnly,
    dark: !!editor.props.theme?.isDark,
  });

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
          urlWantsFullscreen() || getAutoFullscreen()
        );
      },
      apply: (tr: Transaction, pluginState: HtmlArtifactState) => {
        if (!rendererUrl || typeof document === "undefined") {
          return pluginState;
        }
        if (!tr.docChanged) {
          return pluginState;
        }
        return getNewState(
          tr.doc,
          {
            ...pluginState,
            decorationSet: pluginState.decorationSet.map(tr.mapping, tr.doc),
          },
          rendererUrl,
          options()
        );
      },
    },
    view: () => ({
      destroy() {
        // Leaving the doc must not leave a full-screen overlay behind.
        for (const frame of frames) {
          if (frame.isFullscreen) {
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
