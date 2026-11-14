import { Schema } from "prosemirror-model";
import { EditorState, TextSelection } from "prosemirror-state";
import type { Decoration, DecorationSet } from "prosemirror-view";
import env from "../../env";
import { EditorStyleHelper } from "../styles/EditorStyleHelper";
import HtmlArtifact, {
  ArtifactFrame,
  MessageType,
  SANDBOX,
  clampHeight,
  findArtifactBlocks,
  getArtifactMeta,
  getRendererUrl,
  pluginKey,
} from "./HtmlArtifact";

const RENDERER = "https://artifacts.example.com/render.html";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { group: "block", content: "inline*" },
    code_fence: {
      group: "block",
      content: "text*",
      code: true,
      attrs: { language: { default: "" } },
    },
    text: { group: "inline" },
  },
});

const editor = { props: { readOnly: false } } as never;

function docWith(...blocks: Array<[string, string]>) {
  return schema.nodes.doc.create(
    null,
    blocks.map(([language, text]) =>
      language === "p"
        ? schema.nodes.paragraph.create(null, text ? schema.text(text) : null)
        : schema.nodes.code_fence.create(
            { language },
            text ? schema.text(text) : null
          )
    )
  );
}

function stateFor(doc: ReturnType<typeof docWith>) {
  return EditorState.create({ doc, plugins: [HtmlArtifact({ editor })] });
}

describe("HtmlArtifact", () => {
  beforeEach(() => {
    env.HTML_ARTIFACT_RENDERER_URL = RENDERER;
  });

  afterEach(() => {
    delete env.HTML_ARTIFACT_RENDERER_URL;
  });

  describe("getRendererUrl", () => {
    it("returns the configured URL", () => {
      expect(getRendererUrl()).toBe(RENDERER);
    });

    it("rejects missing and non-http values", () => {
      delete env.HTML_ARTIFACT_RENDERER_URL;
      expect(getRendererUrl()).toBeUndefined();
      env.HTML_ARTIFACT_RENDERER_URL = "javascript:alert(1)";
      expect(getRendererUrl()).toBeUndefined();
    });
  });

  describe("getArtifactMeta", () => {
    it("reads the title and description", () => {
      const meta = getArtifactMeta(
        `<html><head><title>Boiler &amp; heating</title>
        <meta name="description" content="Live flow temperature, updated every minute"></head></html>`
      );
      expect(meta).toEqual({
        title: "Boiler & heating",
        description: "Live flow temperature, updated every minute",
      });
    });

    it("accepts single quotes and either attribute order", () => {
      expect(
        getArtifactMeta(`<meta content='Two' name='description'>`).description
      ).toBe("Two");
      expect(
        getArtifactMeta(`<meta name='description' content='One'>`).description
      ).toBe("One");
    });

    it("returns nothing for empty or missing values", () => {
      expect(getArtifactMeta("<div>hi</div>")).toEqual({
        title: undefined,
        description: undefined,
      });
      expect(getArtifactMeta("<title>  </title>").title).toBeUndefined();
    });
  });

  describe("clampHeight", () => {
    it("clamps to the allowed range", () => {
      expect(clampHeight(10)).toBe(40);
      expect(clampHeight(321.2)).toBe(322);
      expect(clampHeight(99999)).toBe(20000);
    });

    it("ignores non-numbers", () => {
      expect(clampHeight("200")).toBeUndefined();
      expect(clampHeight(NaN)).toBeUndefined();
    });
  });

  describe("findArtifactBlocks", () => {
    it("finds only html-live and html-page code blocks", () => {
      const doc = docWith(
        ["p", "intro"],
        ["html-live", "<b>one</b>"],
        ["markup", "<b>not live</b>"],
        ["html-page", "<b>two</b>"]
      );
      expect(findArtifactBlocks(doc).map((b) => b.node.textContent)).toEqual([
        "<b>one</b>",
        "<b>two</b>",
      ]);
    });
  });

  describe.runIf(typeof document !== "undefined")("plugin", () => {
    it("draws a sandboxed frame after each live block", () => {
      const state = stateFor(
        docWith(["html-live", "<title>A</title>"], ["p", "after"])
      );
      const pluginState = pluginKey.getState(state)!;
      const widgets = pluginState.decorationSet.find();
      expect(widgets).toHaveLength(1);

      const frame = widgets[0].spec.frame as ArtifactFrame;
      expect(frame.iframe.getAttribute("sandbox")).toBe(SANDBOX);
      expect(SANDBOX).not.toContain("allow-same-origin");
      expect(widgets[0].from).toBe(state.doc.child(0).nodeSize);
    });

    it("marks html-page blocks as full pages", () => {
      const state = stateFor(
        docWith(["html-live", "<b>widget</b>"], ["html-page", "<b>page</b>"])
      );
      const frames = pluginKey
        .getState(state)!
        .decorationSet.find()
        .map((d) => d.spec.frame as ArtifactFrame);
      expect(
        frames.map((f) => f.element.classList.contains("is-page"))
      ).toEqual([false, true]);
    });

    it("draws nothing without a renderer URL", () => {
      delete env.HTML_ARTIFACT_RENDERER_URL;
      const state = stateFor(docWith(["html-live", "<b>x</b>"]));
      expect(pluginKey.getState(state)!.decorationSet.find()).toHaveLength(0);
    });

    it("keeps the same frame when the document changes", () => {
      const state = stateFor(
        docWith(["p", "intro"], ["html-live", "<b>x</b>"])
      );
      const before = pluginKey.getState(state)!.decorationSet.find()[0]
        .spec.frame;
      const next = state.apply(state.tr.insertText("more ", 1));
      const after = pluginKey.getState(next)!.decorationSet.find()[0]
        .spec.frame;
      expect(after).toBe(before);
      expect((after as ArtifactFrame).pos).toBe(
        state.doc.child(0).nodeSize + 5
      );
    });

    it("hides the source unless the selection is inside it", () => {
      const state = stateFor(
        docWith(["p", "intro"], ["html-live", "<b>x</b>"])
      );
      const plugin = state.plugins[0];
      const hiddenClass = (s: EditorState) =>
        (plugin.props.decorations!.call(plugin, s) as DecorationSet)
          .find()
          .filter(
            (d: Decoration) =>
              (d as unknown as { type: { attrs?: { class?: string } } }).type
                .attrs?.class === EditorStyleHelper.htmlArtifactSourceHidden
          ).length;

      expect(hiddenClass(state)).toBe(1);

      const inside = state.apply(
        state.tr.setSelection(
          TextSelection.create(state.doc, state.doc.child(0).nodeSize + 2)
        )
      );
      expect(hiddenClass(inside)).toBe(0);
    });
  });

  describe.runIf(typeof document !== "undefined")("ArtifactFrame", () => {
    const edit = { editable: true, page: false, dark: false };
    const view = { editable: false, page: false, dark: false };

    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("loads the renderer and sends the HTML once it is ready", () => {
      const frame = new ArtifactFrame(RENDERER);
      document.body.append(frame.element);

      frame.update("<p>hello</p>", edit);
      vi.runAllTimers();
      expect(frame.iframe.src).toContain("artifacts.example.com/render.html");

      const post = vi
        .spyOn(frame.iframe.contentWindow!, "postMessage")
        .mockImplementation(() => {});
      frame.handleMessage({ type: MessageType.Ready });
      expect(post).toHaveBeenCalledWith(
        { type: MessageType.Render, html: "<p>hello</p>" },
        "*"
      );

      frame.handleMessage({ type: MessageType.Height, height: 260 });
      expect(frame.iframe.style.height).toBe("260px");
      frame.element.remove();
    });

    it("does not reload for unchanged HTML", () => {
      const frame = new ArtifactFrame(RENDERER);
      frame.update("<p>same</p>", edit);
      vi.runAllTimers();
      const src = frame.iframe.src;
      frame.handleMessage({ type: MessageType.Ready });
      frame.update("<p>same</p>", edit);
      vi.runAllTimers();
      expect(frame.iframe.src).toBe(src);
    });

    it("warns about a missing title or description only while editing", () => {
      const frame = new ArtifactFrame(RENDERER);
      const warning = frame.element.querySelector(
        ".html-artifact-warning"
      ) as HTMLElement;

      frame.update("<p>no meta</p>", edit);
      expect(warning.hidden).toBe(false);

      frame.update("<p>no meta</p>", view);
      expect(warning.hidden).toBe(true);

      frame.update(
        '<title>T</title><meta name="description" content="D">',
        edit
      );
      expect(warning.hidden).toBe(true);
    });

    it("follows the editor theme and offers full screen", () => {
      const frame = new ArtifactFrame(RENDERER);
      frame.update("<p>x</p>", { ...view, dark: true });
      expect(frame.iframe.style.colorScheme).toBe("dark");
      frame.update("<p>x</p>", { ...view, dark: false });
      expect(frame.iframe.style.colorScheme).toBe("light");

      const button = frame.element.querySelector(
        ".html-artifact-fullscreen"
      ) as HTMLButtonElement;
      const request = vi.fn().mockResolvedValue(undefined);
      frame.element.requestFullscreen = request;
      button.click();
      expect(request).toHaveBeenCalled();
    });

    it("allows tall full pages", () => {
      const frame = new ArtifactFrame(RENDERER);
      frame.handleMessage({ type: MessageType.Height, height: 9000 });
      expect(frame.iframe.style.height).toBe("9000px");
    });
  });
});
