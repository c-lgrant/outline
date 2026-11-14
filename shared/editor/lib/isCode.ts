import type { Node } from "prosemirror-model";

export function isCode(node: Node) {
  return node.type.name === "code_block" || node.type.name === "code_fence";
}

/**
 * Returns true if the node is a code block with Mermaid language (supports both "mermaid" and "mermaidjs").
 *
 * @param node The node to check.
 * @returns true if the node is a Mermaid code block.
 */
export function isMermaid(node: Node) {
  return (
    isCode(node) &&
    (node.attrs.language === "mermaid" || node.attrs.language === "mermaidjs")
  );
}

/** The code block language that renders its HTML source as a live widget. */
export const HTML_ARTIFACT_LANGUAGE = "html-live";

/** The code block language that renders its HTML source as a full page. */
export const HTML_PAGE_LANGUAGE = "html-page";

/**
 * Returns true if the node is a code block whose HTML source should be
 * rendered as a live, sandboxed artifact, either a widget or a full page.
 *
 * @param node The node to check.
 * @returns true if the node is a live HTML code block.
 */
export function isHtmlArtifact(node: Node) {
  return (
    isCode(node) &&
    (node.attrs.language === HTML_ARTIFACT_LANGUAGE ||
      node.attrs.language === HTML_PAGE_LANGUAGE)
  );
}

/**
 * Returns true if the node is a live HTML code block shown as a full page.
 *
 * @param node The node to check.
 * @returns true if the node is a full page HTML code block.
 */
export function isHtmlPage(node: Node) {
  return isCode(node) && node.attrs.language === HTML_PAGE_LANGUAGE;
}
