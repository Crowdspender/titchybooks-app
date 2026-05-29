"use client";

import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  PAGE_LABEL_DISPLAY,
  PAGE_LABELS,
  type PageLabel,
} from "@/lib/constants";
import type { EditorElement, EditorScene } from "@/lib/editor/schema";
import { EDITOR_SAFE_MARGIN_PX } from "@/lib/editor/constants";
import { createEmptySubmissionPageSeeds } from "@/lib/editor/validation";
import { isTemplateElement, mergeLayers } from "@/lib/editor/template-merge";
import type {
  RenderableEditorElement,
  TemplateElementsByPage,
} from "@/lib/editor/template-types";
import LayerPanel from "./LayerPanel";
import PropertiesPanel from "./PropertiesPanel";
import OrderPanel from "@/components/orders/OrderPanel";
import AiChatPanel from "./AiChatPanel";
import type { BookContext } from "@/lib/ai/system-prompt";
import type { AiSuggestion } from "@/lib/ai/protocol";

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
  pageLabel: PageLabel;
  order: number;
  scene: EditorScene;
  sceneJson: string;
}

interface SubmissionRecord {
  id: string;
  title: string | null;
  status: string;
  mode: string;
  isTemplate: boolean;
  templateId: string | null;
  templateVersion: number | null;
  pages: PageRecord[];
}

function normalizePages(
  pages: Array<{
    id?: string;
    pageLabel: PageLabel;
    order: number;
    scene?: EditorScene;
    sceneJson?: string;
  }>,
): Record<PageLabel, PageRecord> {
  const fallbackPages = createEmptySubmissionPageSeeds();
  const baseRecord = Object.fromEntries(
    fallbackPages.map((page) => [
      page.pageLabel,
      {
        pageLabel: page.pageLabel,
        order: page.order,
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
  const [title, setTitle] = useState("Untitled Titchybook");
  const [assets, setAssets] = useState<AssetRecord[]>([]);
  const [assetUploading, setAssetUploading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
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

  const savedPagesRef = useRef<Partial<Record<PageLabel, string>>>({});
  const savedTitleRef = useRef("Untitled Titchybook");
  const submissionIdRef = useRef<string | null>(null);

  const activePage = pagesByLabel[activePageLabel];

  // Derive merged render scene for the active page
  const activeTemplateElements = useMemo(
    () => templateElements[activePageLabel] ?? [],
    [templateElements, activePageLabel],
  );
  const activeUserElements = activePage.scene.elements;
  const activeTextOverrides = useMemo(
    () => activePage.scene.templateTextOverrides ?? {},
    [activePage.scene.templateTextOverrides],
  );

  // Template elements with user-level text overrides applied. Only the
  // `text` field of text-type template elements is overridable; all other
  // visual properties (position, size, font, color, etc.) remain locked.
  const activeTemplateElementsWithOverrides = useMemo(
    () =>
      activeTemplateElements.map((element) =>
        element.type === "text" && activeTextOverrides[element.id] !== undefined
          ? { ...element, text: activeTextOverrides[element.id] }
          : element
      ),
    [activeTemplateElements, activeTextOverrides],
  );

  const mergedElements: RenderableEditorElement[] = useMemo(
    () => mergeLayers(activeTemplateElementsWithOverrides, activeUserElements),
    [activeTemplateElementsWithOverrides, activeUserElements],
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
              title: "Untitled Titchybook",
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
      if (nextSubmission.status !== "DRAFT") {
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
            } else {
              // Instance: template elements are the locked background layer.
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

      setSubmission(nextSubmission);
      setTitle(nextSubmission.title ?? "Untitled Titchybook");
      setPagesByLabel(nextPages);
      setTemplateElements(nextTemplateElements);
      setActivePageLabel("FRONT_COVER");
      setSelectedElementId(null);
      submissionIdRef.current = nextSubmission.id;
      savedTitleRef.current = nextSubmission.title ?? "Untitled Titchybook";
      savedPagesRef.current = Object.fromEntries(
        PAGE_LABELS.map((
          pageLabel,
        ) => [pageLabel, nextPages[pageLabel].sceneJson]),
      ) as Partial<Record<PageLabel, string>>;
      localStorage.setItem(ACTIVE_DRAFT_STORAGE_KEY, nextSubmission.id);

      // Initialize history
      const initialSnapshot: HistoryEntry = {
        pageScenes: Object.fromEntries(
          PAGE_LABELS.map((label) => [label, nextPages[label].sceneJson]),
        ) as Record<PageLabel, string>,
        title: nextSubmission.title ?? "Untitled Titchybook",
      };
      setHistory({
        past: [],
        present: initialSnapshot,
        future: [],
      });
      setCanUndo(false);
      setCanRedo(false);

      // Generate initial thumbnails after a short delay
      setTimeout(() => {
        updateThumbnails();
      }, 300);
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
        setTitle("Untitled Titchybook");
        setTemplateElements(
          Object.fromEntries(
            PAGE_LABELS.map((label) => [label, [] as EditorElement[]]),
          ) as unknown as TemplateElementsByPage,
        );
        setHistory({ past: [], present: null, future: [] });
        setCanUndo(false);
        setCanRedo(false);
        setSaveState("idle");
        submissionIdRef.current = null;
        savedTitleRef.current = "Untitled Titchybook";
        savedPagesRef.current = {};

        await loadAssets();

        // If forceNew is true, always create a new draft and ignore localStorage
        if (forceNew) {
          localStorage.removeItem(ACTIVE_DRAFT_STORAGE_KEY);
          const nextId = await createDraft();
          await loadSubmission(nextId);
        } // If submissionId is provided via URL, use it and clear localStorage
        else if (submissionId) {
          localStorage.removeItem(ACTIVE_DRAFT_STORAGE_KEY);
          await loadSubmission(submissionId);
        } else {
          const storedSubmissionId = localStorage.getItem(
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
              localStorage.removeItem(ACTIVE_DRAFT_STORAGE_KEY);
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
      // Clear pending draft creation on unmount to allow fresh starts
      // This prevents edge cases where a user navigates away during draft creation
      // and immediately returns, which would otherwise reuse the old promise
      pendingDraftCreation = null;
    };
  }, [forceNew, submissionId]);

  useEffect(() => {
    if (!submission) {
      return;
    }

    if (title === savedTitleRef.current) {
      return;
    }

    const timeout = window.setTimeout(async () => {
      try {
        setSaveState("saving");
        const response = await fetch(`/api/submissions/${submission.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title }),
        });

        if (!response.ok) {
          throw new Error("Could not save title");
        }

        savedTitleRef.current = title;
        setSaveState("saved");
      } catch (error) {
        setSaveState("error");
        toast.error(
          error instanceof Error ? error.message : "Title save failed",
        );
      }
    }, 700);

    return () => window.clearTimeout(timeout);
  }, [submission, title]);

  // Keyboard shortcuts for undo/redo
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key === "z") {
        if (event.shiftKey) {
          event.preventDefault();
          redo();
        } else {
          event.preventDefault();
          undo();
        }
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [history]);

  // Update thumbnails when page changes
  useEffect(() => {
    const timeout = setTimeout(() => {
      updateThumbnails();
    }, 500);
    return () => clearTimeout(timeout);
  }, [activePageLabel, pagesByLabel]);

  useEffect(() => {
    if (!submission) {
      return;
    }

    const currentPage = pagesByLabel[activePageLabel];
    const savedSceneJson = savedPagesRef.current[activePageLabel];
    if (!currentPage || currentPage.sceneJson === savedSceneJson) {
      return;
    }

    const timeout = window.setTimeout(async () => {
      try {
        setSaveState("saving");
        const response = await fetch(
          `/api/submissions/${submission.id}/pages/${activePageLabel}`,
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ scene: currentPage.scene }),
          },
        );

        if (!response.ok) {
          throw new Error("Could not save page");
        }

        savedPagesRef.current[activePageLabel] = currentPage.sceneJson;
        setSaveState("saved");
      } catch (error) {
        setSaveState("error");
        toast.error(
          error instanceof Error ? error.message : "Page save failed",
        );
      }
    }, 800);

    return () => window.clearTimeout(timeout);
  }, [activePageLabel, pagesByLabel, submission]);

  async function persistTitleImmediately() {
    const submissionId = submissionIdRef.current;
    if (!submissionId || title === savedTitleRef.current) {
      return;
    }

    const response = await fetch(`/api/submissions/${submissionId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    });

    if (!response.ok) {
      throw new Error("Could not save title");
    }

    savedTitleRef.current = title;
  }

  async function persistPageImmediately(pageLabel: PageLabel) {
    const submissionId = submissionIdRef.current;
    const page = pagesByLabel[pageLabel];

    if (!submissionId || !page) {
      return;
    }

    if (page.sceneJson === savedPagesRef.current[pageLabel]) {
      return;
    }

    try {
      setSaveState("saving");
      const response = await fetch(
        `/api/submissions/${submissionId}/pages/${pageLabel}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ scene: page.scene }),
        },
      );

      if (!response.ok) {
        throw new Error("Could not save page");
      }

      savedPagesRef.current[pageLabel] = page.sceneJson;
      setSaveState("saved");
    } catch (error) {
      setSaveState("error");
      toast.error(error instanceof Error ? error.message : "Page save failed");
    }
  }

  function updateScene(scene: EditorScene) {
    const normalizedScene = normalizeSceneZIndexes(scene);
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
    if (history.past.length === 0 || !history.present) return;

    const previous = history.past[history.past.length - 1];
    const newPast = history.past.slice(0, -1);

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
    setHistory({
      past: newPast,
      present: previous,
      future: [history.present, ...history.future],
    });

    setCanUndo(newPast.length > 0);
    setCanRedo(true);
  }

  function redo() {
    if (history.future.length === 0 || !history.present) return;

    const next = history.future[0];
    const newFuture = history.future.slice(1);

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
    setHistory({
      past: [...history.past, history.present],
      present: next,
      future: newFuture,
    });

    setCanUndo(true);
    setCanRedo(newFuture.length > 0);
  }

  function generatePageThumbnail(pageLabel: PageLabel): string | null {
    const canvas = document.createElement("canvas");
    const page = pagesByLabel[pageLabel];
    if (!page) return null;

    const thumbnailWidth = 120;
    const thumbnailHeight = (thumbnailWidth / page.scene.page.widthPx) *
      page.scene.page.heightPx;
    canvas.width = thumbnailWidth;
    canvas.height = thumbnailHeight;

    const ctx = canvas.getContext("2d");
    if (!ctx) return null;

    // Fill background
    ctx.fillStyle = page.scene.page.backgroundColor;
    ctx.fillRect(0, 0, thumbnailWidth, thumbnailHeight);

    // Draw safe margin
    const safeMargin = (EDITOR_SAFE_MARGIN_PX / page.scene.page.widthPx) *
      thumbnailWidth;
    ctx.strokeStyle = "#f97316";
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(
      safeMargin,
      safeMargin,
      thumbnailWidth - safeMargin * 2,
      thumbnailHeight - safeMargin * 2,
    );
    ctx.setLineDash([]);

    // Draw elements (simplified for thumbnail)
    const scale = thumbnailWidth / page.scene.page.widthPx;
    const sortedElements = [...page.scene.elements].sort((a, b) =>
      a.zIndex - b.zIndex
    );

    for (const element of sortedElements) {
      if (!element.visible) continue;

      ctx.save();
      ctx.globalAlpha = element.opacity;
      const centerX = (element.x + element.width / 2) * scale;
      const centerY = (element.y + element.height / 2) * scale;
      ctx.translate(centerX, centerY);
      ctx.rotate((element.rotation * Math.PI) / 180);

      if (element.type === "shape") {
        ctx.fillStyle = element.fill;
        if (element.shape === "rect") {
          ctx.fillRect(
            -element.width * scale / 2,
            -element.height * scale / 2,
            element.width * scale,
            element.height * scale,
          );
        } else if (element.shape === "circle") {
          ctx.beginPath();
          ctx.arc(
            0,
            0,
            Math.min(element.width, element.height) * scale / 2,
            0,
            Math.PI * 2,
          );
          ctx.fill();
        } else if (element.shape === "line") {
          ctx.strokeStyle = element.stroke || element.fill;
          ctx.lineWidth = (element.strokeWidth || 2) * scale;
          ctx.beginPath();
          ctx.moveTo(-element.width * scale / 2, -element.height * scale / 2);
          ctx.lineTo(element.width * scale / 2, element.height * scale / 2);
          ctx.stroke();
        }
      } else if (element.type === "text") {
        ctx.fillStyle = element.color;
        ctx.font = `${element.fontWeight >= 600 ? "bold" : "normal"} ${
          element.fontSize * scale
        }px ${element.fontFamily}`;
        ctx.textAlign = element.align === "center"
          ? "center"
          : element.align === "right"
          ? "right"
          : "left";
        ctx.textBaseline = "top";

        const boxWidth = element.width * scale;
        const boxHeight = element.height * scale;
        const lineHeight = element.fontSize * element.lineHeight * scale;
        const textX = element.align === "center"
          ? 0
          : element.align === "right"
          ? boxWidth / 2
          : -boxWidth / 2;

        // Word-wrap to match the canvas/PDF behavior using actual font metrics
        const wrappedLines: string[] = [];
        for (const paragraph of element.text.split(/\r?\n/)) {
          const trimmed = paragraph.trimEnd();
          if (trimmed === "") {
            wrappedLines.push("");
            continue;
          }
          const words = trimmed.split(" ");
          let currentLine = "";
          for (const word of words) {
            const candidate = currentLine === ""
              ? word
              : `${currentLine} ${word}`;
            if (
              ctx.measureText(candidate).width > boxWidth && currentLine !== ""
            ) {
              wrappedLines.push(currentLine);
              currentLine = word;
            } else {
              currentLine = candidate;
            }
          }
          if (currentLine !== "") {
            wrappedLines.push(currentLine);
          }
        }

        // Clip to box bounds so overflowing text doesn't bleed past the frame
        ctx.save();
        ctx.beginPath();
        ctx.rect(-boxWidth / 2, -boxHeight / 2, boxWidth, boxHeight);
        ctx.clip();

        wrappedLines.forEach((line, i) => {
          ctx.fillText(line, textX, -boxHeight / 2 + i * lineHeight);
        });

        ctx.restore();
      } else if (element.type === "image") {
        const asset = assets.find((a) => a.id === element.assetId);
        if (asset?.previewUrl || asset?.downloadUrl) {
          const img = new window.Image();
          img.crossOrigin = "anonymous";
          img.src = asset.previewUrl || asset.downloadUrl || "";
          // Draw synchronously if cached, otherwise skip for thumbnail
          if (img.complete && img.naturalWidth > 0) {
            ctx.drawImage(
              img,
              -element.width * scale / 2,
              -element.height * scale / 2,
              element.width * scale,
              element.height * scale,
            );
          }
        } else {
          // Placeholder for missing image
          ctx.fillStyle = "#e5e7eb";
          ctx.fillRect(
            -element.width * scale / 2,
            -element.height * scale / 2,
            element.width * scale,
            element.height * scale,
          );
          ctx.fillStyle = "#9ca3af";
          ctx.font = `${10 * scale}px sans-serif`;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText("Image", 0, 0);
        }
      }

      ctx.restore();
    }

    return canvas.toDataURL("image/png", 0.7);
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
    updateScene({
      ...activePage.scene,
      elements: activePage.scene.elements.map((element) =>
        element.id === elementId ? updater(element) : element
      ),
    });
  }

  function updateTemplateTextOverride(elementId: string, text: string) {
    // Persist a per-instance override for a template text element.
    // Only the text content is overridable; the underlying TemplateElement
    // row (position, size, font, color, etc.) is left untouched.
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
    return template?.type === "text";
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

  function handleAiApplyText(
    targetPage: PageLabel,
    text: string,
    style?: AiSuggestion["style"],
  ) {
    // Switch to the target page if needed
    if (targetPage !== activePageLabel) {
      // Persist current page before switching
      void persistPageImmediately(activePageLabel);
      setActivePageLabel(targetPage);
    }

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
    if (pageLabel === activePageLabel) {
      return;
    }

    await persistPageImmediately(activePageLabel);
    setActivePageLabel(pageLabel);
    setSelectedElementId(null);
  }

  async function handleSubmit() {
    if (!submission || submitting) {
      return;
    }

    try {
      setSubmitting(true);
      setSaveState("saving");
      await persistTitleImmediately();
      await persistPageImmediately(activePageLabel);

      const response = await fetch(`/api/submissions/${submission.id}/submit`, {
        method: "POST",
      });

      if (!response.ok) {
        const data = (await response.json()) as { error?: string };
        throw new Error(data.error || "Could not submit Titchybook");
      }

      localStorage.removeItem(ACTIVE_DRAFT_STORAGE_KEY);
      toast.success("Titchybook submitted. PDF generation is now processing.");
      router.push("/dashboard");
      router.refresh();
    } catch (error) {
      setSaveState("error");
      toast.error(error instanceof Error ? error.message : "Submit failed");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDetachFromTemplate() {
    if (!submission) return;

    if (
      !confirm(
        "This will unlock all template elements and make them fully editable. This action cannot be undone. Continue?",
      )
    ) {
      return;
    }

    try {
      const response = await fetch(
        `/api/submissions/${submission.id}/detach-from-template`,
        {
          method: "POST",
        },
      );

      if (!response.ok) {
        throw new Error("Could not detach from template");
      }

      toast.success("Template elements unlocked! Reloading...");
      // Reload the submission to get updated state
      localStorage.removeItem(ACTIVE_DRAFT_STORAGE_KEY);
      router.push(`/create?submissionId=${submission.id}`);
      router.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Detach failed");
    }
  }

  if (loading) {
    return (
      <div className="flex min-h-[calc(100vh-3.5rem)] items-center justify-center px-4 py-8">
        <div className="card px-8 py-10 text-center">
          <p className="section-label">
            Titchybook Studio
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
      style={{
        background:
          "linear-gradient(180deg, var(--color-primary-muted) 0%, var(--color-background) 40%)",
      }}
    >
      <div className="mx-auto flex max-w-[1500px] flex-col gap-5">
        {/* Template instance banner */}
        {isInstanceMode && (
          <div
            className="flex items-center justify-between rounded-xl px-5 py-3"
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
                  Template elements are locked. You can add and edit your own
                  elements on top.
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
        <section
          className="card p-5 backdrop-blur"
          style={{ background: "rgba(255,255,255,0.92)" }}
        >
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div className="space-y-2">
              <p className="section-label">
                Titchybook Studio
              </p>
              <input
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                className="w-full max-w-xl border-none bg-transparent p-0 text-3xl font-semibold tracking-tight outline-none"
                style={{ color: "var(--color-text)" }}
              />
              <p
                className="text-sm"
                style={{ color: "var(--color-text-muted)" }}
              >
                Compose each booklet page individually. Safe area guides are
                shown on the canvas.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <span
                className="badge"
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
                onClick={() => void handleSubmit()}
                disabled={submitting}
                className="btn btn-secondary btn-sm"
              >
                {submitting ? "Submitting..." : "Submit For PDF"}
              </button>
            </div>
          </div>
        </section>

        <div className="grid gap-5 xl:grid-cols-[240px_minmax(0,1fr)_320px]">
          <aside className="space-y-5">
            <section className="card p-5">
              <div className="flex items-center justify-between">
                <p
                  className="text-sm font-semibold"
                  style={{ color: "var(--color-text)" }}
                >
                  Pages
                </p>
                <span className="section-label">
                  8 total
                </span>
              </div>
              <div className="mt-4 space-y-3">
                {PAGE_LABELS.map((pageLabel) => {
                  const page = pagesByLabel[pageLabel];
                  const elementCount = page.scene.elements.length;
                  const isActive = pageLabel === activePageLabel;
                  const thumbnail = pageThumbnails[pageLabel];

                  return (
                    <button
                      key={pageLabel}
                      type="button"
                      onClick={() => void handlePageSelect(pageLabel)}
                      className="w-full rounded-xl p-3 text-left transition"
                      style={{
                        border: isActive
                          ? "2px solid var(--color-primary)"
                          : "1px solid var(--color-border)",
                        background: isActive
                          ? "var(--color-primary-muted)"
                          : "var(--color-surface)",
                        color: isActive
                          ? "var(--color-primary)"
                          : "var(--color-text)",
                      }}
                    >
                      <div
                        className="mb-2 overflow-hidden rounded-lg"
                        style={{ border: "1px solid var(--color-border)" }}
                      >
                        {thumbnail
                          ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              src={thumbnail}
                              alt={`${PAGE_LABEL_DISPLAY[pageLabel]} preview`}
                              className="h-20 w-full object-contain"
                            />
                          )
                          : (
                            <div
                              className="flex h-20 items-center justify-center text-xs"
                              style={{
                                background: "var(--color-surface)",
                                color: "var(--color-text-subtle)",
                              }}
                            >
                              No content
                            </div>
                          )}
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-semibold">
                          {PAGE_LABEL_DISPLAY[pageLabel]}
                        </span>
                        <span
                          className="text-xs"
                          style={{ color: "var(--color-text-muted)" }}
                        >
                          {elementCount}
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>
            </section>

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
                            handleAssetDelete(asset.id, asset.originalFilename)}
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
          </aside>

          <section className="space-y-4">
            <div className="card p-4">
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
                    Drag elements freely, then resize or rotate from the page.
                  </p>
                </div>
                <label
                  className="flex items-center gap-2 text-sm"
                  style={{ color: "var(--color-text-muted)" }}
                >
                  <span>Background</span>
                  <input
                    type="color"
                    value={activePage.scene.page.backgroundColor}
                    onChange={(event) => {
                      updateScene({
                        ...activePage.scene,
                        page: {
                          ...activePage.scene.page,
                          backgroundColor: event.target.value,
                        },
                      });
                    }}
                    className="h-10 w-12 rounded-lg"
                    style={{ border: "1.5px solid var(--color-border-strong)" }}
                  />
                </label>
              </div>
            </div>

            <EditorCanvas
              scene={{ ...activePage.scene, elements: mergedElements }}
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
                const templateIds = new Set(
                  activeTemplateElements.map((el) => el.id),
                );
                updateScene({
                  ...next,
                  elements: next.elements.filter(
                    (el) => !templateIds.has(el.id),
                  ),
                });
              }}
              pageLabel={activePageLabel}
              templateElementIds={new Set(
                activeTemplateElements.map((e) => e.id),
              )}
              templateTextElementIds={new Set(
                activeTemplateElements
                  .filter((e) => e.type === "text")
                  .map((e) => e.id),
              )}
              isInstanceMode={isInstanceMode}
            />
          </section>

          <div className="space-y-5">
            <PropertiesPanel
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
            />
            <LayerPanel
              elements={activePage.scene.elements}
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

      <AiChatPanel
        isOpen={aiPanelOpen}
        onToggle={() => setAiPanelOpen((prev) => !prev)}
        bookContext={aiBookContext}
        onApplyText={handleAiApplyText}
      />
    </div>
  );
}
