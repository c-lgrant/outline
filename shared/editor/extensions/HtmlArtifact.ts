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
      this.toggleFullscreen();
    });

    this.caption.append(
      this.title,
      this.warning,
      this.editButton,
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
    this.element.classList.toggle("is-page", page);

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
      if (height !== undefined) {
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

  private toggleFullscreen() {
    if (document.fullscreenElement === this.element) {
      void document.exitFullscreen?.();
      return;
    }
    void this.element.requestFullscreen?.();
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
  options: Omit<FrameOptions, "page">
): HtmlArtifactState {
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
    frame.update(block.node.textContent, {
      ...options,
      page: isHtmlPage(block.node),
    });

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
        return getNewState(doc, empty, rendererUrl, options());
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
