# Titchybook Editor Implementation Spec

## Goal

Move the product from a fixed "upload 8 full-page images" flow to an editor where users compose each booklet page from multiple text and image elements, then export the result into the existing print-ready Titchybook PDF layout.

The target is not a full Canva clone. The target is a constrained creative editor optimized for an 8-page folded mini-booklet.

## Current State

The current implementation is built around these assumptions:

- Each submission contains exactly 8 page images.
- Each image maps to one fixed logical page label.
- The PDF generator resizes/crops each image and places it onto a fixed imposed A4 layout.

Relevant code seams:

- Upload UI: `src/components/create/UploadGrid.tsx`
- Individual upload slots: `src/components/create/ImageUploader.tsx`
- Submission validation and persistence: `src/app/api/submissions/route.ts`
- Fixed logical page labels: `src/lib/constants.ts`
- Print layout coordinates: `src/lib/pdf/layout.ts`
- PDF generation: `src/lib/pdf/generate.ts`
- Current schema: `prisma/schema.prisma`

## Product Direction

Users should edit 8 logical booklet pages, not the imposed A4 print sheet.

The system should continue to do imposition automatically at export time:

1. User edits 8 logical pages in an editor.
2. Each logical page is rendered to a print-safe asset.
3. The existing PDF pipeline places those 8 rendered pages onto the imposed A4 sheet.
4. User receives the same fold-and-print output format as today.

This keeps the print math isolated and lets the editor stay intuitive.

## Recommended Technical Direction

### Editor stack

Use `react-konva` + `konva` for the on-page editor.

Reasons:

- Better fit than DOM drag-and-drop for freeform positioned elements.
- Native support for drag, resize, rotate, layers, transforms, and canvas export.
- Suitable for fixed-dimension print-oriented pages.

Use `@dnd-kit` only for non-canvas interactions if needed:

- page thumbnails
- layer list reordering
- asset tray interactions

Do not use `@dnd-kit` as the primary page composition engine.

### State model

Treat editor state as application data, not as serialized canvas internals.

Store typed scene JSON for each logical page. The scene should be framework-agnostic enough that:

- the client editor can render it
- the server can validate it
- the export pipeline can render from it
- a future vector PDF renderer can reuse it

### Export strategy

Phase 1 export should rasterize each logical page to a high-resolution PNG, then reuse the current `pdf-lib` imposition flow.

This is the lowest-risk path because it preserves:

- `PANELS` in `src/lib/pdf/layout.ts`
- most of `generateTitchybookPdf()` in `src/lib/pdf/generate.ts`
- S3 upload/download behavior

Longer term, the same scene schema can support direct PDF rendering for sharper text and lower file sizes.

## Proposed Data Model

The current schema only supports `Submission` and `SubmissionImage`. That is too limited for draft editing and multi-element pages.

Add the following concepts.

### `Asset`

Represents any uploaded source image available to the editor.

Suggested fields:

- `id`
- `userId`
- `s3Key`
- `originalFilename`
- `mimeType`
- `width`
- `height`
- `fileSize`
- `createdAt`

Notes:

- Assets should be reusable across submissions.
- Persist dimensions at ingest time so resolution warnings can be calculated without repeatedly loading binaries.

### `Submission`

Keep the existing model, but add draft/editor metadata.

Suggested additions:

- `mode` (`LEGACY_UPLOAD` or `EDITOR`)
- `title`
- `status`
- `pdfS3Key`
- `previewS3Key`
- `editorVersion`
- `submittedAt`

### `SubmissionPage`

Represents one logical booklet page.

Suggested fields:

- `id`
- `submissionId`
- `pageLabel`
- `order`
- `sceneJson`
- `previewS3Key`
- `renderedPageS3Key`
- `createdAt`
- `updatedAt`

Notes:

- `sceneJson` is the source of truth for editable content.
- `previewS3Key` is a lightweight thumbnail for dashboard/admin screens.
- `renderedPageS3Key` is the print-resolution output used by the PDF generator.

### Legacy compatibility

Keep `SubmissionImage` during migration so the current flow remains valid.

After the editor flow is stable, either:

- deprecate `SubmissionImage`, or
- keep it as a compatibility mode for "simple upload" submissions

## Proposed Scene Schema

This should be a TypeScript-first schema validated with `zod`.

Suggested shape:

```ts
type EditorScene = {
  version: 1;
  page: {
    widthMm: number;
    heightMm: number;
    backgroundColor: string;
  };
  elements: EditorElement[];
};

type EditorElement =
  | ImageElement
  | TextElement
  | ShapeElement;

type BaseElement = {
  id: string;
  type: "image" | "text" | "shape";
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  opacity: number;
  locked: boolean;
  visible: boolean;
  zIndex: number;
};

type ImageElement = BaseElement & {
  type: "image";
  assetId: string;
  crop: {
    x: number;
    y: number;
    scaleX: number;
    scaleY: number;
  };
  cornerRadius?: number;
};

type TextElement = BaseElement & {
  type: "text";
  text: string;
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  lineHeight: number;
  letterSpacing: number;
  color: string;
  align: "left" | "center" | "right";
  verticalAlign?: "top" | "middle" | "bottom";
};

type ShapeElement = BaseElement & {
  type: "shape";
  shape: "rect" | "circle" | "line";
  fill: string;
  stroke?: string;
  strokeWidth?: number;
};
```

Coordinate recommendation:

- Store editor coordinates in page-relative pixels, not mm.
- Keep a single canonical page size for editing, for example `700 x 1000`.
- Convert to print dimensions only during export.

This keeps the UI simpler while still supporting deterministic output.

## Page Geometry

Keep the logical page set exactly as it is today:

- `FRONT_COVER`
- `BACK_COVER`
- `PAGE_2`
- `PAGE_3`
- `PAGE_4`
- `PAGE_5`
- `PAGE_6`
- `PAGE_7`

Keep the imposition geometry in `src/lib/pdf/layout.ts`.

The editor should expose each page individually with a trim-safe frame and guides:

- trim boundary
- safe margin
- optional bleed visualization

Recommended first release:

- no true bleed support in exported content
- show safe area only

Recommended second release:

- add bleed-aware rendering and background overflow support

## API Changes

### Asset upload

Current upload signing endpoint is tied to a `pageLabel`:

- `src/app/api/upload/presign/route.ts`

This should be generalized.

Recommended new contract:

- `POST /api/assets/presign`
- request body: filename, contentType, usage
- response: uploadUrl, s3Key, proposed asset metadata

Recommended follow-up endpoint:

- `POST /api/assets`
- request body: uploaded file metadata
- server records the asset row after upload completes

### Draft submission lifecycle

Add routes for draft editing:

- `POST /api/submissions`
  - create draft submission in `EDITOR` mode
- `GET /api/submissions/:id`
  - fetch full submission with pages
- `PATCH /api/submissions/:id`
  - update title or submission-level metadata
- `PUT /api/submissions/:id/pages/:pageLabel`
  - save one page scene
- `POST /api/submissions/:id/submit`
  - validate all pages and queue render/export

### Validation rules

Server-side validation should enforce:

- exactly 8 pages exist
- all 8 required labels are present
- no unsupported element types
- page scene version is recognized
- referenced assets belong to the current user
- text length and object counts stay within sane limits

## Frontend Architecture

### Main route

Replace the current `/create` upload-only route with an editor workspace.

Suggested layout:

- left rail: page list and templates
- center: active page canvas
- right rail: properties panel
- top bar: title, save status, preview, submit
- bottom or side tray: uploaded assets

### Suggested component structure

- `EditorWorkspace`
- `PageThumbnailList`
- `EditorCanvas`
- `CanvasElementRenderer`
- `SelectionTransformer`
- `PropertiesPanel`
- `AssetLibrary`
- `TopToolbar`
- `PageNavigator`

### State boundaries

Use local editor state for immediate interactions and persist on a debounce.

Suggested split:

- local transient state
  - active selection
  - hover state
  - drag state
  - resize state
- persisted document state
  - page scene
  - asset references
  - title

### Autosave

Recommended behavior:

- save after 500-1000ms debounce
- show `Saving...` and `Saved` states
- recover from failed save without losing local changes

Do not require manual save as the only persistence mechanism.

## Export Pipeline

### Phase 1: Raster page rendering

Recommended flow:

1. Load all 8 `SubmissionPage.sceneJson` records.
2. Render each logical page to high-resolution PNG.
3. Upload each rendered page to S3.
4. Feed rendered page images into the existing imposition pipeline.
5. Generate final PDF and store `pdfS3Key`.

There are two implementation options for page rendering.

Option A: Client-side render then upload.

Pros:

- simpler to build first
- leverages Konva export directly

Cons:

- browser-dependent
- weaker trust boundary
- harder to rerender server-side later

Option B: Server-side render worker.

Pros:

- deterministic
- easier regeneration
- cleaner submission pipeline

Cons:

- more implementation effort

Recommendation:

- MVP: client-side preview export is acceptable
- submission export: aim for server-owned rendering as soon as practical

### Phase 2: Direct PDF rendering

Once the scene schema stabilizes, replace raster page export for text-heavy pages with direct PDF drawing:

- text via `pdf-lib` drawing APIs
- images via `drawImage`
- background shapes via rectangles and vector paths

This improves:

- text sharpness
- file size
- print fidelity

Do not start here. It increases complexity too early.

## Resolution and Print Rules

This product is print-oriented, so the editor must guard users from creating poor output.

Add checks for:

- asset effective DPI at its placed size
- text too close to trim edge
- elements extending outside page bounds unless intentionally allowed
- empty pages
- unsupported fonts

Recommended thresholds:

- warning below 200 DPI
- hard warning below 150 DPI

Warnings do not need to block draft save. They should block final submit only if quality is clearly unacceptable.

## Background Jobs

The current API triggers PDF generation inline from the request lifecycle in `src/app/api/submissions/route.ts`.

That is acceptable for the current lightweight flow, but not for a richer editor pipeline.

Recommended target:

- submission creates a render job
- worker renders logical pages
- worker generates final PDF
- worker updates submission status

Suggested statuses:

- `DRAFT`
- `READY_FOR_RENDER`
- `PROCESSING`
- `PENDING_REVIEW`
- `APPROVED`
- `REJECTED`
- `FAILED`

If background infrastructure is not ready yet, keep a simpler version first but isolate rendering code so it can be moved into a worker later.

## Admin and Dashboard Impact

Dashboard should evolve from "download finished PDF" only to also show:

- draft vs submitted state
- page previews
- last edited time
- validation/export errors

Admin should be able to review:

- generated PDF
- page preview strip
- basic asset quality warnings

## Milestones

### Milestone 1: Schema and contracts

Scope:

- add new Prisma models
- add scene schema types and validators
- add asset upload endpoints
- create draft submission/page APIs

Deliverable:

- a saved 8-page empty draft can be created and loaded

### Milestone 2: Editor MVP

Scope:

- page navigation
- image upload into asset library
- add/move/resize/rotate image elements
- add/edit text elements
- autosave
- preview thumbnails

Deliverable:

- user can compose all 8 pages and reopen the draft later

### Milestone 3: Export integration

Scope:

- render each page to print output
- connect rendered outputs to PDF generator
- submit flow and statuses

Deliverable:

- editor-created submissions produce the same final imposed PDF format as legacy submissions

### Milestone 4: Quality and usability

Scope:

- layer ordering UI
- safe zone overlays
- resolution warnings
- duplicate/delete/lock elements
- undo/redo

Deliverable:

- editor is usable for normal customer work without frequent failure or confusion

### Milestone 5: Hardening

Scope:

- background worker
- admin preview improvements
- template system
- optional direct PDF vector rendering

Deliverable:

- scalable production workflow

## Suggested File-Level Work Plan

### New files likely needed

- `src/lib/editor/schema.ts`
- `src/lib/editor/constants.ts`
- `src/lib/editor/validation.ts`
- `src/lib/editor/render.ts`
- `src/components/editor/EditorWorkspace.tsx`
- `src/components/editor/EditorCanvas.tsx`
- `src/components/editor/PropertiesPanel.tsx`
- `src/components/editor/PageThumbnailList.tsx`
- `src/components/editor/AssetLibrary.tsx`
- `src/app/api/assets/presign/route.ts`
- `src/app/api/assets/route.ts`
- `src/app/api/submissions/[id]/submit/route.ts`
- `src/app/api/submissions/[id]/pages/[pageLabel]/route.ts`

### Existing files likely to change

- `prisma/schema.prisma`
- `src/app/(protected)/create/page.tsx`
- `src/app/api/submissions/route.ts`
- `src/app/api/submissions/[id]/route.ts`
- `src/lib/s3.ts`
- `src/lib/constants.ts`
- `src/lib/pdf/generate.ts`

## Risks

### 1. Overbuilding too early

Trying to ship full Canva-like behavior immediately will slow the project down and increase instability.

Mitigation:

- ship constrained editor primitives first
- keep supported element types small

### 2. Print fidelity

If export is handled casually, the final booklet quality will degrade.

Mitigation:

- preserve current imposition layer
- enforce resolution checks
- standardize export dimensions

### 3. State complexity

Freeform editing introduces much more state than the current upload grid.

Mitigation:

- define a strict scene schema early
- separate transient UI state from persisted document state

### 4. Async processing reliability

Richer rendering will outgrow inline request-based processing.

Mitigation:

- isolate export code now
- move to worker/queue before scale

## Recommended First Build

If implementation starts now, build this exact scope first:

1. Add draft submissions and `SubmissionPage`.
2. Build an editor for image and text only.
3. Keep 8 fixed logical pages.
4. Export each page to PNG.
5. Reuse the current imposed PDF generator.
6. Add basic safe-area and resolution warnings.

This gives the product a meaningful creative leap without forcing a ground-up rewrite of the PDF/export system.

## Immediate Next Tasks

1. Update Prisma schema for `Asset` and `SubmissionPage`.
2. Define the editor scene schema and validation rules in TypeScript.
3. Add generalized asset upload endpoints.
4. Replace the upload grid route with a draft-aware editor shell.
5. Add page save/load APIs.
6. Refactor the PDF generator to accept either legacy `SubmissionImage` inputs or editor-rendered page assets.
