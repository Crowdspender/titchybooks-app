import type { EditorElement, EditorScene } from "@/lib/editor/schema";
import type { PageLabel } from "@/lib/constants";

// ---------------------------------------------------------------------------
// Renderable element – an EditorElement tagged with layer metadata in-memory.
// The `layer` field is NEVER persisted to the database; it is added during
// the merge step and stripped before saving.
// ---------------------------------------------------------------------------
export type RenderableEditorElement = EditorElement & {
  layer: "template" | "user";
};

// ---------------------------------------------------------------------------
// Template element as stored in the database
// ---------------------------------------------------------------------------
export interface TemplateElementRecord {
  id: string;
  templateId: string;
  pageLabel: string;
  order: number;
  elementJson: string; // JSON-encoded EditorElement
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Parsed template element (elementJson parsed into EditorElement)
// ---------------------------------------------------------------------------
export interface ParsedTemplateElement {
  id: string; // TemplateElement record ID
  templateId: string;
  pageLabel: PageLabel;
  order: number;
  element: EditorElement;
}

// ---------------------------------------------------------------------------
// Template API response types
// ---------------------------------------------------------------------------

export interface TemplateListItem {
  id: string;
  title: string | null;
  status: string;
  version: number;
  isTemplate: boolean;
  publishedAt: string | null;
  createdAt: string;
  instanceCount: number;
}

export interface TemplateDetail extends TemplateListItem {
  pages: Array<{
    pageLabel: PageLabel;
    elements: EditorElement[];
  }>;
}

export interface PublicTemplateListItem {
  id: string;
  title: string | null;
  previewImage: string | null;
  createdAt: string;
}

export interface PublicTemplateDetail {
  id: string;
  title: string | null;
  previewPages: Array<{
    pageLabel: PageLabel;
    elements: EditorElement[];
  }>;
}

// ---------------------------------------------------------------------------
// Instance creation from template
// ---------------------------------------------------------------------------
export interface CreateInstanceFromTemplatePayload {
  templateId: string;
}

export interface CreateInstanceFromTemplateResponse {
  submission: {
    id: string;
    templateId: string;
    templateVersion: number;
    status: string;
  };
}

// ---------------------------------------------------------------------------
// Merge helper types
// ---------------------------------------------------------------------------

/** Template elements keyed by page label for quick lookup */
export type TemplateElementsByPage = Record<PageLabel, EditorElement[]>;

/** Result of merging template + user elements for rendering */
export interface MergedPageScene {
  page: EditorScene["page"];
  elements: RenderableEditorElement[];
}
