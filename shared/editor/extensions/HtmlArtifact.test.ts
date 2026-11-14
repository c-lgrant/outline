import { Schema } from "prosemirror-model";
import { EditorState, TextSelection } from "prosemirror-state";
import {
  EditorView,
  type Decoration,
  type DecorationSet,
} from "prosemirror-view";
import env from "../../env";
import { EditorStyleHelper } from "../styles/EditorStyleHelper";
import HtmlArtifact, {
  ArtifactFrame,
  MessageType,
  SANDBOX,
  clampHeight,
  findArtifactBlocks,
  getArtifactMeta,
  getAutoFullscreen,
  getRendererUrl,
  isOwnFileUrl,
  MAX_DATA_CHARS,
  parseData,
  parseFiles,
  recordArtifactFile,
  pluginKey,
  saveArtifactData,
  setAutoFullscreen,
  urlWantsFullscreen,
} from "./HtmlArtifact";

const RENDERER = "https://artifacts.example.com/render.html";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: {
      group: "block",
      content: "inline*",
      toDOM: () => ["p", 0],
    },
    code_fence: {
      group: "block",
      content: "text*",
      code: true,
      attrs: { language: { default: "" } },
      toDOM: () => ["pre", ["code", 0]],
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
        {
          type: MessageType.Render,
          html: "<p>hello</p>",
          data: null,
          canEdit: false,
        },
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
    });

    it("goes full screen as an overlay on the body and comes back", () => {
      const frame = new ArtifactFrame(RENDERER);
      document.body.append(frame.element);
      frame.update("<p>x</p>", { ...view, page: true });
      const button = frame.element.querySelector(
        ".html-artifact-fullscreen"
      ) as HTMLButtonElement;

      button.click();
      const overlay = document.querySelector(".html-artifact-overlay");
      expect(frame.isFullscreen).toBe(true);
      expect(overlay?.contains(frame.iframe)).toBe(true);
      expect(document.body.style.overflow).toBe("hidden");

      // Height reports are kept for later instead of shrinking the overlay.
      frame.handleMessage({ type: MessageType.Height, height: 500 });
      expect(frame.iframe.style.height).toBe("100%");

      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      expect(frame.isFullscreen).toBe(false);
      expect(document.querySelector(".html-artifact-overlay")).toBeNull();
      expect(frame.element.contains(frame.iframe)).toBe(true);
      expect(frame.iframe.style.height).toBe("500px");
      expect(document.body.style.overflow).toBe("");
      frame.element.remove();
    });

    it("remembers the auto full screen preference", () => {
      setAutoFullscreen(true);
      expect(getAutoFullscreen()).toBe(true);
      setAutoFullscreen(false);
      expect(getAutoFullscreen()).toBe(false);
    });

    it("allows tall full pages", () => {
      const frame = new ArtifactFrame(RENDERER);
      frame.handleMessage({ type: MessageType.Height, height: 9000 });
      expect(frame.iframe.style.height).toBe("9000px");
    });
  });

  describe.runIf(typeof document !== "undefined")("auto full screen", () => {
    afterEach(() => {
      setAutoFullscreen(false);
      window.history.replaceState(null, "", "/");
      document
        .querySelectorAll(".html-artifact-overlay")
        .forEach((el) => el.remove());
      document.body.style.overflow = "";
      document.documentElement.style.overflow = "";
    });

    const firstFrame = (state: EditorState) =>
      pluginKey.getState(state)!.decorationSet.find()[0].spec
        .frame as ArtifactFrame;

    it("opens the first full page when the link has ?app", () => {
      window.history.replaceState(null, "", "/doc/test?app");
      expect(urlWantsFullscreen()).toBe(true);
      const state = stateFor(docWith(["html-page", "<b>page</b>"]));
      expect(firstFrame(state).isFullscreen).toBe(true);
    });

    it("opens the first full page when the preference is on", () => {
      setAutoFullscreen(true);
      const state = stateFor(docWith(["html-page", "<b>page</b>"]));
      expect(firstFrame(state).isFullscreen).toBe(true);
    });

    it("never opens widgets or opens without being asked", () => {
      setAutoFullscreen(true);
      expect(
        firstFrame(stateFor(docWith(["html-live", "<b>w</b>"]))).isFullscreen
      ).toBe(false);
      setAutoFullscreen(false);
      expect(
        firstFrame(stateFor(docWith(["html-page", "<b>p</b>"]))).isFullscreen
      ).toBe(false);
    });
  });

  describe("storage helpers", () => {
    it("parses saved data and ignores broken JSON", () => {
      expect(parseData('{"items":["milk"]}')).toEqual({ items: ["milk"] });
      expect(parseData("")).toBeNull();
      expect(parseData("{not json")).toBeNull();
    });
  });

  describe.runIf(typeof document !== "undefined")("storage", () => {
    function viewFor(doc: ReturnType<typeof docWith>, editable = true) {
      const mount = document.createElement("div");
      document.body.append(mount);
      return new EditorView(mount, {
        state: stateFor(doc),
        editable: () => editable,
      });
    }

    it("only fetches files that live in this Outline", () => {
      expect(isOwnFileUrl("/api/attachments.redirect?id=1")).toBe(true);
      expect(
        isOwnFileUrl(`${window.location.origin}/api/files.get?key=x`)
      ).toBe(true);
      expect(isOwnFileUrl("https://evil.example.com/api/files.get")).toBe(
        false
      );
      expect(isOwnFileUrl("/api/users.list")).toBe(false);
      expect(isOwnFileUrl(42)).toBe(false);
    });

    it("saves data into an html-data block after the page, then updates it", () => {
      const view = viewFor(
        docWith(["p", "intro"], ["html-page", "<b>list</b>"], ["p", "end"])
      );
      const pos = view.state.doc.child(0).nodeSize;

      saveArtifactData(view, pos, { items: ["milk"] });
      const data = view.state.doc.child(2);
      expect(data.attrs.language).toBe("html-data");
      expect(JSON.parse(data.textContent)).toEqual({ items: ["milk"] });
      expect(view.state.doc.child(3).textContent).toBe("end");

      saveArtifactData(view, pos, { items: ["milk", "eggs"] });
      expect(view.state.doc.childCount).toBe(4);
      expect(JSON.parse(view.state.doc.child(2).textContent)).toEqual({
        items: ["milk", "eggs"],
      });
      view.destroy();
    });

    it("records uploads in an html-files block after the data, never from save()", () => {
      const view = viewFor(
        docWith(["p", "intro"], ["html-page", "<b>list</b>"], ["p", "end"])
      );
      const pos = view.state.doc.child(0).nodeSize;
      const url = `${window.location.origin}/api/attachments.redirect?id=1`;

      recordArtifactFile(view, pos, url);
      expect(view.state.doc.child(2).attrs.language).toBe("html-files");
      saveArtifactData(view, pos, { items: [] });
      expect(view.state.doc.child(2).attrs.language).toBe("html-data");
      expect(view.state.doc.child(3).attrs.language).toBe("html-files");
      recordArtifactFile(view, pos, url);
      expect(parseFiles(view.state.doc.child(3).textContent)).toEqual([url]);

      const frame = pluginKey.getState(view.state)!.decorationSet.find()[0].spec
        .frame as ArtifactFrame;
      expect(frame.recordedFiles).toEqual([url]);
      view.destroy();
    });

    it("refuses to save in a read-only doc, too much data, or a moved page", () => {
      const ro = viewFor(docWith(["html-live", "<b>x</b>"]), false);
      expect(() => saveArtifactData(ro, 0, { a: 1 })).toThrow(/read-only/);
      ro.destroy();

      const view = viewFor(docWith(["html-live", "<b>x</b>"]));
      expect(() =>
        saveArtifactData(view, 0, "x".repeat(MAX_DATA_CHARS + 1))
      ).toThrow(/256 KB/);
      expect(() => saveArtifactData(view, 99, { a: 1 })).toThrow(/moved/);
      view.destroy();
    });

    it("gives the frame its data, hides the data block and keeps the frame on save", () => {
      const view = viewFor(
        docWith(
          ["p", "intro"],
          ["html-live", "<b>x</b>"],
          ["html-data", '{"n":1}']
        )
      );
      const frame = pluginKey.getState(view.state)!.decorationSet.find()[0].spec
        .frame as ArtifactFrame;
      const hidden = (
        view.state.plugins[0].props.decorations!.call(
          view.state.plugins[0],
          view.state
        ) as DecorationSet
      )
        .find()
        .filter(
          (d: Decoration) =>
            (d as unknown as { type: { attrs?: { class?: string } } }).type
              .attrs?.class === EditorStyleHelper.htmlArtifactSourceHidden
        );
      expect(hidden).toHaveLength(2);

      saveArtifactData(view, view.state.doc.child(0).nodeSize, { n: 2 });
      const after = pluginKey.getState(view.state)!.decorationSet.find()[0]
        .spec.frame;
      expect(after).toBe(frame);
      view.destroy();
    });

    it("answers storage calls from the artifact", async () => {
      vi.useFakeTimers();
      const save = vi.fn().mockResolvedValue(undefined);
      const upload = vi
        .fn()
        .mockResolvedValue(
          "https://outline.example.com/api/attachments.redirect?id=9"
        );
      const frame = new ArtifactFrame(RENDERER, {
        save,
        upload,
        recordFile: vi.fn().mockResolvedValue(undefined),
      });
      document.body.append(frame.element);
      frame.update("<p>x</p>", { editable: true, page: false, dark: false });
      frame.setData('{"n":1}');
      vi.runAllTimers();
      vi.useRealTimers();
      const post = vi
        .spyOn(frame.iframe.contentWindow!, "postMessage")
        .mockImplementation(() => {});

      frame.handleMessage({ type: MessageType.Ready });
      expect(post).toHaveBeenLastCalledWith(
        {
          type: MessageType.Render,
          html: "<p>x</p>",
          data: { n: 1 },
          canEdit: true,
        },
        "*"
      );

      frame.handleMessage({
        type: MessageType.Rpc,
        id: 1,
        method: "save",
        args: [{ n: 2 }],
      });
      await vi.waitFor(() =>
        expect(save).toHaveBeenCalledWith(frame, { n: 2 })
      );
      await vi.waitFor(() =>
        expect(post).toHaveBeenLastCalledWith(
          { type: MessageType.RpcResult, id: 1, ok: true, result: null },
          "*"
        )
      );

      const file = new File(["hello"], "note.txt", { type: "text/plain" });
      frame.handleMessage({
        type: MessageType.Rpc,
        id: 2,
        method: "upload",
        args: [file],
      });
      await vi.waitFor(() =>
        expect(post).toHaveBeenLastCalledWith(
          expect.objectContaining({
            id: 2,
            ok: true,
            result: expect.objectContaining({ name: "note.txt", size: 5 }),
          }),
          "*"
        )
      );

      frame.handleMessage({
        type: MessageType.Rpc,
        id: 3,
        method: "file",
        args: ["https://evil.example.com/x"],
      });
      await vi.waitFor(() =>
        expect(post).toHaveBeenLastCalledWith(
          expect.objectContaining({ id: 3, ok: false }),
          "*"
        )
      );

      // Own attachments are opened only when uploaded here or in saved data.
      const own = `${window.location.origin}/api/attachments.redirect?id=7`;
      const fetchSpy = vi
        .spyOn(window, "fetch")
        .mockResolvedValue(new Response(new Blob(["img"])));
      frame.handleMessage({
        type: MessageType.Rpc,
        id: 5,
        method: "file",
        args: [own],
      });
      await vi.waitFor(() =>
        expect(post).toHaveBeenLastCalledWith(
          expect.objectContaining({
            id: 5,
            ok: false,
            error: expect.stringMatching(/only open files/),
          }),
          "*"
        )
      );
      expect(fetchSpy).not.toHaveBeenCalled();
      // Listing the URL in its own saved data is not enough.
      frame.setData(JSON.stringify({ files: [{ url: own }] }, null, 2));
      frame.handleMessage({
        type: MessageType.Rpc,
        id: 55,
        method: "file",
        args: [own],
      });
      await vi.waitFor(() =>
        expect(post).toHaveBeenLastCalledWith(
          expect.objectContaining({ id: 55, ok: false }),
          "*"
        )
      );
      expect(fetchSpy).not.toHaveBeenCalled();
      frame.recordedFiles = [own];
      frame.handleMessage({
        type: MessageType.Rpc,
        id: 6,
        method: "file",
        args: [own],
      });
      await vi.waitFor(() =>
        expect(post).toHaveBeenLastCalledWith(
          expect.objectContaining({ id: 6, ok: true }),
          "*"
        )
      );
      fetchSpy.mockRestore();

      // Data changed elsewhere reaches the running artifact without a reload.
      const src = frame.iframe.src;
      frame.setData('{"n":3}');
      expect(post).toHaveBeenLastCalledWith(
        { type: MessageType.Data, data: { n: 3 } },
        "*"
      );
      expect(frame.iframe.src).toBe(src);

      // A read-only viewer cannot save.
      frame.update("<p>x</p>", { editable: false, page: false, dark: false });
      frame.handleMessage({
        type: MessageType.Rpc,
        id: 4,
        method: "save",
        args: [{}],
      });
      await vi.waitFor(() =>
        expect(post).toHaveBeenLastCalledWith(
          expect.objectContaining({
            id: 4,
            ok: false,
            error: expect.stringMatching(/read-only/),
          }),
          "*"
        )
      );
      frame.element.remove();
    });
  });
});
