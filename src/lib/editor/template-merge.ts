import type { EditorElement, EditorScene } from "@/lib/editor/schema";
import type { PageLabel } from "@/lib/constants";
import type {
  RenderableEditorElement,
  TemplateElementsByPage,
  MergedPageScene,
} from "./template-types";

/**
 * Merge template elements and user elements into a single renderable list.
 *
 * Template elements are always rendered BELOW user elements.
 * z-index is preserved within each layer but NOT normalized across layers.
 * Each element is tagged with `layer: "template" | "user"` for the editor
 * to determine interaction behavior.
 */
export function mergeLayers(
  templateElements: EditorElement[],
  userElements: EditorElement[],
): RenderableEditorElement[] {
  const taggedTemplate = templateElements.map((element) => ({
    ...element,
    layer: "template" as const,
  }));

  const taggedUser = userElements.map((element) => ({
    ...element,
    layer: "user" as const,
  }));

  // Template layer first (below), then user layer (above)
  return [...taggedTemplate, ...taggedUser];
}

/**
 * Build a merged scene for rendering from page metadata, template elements,
 * and user elements.
 */
export function buildMergedPageScene(
  page: EditorScene["page"],
  templateElements: EditorElement[],
  userElements: EditorElement[],
): MergedPageScene {
  return {
    page,
    elements: mergeLayers(templateElements, userElements),
  };
}

/**
 * Strip layer metadata from renderable elements, returning only user-layer
 * elements for persistence. This should be called before saving to the DB.
 */
export function extractUserElements(
  mergedElements: RenderableEditorElement[],
): EditorElement[] {
  return mergedElements
    .filter((element) => element.layer === "user")
    .map(({ layer: _layer, ...rest }) => rest);
}

/**
 * Check if an element ID belongs to the template layer.
 */
export function isTemplateElement(
  elementId: string,
  templateElements: EditorElement[],
): boolean {
  return templateElements.some((element) => element.id === elementId);
}

/**
 * Organize a flat list of parsed template elements by page label.
 */
export function organizeTemplateElementsByPage(
  elements: Array<{ pageLabel: string; element: EditorElement }>,
): TemplateElementsByPage {
  const result: Partial<TemplateElementsByPage> = {};

  for (const { pageLabel, element } of elements) {
    if (!result[pageLabel as PageLabel]) {
      result[pageLabel as PageLabel] = [];
    }
    result[pageLabel as PageLabel]!.push(element);
  }

  return result as TemplateElementsByPage;
}
