"use client";

import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import {
  browserStorage,
  type DocumentSeed,
  DraftPersistence,
  draftPointerStorage,
} from "@/lib/editor/persistence";
import { redoHistory, undoHistory } from "@/lib/editor/history";
import { toast } from "sonner";
import {
  PAGE_LABEL_DISPLAY,
  PAGE_LABELS,
  PAGE_READING_ORDER,
  type PageLabel,
} from "@/lib/constants";
import type { EditorElement, EditorScene } from "@/lib/editor/schema";
import { createEmptySubmissionPageSeeds } from "@/lib/editor/validation";
import { isTemplateElement, mergeLayers } from "@/lib/editor/template-merge";
import { parsePinnedTemplate } from "@/lib/ai/template-contract";
import type {
  RenderableEditorElement,
  TemplateElementsByPage,
} from "@/lib/editor/template-types";
import LayerPanel from "./LayerPanel";
import PropertiesPanel from "./PropertiesPanel";
import BookDesignPanel from "./BookDesignPanel";
import { isProtectedDesign, resolveSceneDesign } from "@/lib/editor/design";
import {
  applyCanvasGeometry,
  applyDesignAction,
  type DesignAction,
} from "@/lib/editor/design-actions";
import {
  loadBrowserDesignFont,
  requiredDesignFonts,
} from "@/lib/editor/design-fonts";
import { preflightDesign } from "@/lib/editor/design-preflight";
import { renderPageThumbnail } from "@/lib/editor/page-thumbnail";
import OrderPanel from "@/components/orders/OrderPanel";
import AiChatPanel from "./AiChatPanel";
import BookletPreview from "./BookletPreview";
import PageFilmstrip from "./PageFilmstrip";
import ColorPicker from "./ColorPicker";
import type { BookContext } from "@/lib/ai/system-prompt";
import type { AiSuggestion } from "@/lib/ai/protocol";
import { PANELS } from "@/lib/pdf/layout";

const EditorCanvas = dynamic(() => import("./EditorCanvas"), {
  ssr: false,
  loading: () => (
    <div className="card p-4">
      <div
        className="mx-auto h-[600px] w-[420px] animate-pulse rounded-xl"
        style={{ background: "var(--color-surface)" }}
      />
    </div>
  ),
});

const ACTIVE_DRAFT_STORAGE_KEY = "titchybook-active-editor-draft";
const UNDO_REDO_MAX_HISTORY = 50;

// Module-level state to prevent duplicate draft creation during React Strict Mode.
// Strict Mode mounts, unmounts, and remounts components, causing useEffect to run twice.
// This state persists across those cycles to ensure only one POST request is made.
let pendingDraftCreation: Promise<string> | null = null;

interface AssetRecord {
  id: string;
  originalFilename: string;
  mimeType: string;
  width: number | null;
  height: number | null;
  downloadUrl: string | null;
  previewUrl: string | null;
}

interface HistoryEntry {
  pageScenes: Record<PageLabel, string>;
  title: string;
}

interface UndoRedoState {
  past: HistoryEntry[];
  present: HistoryEntry | null;
  future: HistoryEntry[];
}

interface PageRecord {
  id?: string;
  revision: number;
  pageLabel: PageLabel;
  order: number;
  scene: EditorScene;
  sceneJson: string;
}

interface SubmissionRecord {
  id: string;
  userId: string;
  revision: number;
  title: string | null;
  status: string;
  mode: string;
  isTemplate: boolean;
  templateId: string | null;
  templateVersion: number | null;
  /** Frozen template scenes an AI book was composed against. */
  pinnedTemplate?: unknown;
  pages: PageRecord[];
}

function normalizePages(
  pages: Array<{
    id?: string;
    pageLabel: PageLabel;
    order: number;
    scene?: EditorScene;
    sceneJson?: string;
    revision?: number;
  }>,
): Record<PageLabel, PageRecord> {
  const fallbackPages = createEmptySubmissionPageSeeds();
  const baseRecord = Object.fromEntries(
    fallbackPages.map((page) => [
      page.pageLabel,
      {
        pageLabel: page.pageLabel,
        order: page.order,
        revision: 0,
        scene: page.scene,
        sceneJson: page.sceneJson,
      },
    ]),
  ) as Record<PageLabel, PageRecord>;

  for (const page of pages) {
    // If page has a parsed scene, use it and regenerate sceneJson
    // Otherwise use sceneJson if available
    const scene = page.scene ??
      (page.sceneJson
        ? JSON.parse(page.sceneJson)
        : fallbackPages.find((p) => p.pageLabel === page.pageLabel)?.scene);
    const sceneJson = page.sceneJson ?? JSON.stringify(scene);

    baseRecord[page.pageLabel] = {
      id: page.id,
      revision: page.revision ?? 0,
      pageLabel: page.pageLabel,
      order: page.order,
      scene,
      sceneJson,
    };
  }

  return baseRecord;
}

function normalizeSceneZIndexes(scene: EditorScene): EditorScene {
  return {
    ...scene,
    elements: scene.elements
      .slice()
      .sort((left, right) => left.zIndex - right.zIndex)
      .map((element, index) => ({
        ...element,
        zIndex: index,
      })),
  };
}

function cloneElement(
  element: EditorElement,
  zIndex: number,
): EditorElement {
  return {
    ...element,
    id: crypto.randomUUID(),
    x: element.x + 24,
    y: element.y + 24,
    zIndex,
  };
}

function createTextElement(
  scene: EditorScene,
): Extract<EditorElement, { type: "text" }> {
  return {
    id: crypto.randomUUID(),
    type: "text",
    x: 72,
    y: 88,
    width: scene.page.widthPx - 144,
    height: 180,
    rotation: 0,
    opacity: 1,
    locked: false,
    visible: true,
    zIndex: scene.elements.length,
    text: "Add your story here",
    fontFamily: "Arial",
    fontSize: 36,
    fontWeight: 500,
    lineHeight: 1.25,
    letterSpacing: 0,
    color: "#1c1917",
    align: "left",
    verticalAlign: "top",
  };
}

function createImageElement(
  scene: EditorScene,
  asset: AssetRecord,
): Extract<EditorElement, { type: "image" }> {
  const sourceWidth = asset.width ?? 1200;
  const sourceHeight = asset.height ?? 1600;
  const maxWidth = Math.min(scene.page.widthPx - 120, 340);
  const width = maxWidth;
  const height = Math.min(
    scene.page.heightPx - 160,
    width * (sourceHeight / sourceWidth),
  );

  return {
    id: crypto.randomUUID(),
    type: "image",
    x: (scene.page.widthPx - width) / 2,
    y: (scene.page.heightPx - height) / 2,
    width,
    height,
    rotation: 0,
    opacity: 1,
    locked: false,
    visible: true,
    zIndex: scene.elements.length,
    assetId: asset.id,
    crop: {
      x: 0,
      y: 0,
      scaleX: 1,
      scaleY: 1,
    },
  };
}

function createShapeElement(
  scene: EditorScene,
  shape: "rect" | "circle" | "line",
): Extract<EditorElement, { type: "shape" }> {
  const isLine = shape === "line";
  const width = isLine ? 200 : 180;
  const height = isLine ? 2 : 120; // Lines use strokeWidth for visual thickness

  return {
    id: crypto.randomUUID(),
    type: "shape",
    x: (scene.page.widthPx - width) / 2,
    y: (scene.page.heightPx - height) / 2,
    width,
    height,
    rotation: 0,
    opacity: 1,
    locked: false,
    visible: true,
    zIndex: scene.elements.length,
    shape,
    fill: isLine ? "transparent" : "#e5e7eb",
    stroke: isLine ? "#1c1917" : undefined,
    strokeWidth: isLine ? 3 : undefined,
  };
}

async function getImageDimensions(file: File): Promise<{
  width: number;
  height: number;
}> {
  const objectUrl = URL.createObjectURL(file);

  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const nextImage = new window.Image();
      nextImage.onload = () => resolve(nextImage);
      nextImage.onerror = () => reject(new Error("Could not read image"));
      nextImage.src = objectUrl;
    });

    return {
      width: image.naturalWidth,
      height: image.naturalHeight,
    };
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

export default function EditorWorkspace({
  submissionId,
  forceNew,
}: {
  submissionId?: string;
  forceNew?: boolean;
}) {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [loadingMessage, setLoadingMessage] = useState("Preparing editor...");
  const [submission, setSubmission] = useState<SubmissionRecord | null>(null);
  const [pagesByLabel, setPagesByLabel] = useState<
    Record<PageLabel, PageRecord>
  >(
    () => normalizePages([]),
  );
  const [activePageLabel, setActivePageLabel] = useState<PageLabel>(
    "FRONT_COVER",
  );
  const [selectedElementId, setSelectedElementId] = useState<string | null>(
    null,
  );
  const [saveState, setSaveState] = useState<
    "idle" | "saving" | "saved" | "error"
  >(
    "idle",
  );
  const [title, setTitle] = useState("");
  const [assets, setAssets] = useState<AssetRecord[]>([]);
  const [assetUploading, setAssetUploading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [navigating, setNavigating] = useState(false);
  const [history, setHistory] = useState<UndoRedoState>({
    past: [],
    present: null,
    future: [],
  });
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [pageThumbnails, setPageThumbnails] = useState<
    Record<PageLabel, string | null>
  >(
    () =>
      Object.fromEntries(PAGE_LABELS.map((label) => [label, null])) as Record<
        PageLabel,
        string | null
      >,
  );
  const [previewOpen, setPreviewOpen] = useState(false);
  const [navDirection, setNavDirection] = useState<"forward" | "backward">(
    "forward",
  );
  const [viewportHeight, setViewportHeight] = useState(() =>
    typeof window === "undefined" ? 0 : window.innerHeight
  );
  const [viewportWidth, setViewportWidth] = useState(() =>
    typeof window === "undefined" ? 0 : window.innerWidth
  );

  // AI Chat panel state
  const [aiPanelOpen, setAiPanelOpen] = useState(false);

  // Template system state
  const [templateElements, setTemplateElements] = useState<
    TemplateElementsByPage
  >(
    () =>
      Object.fromEntries(
        PAGE_LABELS.map((label) => [label, []]),
      ) as unknown as TemplateElementsByPage,
  );

  // Derived mode flags
  const isInstanceMode = submission?.templateId != null;

  const persistenceRef = useRef<DraftPersistence | null>(null);
  const frozenRef = useRef(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const submissionIdRef = useRef<string | null>(null);

  const activePage = pagesByLabel[activePageLabel];
  const readingIndex = PAGE_READING_ORDER.indexOf(activePageLabel);
  // Leave room for the top bar, page header, filmstrip and padding so the
  // whole page stays visible on tall screens; never shrink below 560px.
  const stageMaxHeight = Math.max(560, viewportHeight - 360);
  // At xl the studio is a viewport-height frame and the canvas fits its
  // measured column; the window-based cap only applies below xl.
  const isXl = viewportWidth >= 1280;
  const elementCounts = useMemo(
    () =>
      Object.fromEntries(
        PAGE_LABELS.map((label) => [
          label,
          pagesByLabel[label].scene.elements.length,
        ]),
      ) as Record<PageLabel, number>,
    [pagesByLabel],
  );

  // Derive merged render scene for the active page
  const activeTemplateElements = useMemo(
    () => templateElements[activePageLabel] ?? [],
    [templateElements, activePageLabel],
  );
  const designGesture = useRef({ active: false, recorded: false });
  const [fontRetry, setFontRetry] = useState(0);
  const [fontLoad, setFontLoad] = useState({ key: "", error: "" });
  const resolvedPages = useMemo(() => {
    const pinned = isInstanceMode
      ? parsePinnedTemplate(submission?.pinnedTemplate)
      : null;
    return Object.fromEntries(PAGE_LABELS.map((label) => {
      try {
        return [label, {
          scene: resolveSceneDesign(
            pagesByLabel[label].scene,
            templateElements[label],
            pinned?.pages.find((page) => page.pageLabel === label)
              ?.backgroundColor,
          ),
          error: "",
        }];
      } catch (error) {
        return [label, {
          scene: { ...pagesByLabel[label].scene, elements: [] },
          error: error instanceof Error ? error.message : "Invalid design",
        }];
      }
    })) as Record<PageLabel, { scene: EditorScene; error: string }>;
  }, [
    pagesByLabel,
    templateElements,
    isInstanceMode,
    submission?.pinnedTemplate,
  ]);
  const fontKey = useMemo(() => {
    try {
      return JSON.stringify(
        requiredDesignFonts(PAGE_LABELS.flatMap((label) =>
          resolvedPages[label].scene.elements
        )),
      );
    } catch {
      return "invalid";
    }
  }, [resolvedPages]);
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        if (fontKey === "invalid") throw new Error("Unqualified font in scene");
        await Promise.all(
          (JSON.parse(fontKey) as string[]).map(loadBrowserDesignFont),
        );
        if (!cancelled) setFontLoad({ key: fontKey, error: "" });
      } catch (error) {
        if (!cancelled) {
          setFontLoad({
            key: fontKey,
            error: error instanceof Error ? error.message : "Font unavailable",
          });
        }
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [fontKey, fontRetry]);
  const fontStatus = fontLoad.key !== fontKey
    ? "Loading qualified fonts…"
    : fontLoad.error || null;
  const designIssues = useMemo(() =>
    PAGE_LABELS.flatMap((label) => {
      const entry = resolvedPages[label];
      if (entry.error) {
        return [{
          elementId: "",
          severity: "error" as const,
          message: `${PAGE_LABEL_DISPLAY[label]}: ${entry.error}`,
        }];
      }
      if (fontStatus) return [];
      return preflightDesign(entry.scene, label).map((issue) => ({
        ...issue,
        message: `${PAGE_LABEL_DISPLAY[label]}: ${issue.message}`,
      }));
    }), [resolvedPages, fontStatus]);
  const activeResolvedScene = resolvedPages[activePageLabel].scene;

  // Asset dimensions map for DPI calculations
  const assetDimensionsMap = useMemo(
    () => {
      const map = new Map<string, { width: number; height: number }>();
      for (const asset of assets) {
        if (asset.width != null && asset.height != null) {
          map.set(asset.id, { width: asset.width, height: asset.height });
        }
      }
      return map;
    },
    [assets],
  );

  // Physical dimensions of the active page in mm (from PANELS layout)
  const activePanel = PANELS.find((p) => p.pageLabel === activePageLabel);
  const physicalWidthMm = activePanel?.width ?? 69.3;
  const physicalHeightMm = activePanel?.height ?? 98;

  // Template elements with user-level text overrides applied. Only the
  // `text` field of text-type template elements is overridable; all other
  // visual properties (position, size, font, color, etc.) remain locked.
  const activeTemplateElementsWithOverrides = useMemo(
    () => activeResolvedScene.elements.slice(0, activeTemplateElements.length),
    [activeResolvedScene, activeTemplateElements.length],
  );

  const mergedElements: RenderableEditorElement[] = useMemo(
    () =>
      mergeLayers(
        activeTemplateElementsWithOverrides,
        activeResolvedScene.elements.slice(activeTemplateElements.length),
      ),
    [
      activeTemplateElementsWithOverrides,
      activeResolvedScene,
      activeTemplateElements.length,
    ],
  );

  const selectedElement = useMemo(
    () =>
      mergedElements.find((element) => element.id === selectedElementId) ??
        null,
    [mergedElements, selectedElementId],
  );

  // Build AI book context from current editor state
  const aiBookContext: BookContext = useMemo(() => {
    return {
      title,
      activePage: activePageLabel,
      pages: PAGE_LABELS.map((label) => {
        const page = pagesByLabel[label];
        const textSnippets = page.scene.elements
          .filter((el): el is Extract<EditorElement, { type: "text" }> =>
            el.type === "text"
          )
          .map((el) => el.text.slice(0, 200))
          .filter((t) => t.length > 0);
        // Also include template text overrides
        const overrides = page.scene.templateTextOverrides ?? {};
        const overrideTexts = Object.values(overrides).map((t) =>
          t.slice(0, 200)
        );
        return {
          label,
          elementCount: page.scene.elements.length,
          textSnippets: [...textSnippets, ...overrideTexts],
        };
      }),
    };
  }, [title, activePageLabel, pagesByLabel]);

  useEffect(() => {
    let cancelled = false;

    async function loadAssets() {
      const response = await fetch("/api/assets");
      if (!response.ok) {
        throw new Error("Could not load assets");
      }

      const data = (await response.json()) as { assets: AssetRecord[] };
      if (!cancelled) {
        setAssets(
          data.assets.map((asset) => ({
            ...asset,
            downloadUrl: asset.downloadUrl,
            previewUrl: asset.previewUrl ?? asset.downloadUrl,
          })),
        );
      }
    }

    async function createDraft(): Promise<string> {
      // If a draft creation is already in progress (from Strict Mode's first effect run),
      // return the same promise to avoid making a duplicate POST request.
      if (pendingDraftCreation) {
        return pendingDraftCreation;
      }

      // Create and cache the promise immediately to prevent race conditions
      // when Strict Mode's second effect run calls this function.
      pendingDraftCreation = (async () => {
        setLoadingMessage("Creating your draft...");

        try {
          const response = await fetch("/api/submissions", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              mode: "EDITOR",
              title: "",
            }),
          });

          if (!response.ok) {
            throw new Error("Could not create editor draft");
          }

          const data = (await response.json()) as {
            submission: { id: string };
          };

          return data.submission.id;
        } finally {
          // Clear the pending promise so future "new" creations can proceed
          pendingDraftCreation = null;
        }
      })();

      return pendingDraftCreation;
    }

    async function loadSubmission(submissionId: string) {
      setLoadingMessage("Loading your draft...");
      const response = await fetch(`/api/submissions/${submissionId}`);
      if (!response.ok) {
        throw new Error("Could not load editor draft");
      }

      const data = (await response.json()) as {
        submission: SubmissionRecord;
      };

      if (cancelled) {
        return;
      }

      const nextSubmission = data.submission;

      // Prevent loading a non-draft submission as an active draft
      // This prevents submitted/deleted submissions from being reused
      if (nextSubmission.status !== "DRAFT" && !nextSubmission.isTemplate) {
        throw new Error("Submission is no longer in draft status");
      }

      let nextPages = normalizePages(nextSubmission.pages);
      let nextTemplateElements: TemplateElementsByPage = Object.fromEntries(
        PAGE_LABELS.map((label) => [label, [] as EditorElement[]]),
      ) as unknown as TemplateElementsByPage;

      // Determine the effective templateId to load elements from:
      //  - Admin editing a template (isTemplate=true): use the template's
      //    OWN id; fetched elements will be injected into sceneJson as
      //    editable elements (no locked layer).
      //  - User instance linked to a template: use the parent templateId;
      //    fetched elements will be rendered as the locked background layer.
      const effectiveTemplateId = nextSubmission.isTemplate
        ? nextSubmission.id
        : nextSubmission.templateId;

      // An AI book carries its own frozen copy of the template scenes. The
      // approved design is what the editor must show, so the pinned elements
      // win over the live template: editing or versioning the template later
      // cannot change a book that already exists. A detached book has no
      // template link left — its pages already contain those elements, so
      // adding the pinned layer on top would duplicate every element.
      const pinned = nextSubmission.templateId
        ? parsePinnedTemplate(nextSubmission.pinnedTemplate)
        : null;
      if (pinned && !nextSubmission.isTemplate) {
        const pinnedByPage = new Map(
          pinned.pages.map((page) => [page.pageLabel, page]),
        );
        for (const label of PAGE_LABELS) {
          nextTemplateElements[label] = pinnedByPage.get(label)?.elements ?? [];
        }
      }

      if (effectiveTemplateId) {
        try {
          const templateResponse = await fetch(
            `/api/templates/${effectiveTemplateId}/elements`,
          );
          if (templateResponse.ok) {
            const templateData = (await templateResponse.json()) as {
              templateElements: Array<
                { pageLabel: string; elementJson: string }
              >;
              templateAssets?: Array<{
                id: string;
                originalFilename: string;
                mimeType: string;
                width: number | null;
                height: number | null;
                downloadUrl: string;
                previewUrl: string;
              }>;
            };

            if (cancelled) return;
            // Merge template-referenced assets into the local assets state so
            // that image elements in the template layer can resolve their
            // `assetId` via assetMap. Admin-owned assets would otherwise be
            // absent from /api/assets (which is scoped to the caller's uid).
            if (templateData.templateAssets?.length) {
              setAssets((current) => {
                const existingIds = new Set(current.map((a) => a.id));
                const extras = templateData.templateAssets!
                  .filter((a) => !existingIds.has(a.id))
                  .map<AssetRecord>((a) => ({
                    id: a.id,
                    originalFilename: a.originalFilename,
                    mimeType: a.mimeType,
                    width: a.width,
                    height: a.height,
                    downloadUrl: a.downloadUrl,
                    previewUrl: a.previewUrl,
                  }));
                return extras.length ? [...current, ...extras] : current;
              });
            }

            const elementsByPage: Record<PageLabel, EditorElement[]> = Object
              .fromEntries(
                PAGE_LABELS.map((label) => [label, [] as EditorElement[]]),
              ) as Record<PageLabel, EditorElement[]>;

            for (const te of templateData.templateElements) {
              const label = te.pageLabel as PageLabel;
              if (elementsByPage[label]) {
                elementsByPage[label].push(
                  JSON.parse(te.elementJson) as EditorElement,
                );
              }
            }

            if (nextSubmission.isTemplate) {
              // Admin is editing the template itself: the template's
              // elements are the editable scene. Merge them into each
              // page's scene so the canvas has something to render and
              // the admin can edit/move/delete them.
              const updatedPages: Record<PageLabel, PageRecord> = {} as Record<
                PageLabel,
                PageRecord
              >;
              for (const label of PAGE_LABELS) {
                const page = nextPages[label];
                const mergedScene: EditorScene = {
                  ...page.scene,
                  elements: elementsByPage[label],
                };
                updatedPages[label] = {
                  ...page,
                  scene: mergedScene,
                  sceneJson: JSON.stringify(mergedScene),
                };
              }
              nextPages = updatedPages;
            } else if (!pinned) {
              // Instance: template elements are the locked background layer.
              // Pinned books already installed theirs above and must not be
              // replaced by the live template.
              nextTemplateElements = elementsByPage as TemplateElementsByPage;
            }
          }
        } catch {
          // Template may have been deleted or unreachable – fallback to
          // empty template layer so the editor still opens.
          console.warn(
            `Could not load template elements for template ${effectiveTemplateId}`,
          );
        }
      }

      if (cancelled) return;
      let nextTitle = nextSubmission.title ?? "Untitled Titchybooks";
      const seed = Object.fromEntries(
        PAGE_LABELS.map(
          (label) => [label, {
            value: nextPages[label].sceneJson,
            revision: nextPages[label].revision,
          }],
        ),
      ) as DocumentSeed;
      seed.title = { value: nextTitle, revision: nextSubmission.revision };
      const storage = browserStorage();
      const persistence = new DraftPersistence(
        nextSubmission.id,
        nextSubmission.userId,
        seed,
        async (part, value, revision) => {
          const response = await fetch(
            `/api/submissions/${nextSubmission.id}${
              part === "title" ? "" : `/pages/${part}`
            }`,
            {
              method: part === "title" ? "PATCH" : "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(
                part === "title"
                  ? { title: value, revision }
                  : { scene: JSON.parse(value), revision },
              ),
            },
          );
          const result = await response.json();
          if (!response.ok) {
            throw new Error(result.error || "Could not save your changes");
          }
          return part === "title"
            ? result.submission.revision
            : result.page.revision;
        },
        (state) => {
          if (!cancelled) {
            setSaveState(state);
            if (state === "saved") setSaveError(null);
          }
        },
        storage,
        () =>
          toast.warning(
            "Local recovery storage is unavailable. Keep this tab open until changes are saved.",
          ),
      );
      persistenceRef.current = persistence;
      if (!storage) {
        toast.warning(
          "Local recovery storage is unavailable. Keep this tab open until changes are saved.",
        );
      }
      const recovery = persistence.readRecovery();
      if (
        recovery &&
        confirm(
          "Unsaved local changes were found. Restore them? Cancel discards the local recovery copy.",
        )
      ) {
        persistence.restore(recovery);
        nextTitle = recovery.title?.value ?? nextTitle;
        for (const label of PAGE_LABELS) {
          const part = recovery[label];
          if (part) {
            nextPages[label] = {
              ...nextPages[label],
              scene: JSON.parse(part.value),
              sceneJson: part.value,
            };
          }
        }
      } else if (recovery) persistence.clearRecovery();
      setSubmission(nextSubmission);
      setTitle(nextTitle);
      setPagesByLabel(nextPages);
      setTemplateElements(nextTemplateElements);
      setActivePageLabel("FRONT_COVER");
      setSelectedElementId(null);
      submissionIdRef.current = nextSubmission.id;
      frozenRef.current = false;
      draftPointerStorage.setItem(ACTIVE_DRAFT_STORAGE_KEY, nextSubmission.id);

      // Initialize history
      const initialSnapshot: HistoryEntry = {
        pageScenes: Object.fromEntries(
          PAGE_LABELS.map((label) => [label, nextPages[label].sceneJson]),
        ) as Record<PageLabel, string>,
        title: nextTitle,
      };
      setHistory({
        past: [],
        present: initialSnapshot,
        future: [],
      });
      setCanUndo(false);
      setCanRedo(false);
    }

    async function boot() {
      try {
        // Reset state when navigating between different submissions or to forceNew
        // This ensures stale data from the previous submission doesn't persist
        setLoading(true);
        setLoadingMessage("Preparing editor...");
        setSubmission(null);
        setPagesByLabel(normalizePages([]));
        setActivePageLabel("FRONT_COVER");
        setSelectedElementId(null);
        setTitle("");
        setTemplateElements(
          Object.fromEntries(
            PAGE_LABELS.map((label) => [label, [] as EditorElement[]]),
          ) as unknown as TemplateElementsByPage,
        );
        setHistory({ past: [], present: null, future: [] });
        setCanUndo(false);
        setCanRedo(false);
        setSaveState("idle");
        setSaveError(null);
        setNavigating(false);
        setSubmitting(false);
        frozenRef.current = false;
        submissionIdRef.current = null;
        persistenceRef.current?.dispose();
        persistenceRef.current = null;

        await loadAssets();
        if (cancelled) return;

        // If forceNew is true, always create a new draft and ignore localStorage
        if (forceNew) {
          draftPointerStorage.removeItem(ACTIVE_DRAFT_STORAGE_KEY);
          const nextId = await createDraft();
          await loadSubmission(nextId);
        } // If submissionId is provided via URL, use it and clear localStorage
        else if (submissionId) {
          draftPointerStorage.removeItem(ACTIVE_DRAFT_STORAGE_KEY);
          await loadSubmission(submissionId);
        } else {
          const storedSubmissionId = draftPointerStorage.getItem(
            ACTIVE_DRAFT_STORAGE_KEY,
          );
          if (storedSubmissionId) {
            try {
              await loadSubmission(storedSubmissionId);
            } catch (error) {
              const message = error instanceof Error ? error.message : "";
              if (message.includes("no longer in draft status")) {
                toast.info(
                  "Previous draft was submitted. Creating a new draft...",
                );
              }
              draftPointerStorage.removeItem(ACTIVE_DRAFT_STORAGE_KEY);
              const nextId = await createDraft();
              await loadSubmission(nextId);
            }
          } else {
            const nextId = await createDraft();
            await loadSubmission(nextId);
          }
        }
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : "Failed to start editor",
        );
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    // In React Strict Mode, useEffect runs twice (mount → unmount → remount).
    // The `cancelled` flag prevents the first (unmounted) effect from updating state.
    // However, both invocations share the same module-level `pendingDraftCreation`,
    // ensuring only ONE POST request is made to create the draft.
    //
    // Dependencies: When `forceNew` or `submissionId` changes (e.g., navigating from
    // /create?submissionId=xyz to /create?new=true), we need to re-run the boot
    // sequence to load the correct submission or create a new draft.
    void boot();

    return () => {
      cancelled = true;
      // Keep pending draft creation shared until it settles; dispose only this editor's saves.
      persistenceRef.current?.dispose();
      persistenceRef.current = null;
    };
  }, [forceNew, submissionId]);

  useEffect(() => {
    const persistence = persistenceRef.current;
    if (!submission || !persistence || persistence.id !== submission.id) return;
    persistence.set("title", title);
    const timeout = window.setTimeout(() => {
      void persistence.flush("title").catch((error) =>
        reportSaveError(error, persistence)
      );
    }, 700);
    return () => window.clearTimeout(timeout);
  }, [submission, title]);

  function reportSaveError(error: unknown, origin?: DraftPersistence) {
    if (origin && persistenceRef.current !== origin) return;
    const message = error instanceof Error ? error.message : "Save failed";
    setSaveError(message);
    toast.error(message);
  }

  const onHistoryKey = useEffectEvent((event: KeyboardEvent) => {
    if (
      frozenRef.current ||
      (event.target instanceof HTMLElement &&
        event.target.closest('input, textarea, [contenteditable="true"]'))
    ) return;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
      event.preventDefault();
      if (event.shiftKey) redo();
      else undo();
    }
  });
  // Keyboard shortcuts for undo/redo
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => onHistoryKey(event);
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const refreshThumbnails = useEffectEvent(() => updateThumbnails());
  // Update thumbnails when page changes
  useEffect(() => {
    const timeout = setTimeout(() => refreshThumbnails(), 500);
    return () => clearTimeout(timeout);
  }, [pagesByLabel, assets, resolvedPages, fontLoad]);

  useEffect(() => {
    const persistence = persistenceRef.current;
    if (!submission || !persistence || persistence.id !== submission.id) return;
    for (const label of PAGE_LABELS) {
      persistence.set(label, pagesByLabel[label].sceneJson);
    }
    const timeout = window.setTimeout(() => {
      void persistence.flushAll().catch((error) =>
        reportSaveError(error, persistence)
      );
    }, 800);
    return () => window.clearTimeout(timeout);
  }, [pagesByLabel, submission]);

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (persistenceRef.current?.dirty) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    const reconnect = () => {
      const persistence = persistenceRef.current;
      void persistence?.flushAll().catch((error) =>
        reportSaveError(error, persistence)
      );
    };
    window.addEventListener("beforeunload", beforeUnload);
    window.addEventListener("online", reconnect);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      window.removeEventListener("online", reconnect);
    };
  }, []);

  function syncDocument() {
    const persistence = persistenceRef.current;
    if (!persistence || persistence.id !== submission?.id) {
      throw new Error("Draft is not ready");
    }
    persistence.set("title", title);
    for (const label of PAGE_LABELS) {
      persistence.set(label, pagesByLabel[label].sceneJson);
    }
    return persistence;
  }

  function applyBookDesign(
    action: DesignAction,
    scope: "element" | "page" | "book",
  ) {
    if (frozenRef.current) return;
    try {
      const labels = scope === "book" ? PAGE_LABELS : [activePageLabel];
      const next = { ...pagesByLabel };
      let skipped = 0;
      for (const label of labels) {
        const result = applyDesignAction(
          next[label].scene,
          templateElements[label],
          action,
        );
        skipped += result.skipped;
        next[label] = {
          ...next[label],
          scene: result.scene,
          sceneJson: JSON.stringify(result.scene),
        };
      }
      if (
        labels.every((label) =>
          next[label].sceneJson === pagesByLabel[label].sceneJson
        )
      ) return;
      if (!designGesture.current.active || !designGesture.current.recorded) {
        pushHistory();
        designGesture.current.recorded = true;
      }
      for (const label of labels) {
        persistenceRef.current?.set(label, next[label].sceneJson);
      }
      setPagesByLabel(next);
      if (skipped && !designGesture.current.active) {
        toast.info(`${skipped} protected text element(s) skipped.`);
      }
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not apply design",
      );
    }
  }

  function updateScene(scene: EditorScene) {
    if (frozenRef.current) return;
    const ids = new Set(scene.elements.map((element) => element.id));
    const normalizedScene = normalizeSceneZIndexes({
      ...scene,
      ...(scene.elementStyleOverrides
        ? {
          elementStyleOverrides: Object.fromEntries(
            Object.entries(scene.elementStyleOverrides).filter(([id]) =>
              ids.has(id)
            ),
          ),
        }
        : {}),
    });
    if (!Object.keys(normalizedScene.elementStyleOverrides ?? {}).length) {
      delete normalizedScene.elementStyleOverrides;
    }
    const sceneJson = JSON.stringify(normalizedScene);

    // Push current state to history before updating
    pushHistory();

    setPagesByLabel((current) => ({
      ...current,
      [activePageLabel]: {
        ...current[activePageLabel],
        scene: normalizedScene,
        sceneJson,
      },
    }));
  }

  function createSnapshot(): HistoryEntry {
    return {
      pageScenes: Object.fromEntries(
        PAGE_LABELS.map((label) => [label, pagesByLabel[label].sceneJson]),
      ) as Record<PageLabel, string>,
      title,
    };
  }

  function pushHistory() {
    if (!submission) return;

    const currentSnapshot = createSnapshot();

    setHistory((prev) => ({
      past: [...prev.past.slice(-UNDO_REDO_MAX_HISTORY + 1), currentSnapshot],
      present: currentSnapshot,
      future: [],
    }));

    setCanUndo(true);
    setCanRedo(false);
  }

  function undo() {
    if (frozenRef.current) return;
    const nextHistory = undoHistory(history, createSnapshot());
    if (!nextHistory?.present) return;
    const previous = nextHistory.present;
    const newPast = nextHistory.past;

    // Restore the previous scene
    const restoredPages = Object.fromEntries(
      PAGE_LABELS.map((label) => {
        const scene = JSON.parse(previous.pageScenes[label]);
        return [
          label,
          {
            ...pagesByLabel[label],
            scene,
            sceneJson: previous.pageScenes[label],
          },
        ];
      }),
    ) as Record<PageLabel, PageRecord>;

    setPagesByLabel(restoredPages);
    setTitle(previous.title);
    setHistory(nextHistory);

    setCanUndo(newPast.length > 0);
    setCanRedo(true);
  }

  function redo() {
    if (frozenRef.current) return;
    const nextHistory = redoHistory(history, createSnapshot());
    if (!nextHistory?.present) return;
    const next = nextHistory.present;
    const newFuture = nextHistory.future;

    // Restore the next scene
    const restoredPages = Object.fromEntries(
      PAGE_LABELS.map((label) => {
        const scene = JSON.parse(next.pageScenes[label]);
        return [
          label,
          {
            ...pagesByLabel[label],
            scene,
            sceneJson: next.pageScenes[label],
          },
        ];
      }),
    ) as Record<PageLabel, PageRecord>;

    setPagesByLabel(restoredPages);
    setTitle(next.title);
    setHistory(nextHistory);

    setCanUndo(true);
    setCanRedo(newFuture.length > 0);
  }

  function generatePageThumbnail(pageLabel: PageLabel): string | null {
    const resolved = resolvedPages[pageLabel];
    if (resolved.error) return null;
    return renderPageThumbnail(resolved.scene, assets, 120);
  }

  function updateThumbnails() {
    setPageThumbnails((current) => {
      const newThumbnails = { ...current };
      for (const label of PAGE_LABELS) {
        newThumbnails[label] = generatePageThumbnail(label);
      }
      return newThumbnails;
    });
  }

  function updateElement(
    elementId: string,
    updater: (element: EditorElement) => EditorElement,
  ) {
    const source = activePage.scene.elements.find((element) =>
      element.id === elementId
    );
    if (!source) return;
    const changed = updater(source);
    const overrides = { ...activePage.scene.elementStyleOverrides };
    const policyChanged = changed.locked !== source.locked ||
      JSON.stringify(changed.stylePolicy) !==
        JSON.stringify(source.stylePolicy) ||
      changed.designRole !== source.designRole;
    const next = policyChanged && overrides[elementId]
      ? updater(
        activeResolvedScene.elements.find((element) =>
          element.id === elementId
        ) ?? source,
      )
      : changed;
    if (policyChanged) delete overrides[elementId];
    updateScene({
      ...activePage.scene,
      elementStyleOverrides: overrides,
      elements: activePage.scene.elements.map((element) =>
        element.id === elementId ? next : element
      ),
    });
  }

  function updateTemplateTextOverride(elementId: string, text: string) {
    // Persist a per-instance override for a template text element.
    // Only the text content is overridable; the underlying TemplateElement
    // row (position, size, font, color, etc.) is left untouched.
    const source = activeTemplateElements.find((element) =>
      element.id === elementId
    );
    if (!source || source.locked || isProtectedDesign(source)) return;
    const currentOverrides = activePage.scene.templateTextOverrides ?? {};
    const nextOverrides = { ...currentOverrides, [elementId]: text };
    updateScene({
      ...activePage.scene,
      templateTextOverrides: nextOverrides,
    });
  }

  function clearTemplateTextOverride(elementId: string) {
    // Remove the per-instance override so the template's default text
    // takes effect again for this element.
    const currentOverrides = activePage.scene.templateTextOverrides ?? {};
    if (currentOverrides[elementId] === undefined) return;
    const { [elementId]: _removed, ...rest } = currentOverrides;
    void _removed;
    const nextScene = { ...activePage.scene };
    if (Object.keys(rest).length === 0) {
      delete nextScene.templateTextOverrides;
    } else {
      nextScene.templateTextOverrides = rest;
    }
    updateScene(nextScene);
  }

  function isTemplateTextElement(elementId: string): boolean {
    const template = activeTemplateElements.find(
      (element) => element.id === elementId,
    );
    return template?.type === "text" && !template.locked &&
      !isProtectedDesign(template);
  }

  function deleteElement(elementId: string) {
    // Block deletion of template elements
    if (isTemplateElement(elementId, activeTemplateElements)) {
      return;
    }
    updateScene({
      ...activePage.scene,
      elements: activePage.scene.elements.filter((element) =>
        element.id !== elementId
      ),
    });
    setSelectedElementId(null);
  }

  function toggleElementVisibility(elementId: string) {
    updateElement(elementId, (element) => ({
      ...element,
      visible: !element.visible,
    }));
  }

  function toggleElementLock(elementId: string) {
    // Block lock toggle on template elements
    if (isTemplateElement(elementId, activeTemplateElements)) {
      return;
    }
    updateElement(elementId, (element) => ({
      ...element,
      locked: !element.locked,
    }));
  }

  function duplicateElement(elementId: string) {
    // Block duplication of template elements
    if (isTemplateElement(elementId, activeTemplateElements)) {
      return;
    }

    const element = activePage.scene.elements.find(
      (candidate) => candidate.id === elementId,
    );

    if (!element) {
      return;
    }

    const nextZIndex = Math.max(
      ...activePage.scene.elements.map((candidate) => candidate.zIndex),
      0,
    ) +
      1;
    const duplicatedElement = cloneElement(element, nextZIndex);

    updateScene({
      ...activePage.scene,
      elements: [...activePage.scene.elements, duplicatedElement],
      ...(activePage.scene.elementStyleOverrides?.[elementId]
        ? {
          elementStyleOverrides: {
            ...activePage.scene.elementStyleOverrides,
            [duplicatedElement.id]:
              activePage.scene.elementStyleOverrides[elementId],
          },
        }
        : {}),
    });
    setSelectedElementId(duplicatedElement.id);
  }

  function bringForward(elementId: string) {
    // Block reordering of template elements
    if (isTemplateElement(elementId, activeTemplateElements)) {
      return;
    }
    const maxZIndex = Math.max(
      ...activePage.scene.elements.map((element) => element.zIndex),
      0,
    );
    updateElement(elementId, (element) => ({
      ...element,
      zIndex: maxZIndex + 1,
    }));
  }

  function sendBackward(elementId: string) {
    // Block reordering of template elements
    if (isTemplateElement(elementId, activeTemplateElements)) {
      return;
    }
    const minZIndex = Math.min(
      ...activePage.scene.elements.map((element) => element.zIndex),
      0,
    );
    updateElement(elementId, (element) => ({
      ...element,
      zIndex: minZIndex - 1,
    }));
  }

  function addTextElement() {
    const nextElement = createTextElement(activePage.scene);
    updateScene({
      ...activePage.scene,
      elements: [...activePage.scene.elements, nextElement],
    });
    setSelectedElementId(nextElement.id);
  }

  function addImageElement(asset: AssetRecord) {
    const nextElement = createImageElement(activePage.scene, asset);
    updateScene({
      ...activePage.scene,
      elements: [...activePage.scene.elements, nextElement],
    });
    setSelectedElementId(nextElement.id);
  }

  function addShapeElement(shape: "rect" | "circle" | "line") {
    const nextElement = createShapeElement(activePage.scene, shape);
    updateScene({
      ...activePage.scene,
      elements: [...activePage.scene.elements, nextElement],
    });
    setSelectedElementId(nextElement.id);
  }

  async function handleAiApplyText(
    targetPage: PageLabel,
    text: string,
    style?: AiSuggestion["style"],
  ) {
    if (frozenRef.current) return false;
    const origin = persistenceRef.current;
    if (targetPage !== activePageLabel) {
      if (!await handlePageSelect(targetPage)) return false;
    }
    if (!origin || persistenceRef.current !== origin) return false;

    // Build the text element using the target page's scene
    const targetPageRecord = pagesByLabel[targetPage];
    const baseElement = createTextElement(targetPageRecord.scene);
    const nextElement: typeof baseElement = {
      ...baseElement,
      text,
      ...(style?.fontSize && { fontSize: style.fontSize }),
      ...(style?.fontFamily && { fontFamily: style.fontFamily }),
      ...(style?.fontWeight && { fontWeight: style.fontWeight }),
      ...(style?.color && { color: style.color }),
      ...(style?.align && { align: style.align }),
    };

    // If we're on the target page already, apply immediately
    if (targetPage === activePageLabel) {
      pushHistory();
      setPagesByLabel((current) => {
        const page = current[targetPage];
        const normalizedScene = normalizeSceneZIndexes({
          ...page.scene,
          elements: [...page.scene.elements, nextElement],
        });
        return {
          ...current,
          [targetPage]: {
            ...page,
            scene: normalizedScene,
            sceneJson: JSON.stringify(normalizedScene),
          },
        };
      });
      setSelectedElementId(nextElement.id);
    } else {
      // Apply to the target page state (will be visible when user navigates there)
      pushHistory();
      setPagesByLabel((current) => {
        const page = current[targetPage];
        const normalizedScene = normalizeSceneZIndexes({
          ...page.scene,
          elements: [...page.scene.elements, nextElement],
        });
        return {
          ...current,
          [targetPage]: {
            ...page,
            scene: normalizedScene,
            sceneJson: JSON.stringify(normalizedScene),
          },
        };
      });
      // Select the new element and switch to that page
      setActivePageLabel(targetPage);
      setSelectedElementId(nextElement.id);
    }

    toast.success(`Text added to ${PAGE_LABEL_DISPLAY[targetPage]}`);
    return true;
  }

  async function handleAssetUpload(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    setAssetUploading(true);

    try {
      const dimensions = await getImageDimensions(file);
      const presignResponse = await fetch("/api/assets/presign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filename: file.name,
          contentType: file.type,
          usage: "editor",
        }),
      });

      if (!presignResponse.ok) {
        throw new Error("Could not prepare upload");
      }

      const presignData = (await presignResponse.json()) as {
        uploadUrl: string;
        s3Key: string;
      };

      const uploadResponse = await fetch(presignData.uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": file.type },
        body: file,
      });

      if (!uploadResponse.ok) {
        throw new Error("Could not upload asset");
      }

      const assetResponse = await fetch("/api/assets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          s3Key: presignData.s3Key,
          originalFilename: file.name,
          mimeType: file.type,
          fileSize: file.size,
          width: dimensions.width,
          height: dimensions.height,
        }),
      });

      if (!assetResponse.ok) {
        throw new Error("Could not store asset metadata");
      }

      const assetData = (await assetResponse.json()) as { asset: AssetRecord };

      if (!assetData.asset.id) {
        throw new Error("Asset upload succeeded but ID is missing");
      }

      const localPreviewUrl = URL.createObjectURL(file);
      const nextAsset = {
        ...assetData.asset,
        // Use proxy URL for S3 access to avoid CORS issues
        downloadUrl: `/api/assets/${assetData.asset.id}/image`,
        // Keep local blob for immediate display
        previewUrl: localPreviewUrl,
      };

      setAssets((current) => [nextAsset, ...current]);
      addImageElement(nextAsset);
      toast.success("Image added to your asset library");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Asset upload failed",
      );
    } finally {
      setAssetUploading(false);
      event.target.value = "";
    }
  }

  async function handleAssetDelete(assetId: string, filename: string) {
    if (!confirm(`Delete "${filename}" from your asset library?`)) {
      return;
    }

    try {
      const response = await fetch(`/api/assets/${assetId}`, {
        method: "DELETE",
      });

      if (!response.ok) {
        throw new Error("Could not delete asset");
      }

      // Revoke any blob URLs to prevent memory leaks
      const asset = assets.find((a) => a.id === assetId);
      if (asset?.previewUrl?.startsWith("blob:")) {
        URL.revokeObjectURL(asset.previewUrl);
      }

      setAssets((current) => current.filter((a) => a.id !== assetId));
      toast.success("Asset deleted");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Asset deletion failed",
      );
    }
  }

  async function handlePageSelect(pageLabel: PageLabel) {
    if (frozenRef.current) return false;
    if (pageLabel === activePageLabel) return true;
    const persistence = syncDocument();
    frozenRef.current = true;
    setNavigating(true);
    try {
      await persistence.flush(activePageLabel);
      // The title autosaves on its own debounce; flush it too so no part
      // of the document is left dirty across a page switch.
      await persistence.flush("title");
      if (persistenceRef.current !== persistence) return false;
      setActivePageLabel(pageLabel);
      setSelectedElementId(null);
      return true;
    } catch (error) {
      reportSaveError(error, persistence);
      return false;
    } finally {
      if (persistenceRef.current === persistence) {
        frozenRef.current = false;
        setNavigating(false);
      }
    }
  }

  // Every navigation path (filmstrip, arrows, keyboard, swipe, preview,
  // AI apply) goes through handlePageSelect so the outgoing page is always
  // saved before the switch commits, and a failed save blocks the switch.
  function goToPage(pageLabel: PageLabel) {
    const targetIndex = PAGE_READING_ORDER.indexOf(pageLabel);
    setNavDirection(targetIndex >= readingIndex ? "forward" : "backward");
    void handlePageSelect(pageLabel);
  }

  function goToNextPage() {
    if (readingIndex >= PAGE_READING_ORDER.length - 1) return;
    goToPage(PAGE_READING_ORDER[readingIndex + 1]);
  }

  function goToPreviousPage() {
    if (readingIndex <= 0) return;
    goToPage(PAGE_READING_ORDER[readingIndex - 1]);
  }

  function handlePreviewJump(pageLabel: PageLabel) {
    setPreviewOpen(false);
    goToPage(pageLabel);
  }

  const onPageNavKey = useEffectEvent((event: KeyboardEvent) => {
    if (
      frozenRef.current ||
      previewOpen ||
      event.ctrlKey || event.metaKey || event.altKey ||
      (event.target instanceof HTMLElement &&
        event.target.closest(
          'input, textarea, select, [contenteditable="true"], [role="slider"]',
        ))
    ) return;
    if (event.key === "ArrowRight" || event.key === "PageDown") {
      event.preventDefault();
      goToNextPage();
    } else if (event.key === "ArrowLeft" || event.key === "PageUp") {
      event.preventDefault();
      goToPreviousPage();
    }
  });
  // Keyboard page navigation. Form controls keep their own arrow-key
  // behavior (e.g. the typography tracking slider).
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => onPageNavKey(event);
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  // Track viewport size so the stage can grow on tall screens and the xl
  // app frame can hand height fitting to the measured canvas container.
  useEffect(() => {
    const update = () => {
      setViewportHeight(window.innerHeight);
      setViewportWidth(window.innerWidth);
    };
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  async function handleSubmit(force = false) {
    if (!submission || frozenRef.current) {
      return;
    }
    if (
      fontStatus || designIssues.some((issue) => issue.severity === "error")
    ) {
      toast.error(
        fontStatus || "Resolve Book Design print checks before submitting.",
      );
      return;
    }

    const persistence = syncDocument();
    try {
      frozenRef.current = true;
      setSubmitting(true);
      await persistence.flushAll();
      if (persistenceRef.current !== persistence) return;

      const response = await fetch(`/api/submissions/${submission.id}/submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ force }),
      });

      if (persistenceRef.current !== persistence) return;
      if (!response.ok) {
        const data = (await response.json()) as {
          error?: string;
          dpiWarnings?: Array<
            {
              elementId: string;
              pageLabel: string;
              dpi: number;
              severity: string;
            }
          >;
          canForce?: boolean;
        };

        // DPI hard errors: offer the user a chance to force-submit
        if (response.status === 422 && data.canForce && !force) {
          const warningCount = data.dpiWarnings?.filter((w) =>
            w.severity === "error"
          ).length ?? 0;
          const proceed = confirm(
            `${warningCount} image(s) have very low resolution and may print poorly.\n\n` +
              "Submit anyway?",
          );
          if (proceed) {
            frozenRef.current = false;
            setSubmitting(false);
            return await handleSubmit(true);
          }
          setSaveState("idle");
          return;
        }

        throw new Error(data.error || "Could not submit Titchybooks");
      }

      const result = (await response.json()) as {
        dpiWarnings?: Array<{ severity: string }>;
      };

      if (persistenceRef.current !== persistence) return;
      draftPointerStorage.removeItem(ACTIVE_DRAFT_STORAGE_KEY);

      const softWarnings = result.dpiWarnings?.filter((w) =>
        w.severity === "warning"
      ).length ?? 0;
      if (softWarnings > 0) {
        toast.warning(
          `Titchybooks submitted. ${softWarnings} image(s) have low resolution and may not print sharply.`,
        );
      } else {
        toast.success(
          "Titchybooks submitted. PDF generation is now processing.",
        );
      }

      persistenceRef.current?.clearRecovery();
      router.push("/dashboard");
      router.refresh();
    } catch (error) {
      if (persistenceRef.current === persistence) {
        setSaveState("error");
        reportSaveError(error, persistence);
      }
    } finally {
      if (persistenceRef.current === persistence) {
        frozenRef.current = false;
        setSubmitting(false);
      }
    }
  }

  async function handleDetachFromTemplate() {
    if (!submission || frozenRef.current) return;

    if (
      !confirm(
        "This will unlock all template elements and make them fully editable. This action cannot be undone. Continue?",
      )
    ) {
      return;
    }

    const persistence = syncDocument();
    try {
      frozenRef.current = true;
      setSubmitting(true);
      await persistence.flushAll();
      if (persistenceRef.current !== persistence) return;
      const response = await fetch(
        `/api/submissions/${submission.id}/detach-from-template`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            revision: persistence.revision("title"),
            pageRevisions: Object.fromEntries(
              PAGE_LABELS.map((label) => [label, persistence.revision(label)]),
            ),
          }),
        },
      );

      if (persistenceRef.current !== persistence) return;
      if (!response.ok) {
        throw new Error("Could not detach from template");
      }

      toast.success("Template elements unlocked! Reloading...");
      // Reload the submission to get updated state
      draftPointerStorage.removeItem(ACTIVE_DRAFT_STORAGE_KEY);
      persistence.clearRecovery();
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- Detach must reboot same-draft client state and revision tracking; router navigation preserves it.
      window.location.assign(`/create?submissionId=${submission.id}`);
    } catch (error) {
      reportSaveError(error, persistence);
    } finally {
      if (persistenceRef.current === persistence) {
        frozenRef.current = false;
        setSubmitting(false);
      }
    }
  }

  if (loading) {
    return (
      <div className="flex min-h-[calc(100vh-3.5rem)] items-center justify-center px-4 py-8">
        <div className="card px-8 py-10 text-center">
          <p className="section-label">
            Titchybooks Studio
          </p>
          <p className="mt-3 text-base" style={{ color: "var(--color-text)" }}>
            {loadingMessage}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      className="min-h-[calc(100vh-3.5rem)] px-4 py-6"
      inert={submitting || navigating}
      aria-busy={submitting || navigating}
      style={{
        background:
          "linear-gradient(180deg, var(--color-primary-muted) 0%, var(--color-background) 40%)",
      }}
    >
      <div className="mx-auto flex max-w-[1600px] flex-col gap-4">
        {saveError && (
          <div
            role="alert"
            className="card p-4 xl:shrink-0"
            style={{ color: "var(--color-error)" }}
          >
            <p>{saveError}</p>
            <button
              className="btn btn-outline btn-sm mt-2"
              onClick={() => {
                const persistence = syncDocument();
                void persistence.flushAll().catch((error) =>
                  reportSaveError(error, persistence)
                );
              }}
            >
              Retry saving
            </button>
          </div>
        )}
        {/* Template instance banner */}
        {isInstanceMode && (
          <div
            className="flex items-center justify-between rounded-xl px-5 py-3 xl:shrink-0"
            style={{
              background: "var(--color-secondary-light)",
              border: "1px solid var(--color-secondary)",
            }}
          >
            <div className="flex items-center gap-3">
              <svg
                className="h-5 w-5"
                style={{ color: "var(--color-secondary)" }}
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"
                />
              </svg>
              <div>
                <p
                  className="text-sm font-medium"
                  style={{ color: "var(--color-secondary)" }}
                >
                  Template Instance
                </p>
                <p
                  className="text-xs"
                  style={{ color: "var(--color-text-muted)" }}
                >
                  Template layout is protected. Edit eligible text and apply
                  permitted styling without detaching.
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={handleDetachFromTemplate}
              className="btn btn-outline btn-sm"
              style={{
                color: "var(--color-secondary)",
                borderColor: "var(--color-secondary)",
              }}
            >
              Unlock All Elements
            </button>
          </div>
        )}
        {/* App frame at xl: 113px = sticky Header (65px) + the root's vertical
            padding (48px). Only the top bar and workspace grid live inside it;
            the order panel below keeps normal flow. The rail scrolls inside
            itself so editing properties never moves the canvas. */}
        <div className="flex flex-col gap-4 xl:h-[calc(100dvh-113px)] xl:min-h-0">
        <section
          className="card p-5 backdrop-blur xl:shrink-0 xl:py-3"
          style={{ background: "rgba(255,255,255,0.92)" }}
        >
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div className="space-y-2">
              <p className="section-label">
                Titchybooks Studio
              </p>
              <input
                value={title === "Untitled Titchybooks" ? "" : title}
                onFocus={() => {
                  if (!frozenRef.current) pushHistory();
                }}
                onChange={(event) => {
                  if (!frozenRef.current) setTitle(event.target.value);
                }}
                maxLength={120}
                aria-label="Book title"
                placeholder="Enter your book title"
                className="w-full max-w-xl border-none bg-transparent p-0 text-3xl font-semibold tracking-tight outline-none"
                style={{ color: "var(--color-text)" }}
              />
              <p
                className="text-sm xl:hidden"
                style={{ color: "var(--color-text-muted)" }}
              >
                Compose each booklet page individually. Safe area guides are
                shown on the canvas.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <span
                className="badge"
                role="status"
                aria-live="polite"
                style={{
                  background: saveState === "saving"
                    ? "var(--color-accent-light)"
                    : saveState === "saved"
                    ? "var(--color-success-light)"
                    : saveState === "error"
                    ? "var(--color-error-light)"
                    : "var(--color-border)",
                  color: saveState === "saving"
                    ? "#92400E"
                    : saveState === "saved"
                    ? "#065F46"
                    : saveState === "error"
                    ? "#991B1B"
                    : "var(--color-text-muted)",
                }}
              >
                {saveState === "saving"
                  ? "Saving..."
                  : saveState === "saved"
                  ? "Saved"
                  : saveState === "error"
                  ? "Save failed"
                  : "Ready"}
              </span>
              <button
                type="button"
                onClick={undo}
                disabled={!canUndo}
                className="btn btn-outline btn-sm"
                title="Undo (Ctrl+Z)"
              >
                Undo
              </button>
              <button
                type="button"
                onClick={redo}
                disabled={!canRedo}
                className="btn btn-outline btn-sm"
                title="Redo (Ctrl+Shift+Z)"
              >
                Redo
              </button>
              <div className="relative group">
                <button
                  type="button"
                  className="btn btn-outline btn-sm"
                >
                  Add Shape ▾
                </button>
                <div className="invisible absolute left-0 top-full pt-2 opacity-0 transition-all duration-150 group-hover:visible group-hover:opacity-100 z-50">
                  <div
                    className="flex flex-col gap-1 card p-2 shadow-lg"
                    style={{ minWidth: "140px" }}
                  >
                    <button
                      type="button"
                      onClick={() => addShapeElement("rect")}
                      className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm transition"
                      style={{ color: "var(--color-text)" }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.background =
                          "var(--color-surface)";
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.background = "transparent";
                      }}
                    >
                      <div
                        className="h-4 w-4 rounded-sm border-2"
                        style={{ borderColor: "var(--color-text-muted)" }}
                      />
                      Rectangle
                    </button>
                    <button
                      type="button"
                      onClick={() => addShapeElement("circle")}
                      className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm transition"
                      style={{ color: "var(--color-text)" }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.background =
                          "var(--color-surface)";
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.background = "transparent";
                      }}
                    >
                      <div
                        className="h-4 w-4 rounded-full border-2"
                        style={{ borderColor: "var(--color-text-muted)" }}
                      />
                      Circle
                    </button>
                    <button
                      type="button"
                      onClick={() => addShapeElement("line")}
                      className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm transition"
                      style={{ color: "var(--color-text)" }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.background =
                          "var(--color-surface)";
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.background = "transparent";
                      }}
                    >
                      <div
                        className="h-0.5 w-4"
                        style={{ background: "var(--color-text-muted)" }}
                      />
                      Line
                    </button>
                  </div>
                </div>
              </div>
              <button
                type="button"
                onClick={addTextElement}
                className="btn btn-primary btn-sm"
              >
                Add Text Box
              </button>
              <button
                type="button"
                onClick={() => setPreviewOpen(true)}
                className="btn btn-outline btn-sm"
              >
                Preview booklet
              </button>
              <button
                type="button"
                onClick={() => void handleSubmit()}
                disabled={submitting || Boolean(fontStatus) ||
                  designIssues.some((issue) => issue.severity === "error")}
                className="btn btn-secondary btn-sm"
              >
                {submitting ? "Submitting..." : "Submit For PDF"}
              </button>
            </div>
          </div>
        </section>

        <div className="grid items-start gap-4 xl:min-h-0 xl:flex-1 xl:grid-cols-[minmax(0,1fr)_340px] xl:items-stretch">
          <section className="min-w-0 space-y-4 xl:flex xl:min-h-0 xl:flex-col xl:overflow-y-auto">
            <div className="card p-4 xl:shrink-0">
              <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                <div>
                  <p
                    className="text-sm font-semibold"
                    style={{ color: "var(--color-text)" }}
                  >
                    {PAGE_LABEL_DISPLAY[activePageLabel]}
                  </p>
                  <p
                    className="text-sm"
                    style={{ color: "var(--color-text-muted)" }}
                  >
                    {isInstanceMode
                      ? "Select editable template text in Layers to change its words or style."
                      : "Drag elements freely, then resize or rotate from the page."}
                  </p>
                </div>
                <div className="flex items-center gap-4">
                  <span
                    className="text-xs font-medium tabular-nums"
                    aria-live="polite"
                    style={{ color: "var(--color-text-muted)" }}
                  >
                    Page {readingIndex + 1} of 8
                  </span>
                  <label
                    className="flex items-center gap-2 text-sm"
                    style={{ color: "var(--color-text-muted)" }}
                  >
                    <span>Background</span>
                    <ColorPicker
                      value={activeResolvedScene.page.backgroundColor}
                      onChange={(color) => {
                        updateScene({
                          ...activePage.scene,
                          backgroundOverride: color,
                        });
                      }}
                    />
                  </label>
                </div>
              </div>
            </div>

            <div className="flex items-stretch gap-2 xl:min-h-[420px] xl:flex-1">
              <button
                type="button"
                onClick={goToPreviousPage}
                disabled={readingIndex <= 0 || navigating}
                aria-label="Previous page"
                title="Previous page (ArrowLeft)"
                className="hidden shrink-0 self-center rounded-full p-2 transition disabled:opacity-40 sm:block sm:p-3"
                style={{
                  border: "1.5px solid var(--color-border-strong)",
                  background: "var(--color-surface-raised)",
                  color: "var(--color-text)",
                }}
              >
                <svg
                  className="h-5 w-5"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M15 19l-7-7 7-7"
                  />
                </svg>
              </button>
              <div className="min-w-0 flex-1">
                <div
                  key={activePageLabel}
                  className={`xl:h-full ${navDirection === "forward"
                    ? "page-enter-forward"
                    : "page-enter-backward"}`}
                >
                  <EditorCanvas
                    key={`canvas-${fontRetry}`}
                    scene={{ ...activeResolvedScene, elements: mergedElements }}
                    assets={assets}
                    selectedElementId={selectedElementId}
                    onSelectElement={(elementId) => {
                      // Allow selecting template TEXT elements so users can edit
                      // the text content. Other template types remain fully locked.
                      if (
                        isInstanceMode && elementId &&
                        isTemplateElement(elementId, activeTemplateElements) &&
                        !isTemplateTextElement(elementId)
                      ) {
                        return;
                      }
                      setSelectedElementId(elementId);
                    }}
                    onSceneChange={(next) => {
                      // Strip any template-layer elements before persisting;
                      // instance sceneJson must remain user-layer only (aside
                      // from `templateTextOverrides`, which the canvas never
                      // modifies directly).
                      updateScene(applyCanvasGeometry(activePage.scene, next));
                    }}
                    onTextCommit={(elementId, text) => {
                      // Inline canvas edits route exactly like the properties
                      // panel: template text becomes a per-instance override,
                      // other template elements stay fixed, user elements
                      // update in place (one history step per edit session).
                      if (isTemplateTextElement(elementId)) {
                        updateTemplateTextOverride(elementId, text);
                        return;
                      }
                      if (
                        isTemplateElement(elementId, activeTemplateElements)
                      ) {
                        return;
                      }
                      updateElement(elementId, (element) =>
                        element.type === "text"
                          ? { ...element, text }
                          : element);
                    }}
                    pageLabel={activePageLabel}
                    templateElementIds={new Set(
                      activeTemplateElements.map((e) => e.id),
                    )}
                    templateTextElementIds={new Set(
                      activeTemplateElements
                        .filter((e) =>
                          e.type === "text" && !e.locked && !isProtectedDesign(e)
                        )
                        .map((e) => e.id),
                    )}
                    isInstanceMode={isInstanceMode}
                    maxWidth={700}
                    maxHeight={isXl ? undefined : stageMaxHeight}
                    onSwipeLeft={goToNextPage}
                    onSwipeRight={goToPreviousPage}
                  />
                </div>
              </div>
              <button
                type="button"
                onClick={goToNextPage}
                disabled={readingIndex >= PAGE_READING_ORDER.length - 1 ||
                  navigating}
                aria-label="Next page"
                title="Next page (ArrowRight)"
                className="hidden shrink-0 self-center rounded-full p-2 transition disabled:opacity-40 sm:block sm:p-3"
                style={{
                  border: "1.5px solid var(--color-border-strong)",
                  background: "var(--color-surface-raised)",
                  color: "var(--color-text)",
                }}
              >
                <svg
                  className="h-5 w-5"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M9 5l7 7-7 7"
                  />
                </svg>
              </button>
            </div>

            <div className="xl:shrink-0">
              <PageFilmstrip
                activePageLabel={activePageLabel}
                thumbnails={pageThumbnails}
                elementCounts={elementCounts}
                onSelect={goToPage}
              />
            </div>
            <p
              className="text-xs xl:hidden xl:shrink-0"
              style={{ color: "var(--color-text-muted)" }}
            >
              Swipe the page, press the arrow keys, or pick a thumbnail to
              move between pages. Changes are saved before each switch.
            </p>
          </section>

          <div
            data-testid="editor-tools-rail"
            className="space-y-4 xl:min-h-0 xl:overflow-y-auto xl:overscroll-contain xl:pr-1 xl:pb-2"
          >
            <BookDesignPanel
              scene={activePage.scene}
              pageLabel={activePageLabel}
              selectedElement={selectedElement}
              onApply={applyBookDesign}
              onGestureStart={() => {
                if (!designGesture.current.active) {designGesture.current = {
                    active: true,
                    recorded: false,
                  };}
              }}
              onGestureEnd={() => {
                designGesture.current = { active: false, recorded: false };
              }}
              issues={designIssues}
              fontStatus={fontStatus}
              onRetryFonts={() => setFontRetry((value) => value + 1)}
            />
            <PropertiesPanel
              isTemplateAuthor={submission?.isTemplate}
              guidedTypography
              selectedElement={selectedElement}
              onChangeElement={(elementId, updater) => {
                // For template TEXT elements: apply the updater, extract
                // only the `text` change, and write to templateTextOverrides.
                // All other property changes (position, size, etc.) are
                // silently dropped so the template layout stays fixed.
                if (isTemplateTextElement(elementId)) {
                  const template = activeTemplateElementsWithOverrides.find(
                    (element) => element.id === elementId,
                  );
                  if (template && template.type === "text") {
                    const next = updater(template);
                    if (next.type === "text") {
                      updateTemplateTextOverride(elementId, next.text);
                    }
                  }
                  return;
                }
                // Block property changes on all other template elements
                if (isTemplateElement(elementId, activeTemplateElements)) {
                  return;
                }
                updateElement(elementId, updater);
              }}
              onDeleteElement={deleteElement}
              onDuplicateElement={duplicateElement}
              onToggleVisibility={(elementId) => {
                if (isTemplateElement(elementId, activeTemplateElements)) {
                  return;
                }
                toggleElementVisibility(elementId);
              }}
              onToggleLock={toggleElementLock}
              onBringForward={bringForward}
              onSendBackward={sendBackward}
              isInstanceMode={isInstanceMode}
              templateTextOriginal={selectedElement &&
                  selectedElement.layer === "template" &&
                  selectedElement.type === "text"
                ? (() => {
                  const original = activeTemplateElements.find(
                    (el) => el.id === selectedElement.id,
                  );
                  return original && original.type === "text"
                    ? original.text
                    : undefined;
                })()
                : undefined}
              onResetTemplateText={clearTemplateTextOverride}
              assetDimensions={assetDimensionsMap}
              physicalWidthMm={physicalWidthMm}
              physicalHeightMm={physicalHeightMm}
            />
            <LayerPanel
              elements={activeResolvedScene.elements.slice(
                activeTemplateElements.length,
              )}
              templateElements={activeTemplateElementsWithOverrides}
              selectedElementId={selectedElementId}
              onSelectElement={(elementId) => {
                // Allow selecting template TEXT elements so users can edit
                // the text via the properties panel.
                if (
                  isInstanceMode &&
                  isTemplateElement(elementId, activeTemplateElements) &&
                  !isTemplateTextElement(elementId)
                ) {
                  return;
                }
                setSelectedElementId(elementId);
              }}
              onToggleVisibility={(elementId) => {
                if (isTemplateElement(elementId, activeTemplateElements)) {
                  return;
                }
                toggleElementVisibility(elementId);
              }}
              onToggleLock={toggleElementLock}
              onDuplicateElement={duplicateElement}
              onDeleteElement={deleteElement}
              isInstanceMode={isInstanceMode}
            />

            <section className="card p-5">
              <div className="flex items-center justify-between">
                <p
                  className="text-sm font-semibold"
                  style={{ color: "var(--color-text)" }}
                >
                  Asset Library
                </p>
                <label className="btn btn-secondary btn-sm cursor-pointer">
                  {assetUploading ? "Uploading..." : "Upload"}
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    onChange={handleAssetUpload}
                    disabled={assetUploading}
                    className="hidden"
                  />
                </label>
              </div>
              <p
                className="mt-3 text-xs leading-5"
                style={{ color: "var(--color-text-muted)" }}
              >
                Click any thumbnail to place another copy on the current page.
              </p>
              <div className="mt-4 grid grid-cols-2 gap-3">
                {assets.length === 0
                  ? (
                    <p
                      className="col-span-2 text-sm leading-6"
                      style={{ color: "var(--color-text-muted)" }}
                    >
                      Upload images to start placing artwork on the page.
                    </p>
                  )
                  : (
                    assets.map((asset) => (
                      <div
                        key={asset.id}
                        className="group relative overflow-hidden rounded-xl transition"
                        style={{
                          border: "1px solid var(--color-border)",
                          background: "var(--color-surface)",
                        }}
                      >
                        <button
                          type="button"
                          onClick={() => addImageElement(asset)}
                          className="block h-full w-full text-left"
                        >
                          {asset.previewUrl ?? asset.downloadUrl
                            ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img
                                src={asset.previewUrl ?? asset.downloadUrl ??
                                  ""}
                                alt={asset.originalFilename}
                                className="h-28 w-full object-cover"
                              />
                            )
                            : (
                              <div
                                className="flex h-28 items-center justify-center text-xs"
                                style={{
                                  background: "var(--color-border)",
                                  color: "var(--color-text-muted)",
                                }}
                              >
                                No preview
                              </div>
                            )}
                          <div className="px-3 py-2">
                            <p
                              className="truncate text-xs font-medium"
                              style={{ color: "var(--color-text)" }}
                            >
                              {asset.originalFilename}
                            </p>
                          </div>
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            handleAssetDelete(
                              asset.id,
                              asset.originalFilename,
                            )}
                          className="absolute right-2 top-2 rounded-full p-1.5 text-white opacity-0 shadow-sm transition group-hover:opacity-100"
                          style={{ background: "var(--color-error)" }}
                          title="Delete asset"
                        >
                          <svg
                            className="h-3.5 w-3.5"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                            strokeWidth={2}
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                            />
                          </svg>
                        </button>
                      </div>
                    ))
                  )}
              </div>
            </section>
          </div>
        </div>
        </div>

        {submission && (
          <OrderPanel
            submission={{
              id: submission.id,
              status: submission.status,
              pdfReady: submission.status === "APPROVED",
            }}
            submissionTitle={title}
          />
        )}
      </div>

      <BookletPreview
        open={previewOpen}
        title={title}
        pages={resolvedPages}
        assets={assets}
        onClose={() => setPreviewOpen(false)}
        onJumpToPage={handlePreviewJump}
      />

      <AiChatPanel
        key={submission?.id ?? "loading"}
        isOpen={aiPanelOpen}
        onToggle={() => setAiPanelOpen((prev) => !prev)}
        bookContext={aiBookContext}
        onApplyText={handleAiApplyText}
      />
    </div>
  );
}
