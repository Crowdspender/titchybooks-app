# Admin-Created Template Titchybooks: Implementation Plan

## 1. Feature Overview

### How the Template System Works
- Admins create master templates in a special admin mode with full editing capabilities
- Templates contain pre-designed elements (images, text, shapes) that are **locked** for end users
- Users create **instances** from templates, inheriting the template layer at render time while storing only their own editable layer in the instance draft
- Users can add, edit, and delete their **own elements** on top of the locked template layer
- Template and user elements are stored separately but rendered together as a unified page

### Key Definitions
- **Template**: A master Titchybook design created by admins, stored as a special submission with `mode = "TEMPLATE"` and `role = "ADMIN"`
- **Instance**: A user's working copy created from a template, stored as a regular submission with `mode = "EDITOR"`, a `templateId` reference, and user-owned page data only
- **Locked Element Behavior**: Template elements are rendered in the editor but cannot be selected, moved, resized, or deleted by users; they act as a non-interactive background layer that users design around

---

## 2. Data Model Design

### Schema Changes (prisma/schema.prisma)

**Submission Model Updates:**
```
Add fields:
- templateId: String? (self-reference to parent template)
- templateVersion: Int? (version of template used when instance was created)
- isTemplate: Boolean @default(false) (distinguishes templates from instances)
- version: Int @default(1) (used by template records)
- publishedAt: DateTime? (when a template is published)
- templateElements: TemplateElement[] (relation for elements owned by this template)
```

**New Model: TemplateElement**
```
id: String @id @default(cuid())
templateId: String
template: Submission @relation(fields: [templateId], references: [id])
pageLabel: String (FRONT_COVER, BACK_COVER, PAGE_2, etc.)
order: Int
elementJson: String (JSON string of the element, same schema as EditorElement)
createdAt: DateTime @default(now())
updatedAt: DateTime @updatedAt

@@index([templateId])
```

**Critical Source-of-Truth Rules**
- `TemplateElement` is the source of truth for the template layer
- `SubmissionPage.sceneJson` remains the source of truth for page metadata and the user layer only
- Template elements are NEVER persisted into instance `SubmissionPage.sceneJson`
- For template submissions, `SubmissionPage.sceneJson.page` can still store page-level metadata such as background color, but `sceneJson.elements` should remain empty

**Final Storage Model**
| Layer / Data | Storage Location |
| --- | --- |
| Template elements | `TemplateElement` table |
| Template page metadata | `SubmissionPage.sceneJson.page` on the template submission |
| User page metadata | `SubmissionPage.sceneJson.page` on the instance submission |
| User elements | `SubmissionPage.sceneJson.elements` on the instance submission |

**Versioning Strategy**
- Instances store `templateId` and `templateVersion` when they are created
- Template elements are fetched dynamically from `TemplateElement`
- Template page metadata can be copied into the instance at creation time so the draft has its own background/page settings
- `templateVersion` is metadata for audit, drift detection, and UI warnings in Phase 1
- `templateVersion` alone does NOT let the system render an old template revision after the template changes
- If the product requires frozen historical template rendering, add a `TemplateRevision` or immutable publish strategy before implementation; that is out of scope for this plan

**Required Fields:**
- `Submission.templateId`: Nullable, only set for instances created from templates
- `Submission.templateVersion`: Snapshot of template version at instance creation time
- `Submission.isTemplate`: Boolean flag to identify templates vs instances
- `Submission.version`: Current template version counter
- `TemplateElement.elementJson`: Follows existing EditorElement schema with no modifications

---

## 3. Layering & Rendering Model

### Rendering Order
1. Render template elements
2. Render user elements

### z-index Rules
- Template element `zIndex` is relative only to the template layer
- User element `zIndex` is relative only to the user layer
- Layer order defines cross-layer stacking
- Template layer is always below user layer
- Do NOT re-normalize z-index across both layers

### Layer Merging Strategy

**Editor Display:**
- Fetch template elements from `TemplateElement` table
- Read user scene from `SubmissionPage.sceneJson`
- Sort template elements within their own layer by `order` or `zIndex`
- Sort user elements within their own layer by `zIndex`
- Merge in-memory only: `combinedElements = [...templateElements, ...userElements]`
- Build a render-only scene using the instance page metadata plus `combinedElements`
- Tag each element with metadata: `{ ...element, layer: "template" | "user" }`

**PDF Generation:**
- In `src/lib/pdf/generate.ts`, when processing editor-mode submissions:
  - Check if `submission.templateId` exists
  - If yes, fetch template elements for each page
  - Parse the instance `sceneJson` for page metadata and user elements
  - Merge template + user elements before passing to `renderEditorSceneForPanel`
  - Render as single SVG (no visual distinction between layers in output)

---

## 4. Editor Interaction Model

### Selection Behavior
- **Template Elements**: 
  - Click does NOT select the element
  - Hover shows a subtle lock icon overlay (opacity 0.6)
  - Cursor changes to `not-allowed`
- **User Elements**:
  - Click selects normally
  - Full interaction capabilities (drag, resize, rotate, delete)

### Dragging
- **Template Elements**: Drag events are intercepted and ignored
- **User Elements**: Drag works normally via Konva's built-in drag behavior

### Resizing
- **Template Elements**: Transformer handles are hidden; resize attempts blocked
- **User Elements**: Transformer attached and functional

### Deleting
- **Template Elements**: Delete key / backspace ignored; no delete option in context menu
- **User Elements**: Delete key removes element; right-click menu shows "Delete"

### Copy/Paste
- **Template Elements**: Ctrl+C / Cmd+C blocked for template elements
- **User Elements**: Copy/paste works normally; copied elements get new IDs and offset position

### Event Handling Logic

**Implementation in EditorCanvas.tsx:**
```
For each element render:
1. Check element.layer metadata ("template" or "user")
2. If "template":
   - Set draggable={false}
   - Do not attach selection or transform handlers
   - Block mutation callbacks
   - Allow hover so the lock affordance and tooltip still work
   - Add lock icon overlay group
3. If "user":
   - Set draggable={true}
   - Attach Transformer
   - Enable all event handlers
```

**Guard Conditions:**
- `onSelectElement` callback checks `element.layer !== "template"` before allowing selection
- `onSceneChange` / element mutation helpers only operate on user-layer data
- Keyboard shortcuts (Delete, Backspace, Ctrl+C) check `selectedElement.layer !== "template"`
- Do NOT rely on `listening={false}` for template elements, because that also removes hover UX
- Treat template immutability as a layer rule, not as the persisted `locked` flag on the element schema

---

## 5. Admin vs User Modes

### Admin Mode
**Access Control:**
- Route: `/admin/templates` (new page)
- Protected by: `session.user.role === "ADMIN"` (existing pattern)
- API endpoints under `/api/admin/templates/*`

**Full Capabilities:**
- Create new templates from scratch
- Edit existing templates (all elements editable)
- Add images, text, shapes freely
- Template elements are implicitly locked for end users by layer ownership
- Publish/unpublish templates
- Duplicate templates
- Delete templates (with instance impact warning)
- View template usage statistics (how many instances created)

**Template Creation Flow:**
1. Admin clicks "Create Template" in admin dashboard
2. Opens editor in `mode = "TEMPLATE"` with full capabilities
3. Designs pages using all editor tools
4. Clicks "Publish Template" to make it available to users
5. Template stored with `isTemplate = true`, `status = "APPROVED"`

### User Mode
**Access Points:**
- Dashboard shows "Create from Template" button
- Template gallery page: `/create/templates` (lists published templates)
- User selects a template → creates instance → redirected to editor

**Restrictions:**
- Cannot modify template elements (locked layer)
- Cannot delete template elements
- Cannot change z-index of template elements
- Cannot copy template elements

**Editable Scope:**
- Add new elements (images, text, shapes) on top of template
- Edit their own elements freely
- Change page background color (optional, admin can restrict)
- Reorder their own elements (but always above template layer)

**Allowed Interactions:**
- Click to select user elements
- Drag to move user elements
- Resize/rotate user elements via transformer
- Delete user elements
- Add new elements via toolbar
- Undo/redo for user actions only

---

## 6. Template Lifecycle

### Create Template
1. Admin accesses `/admin/templates/new`
2. Creates submission with `mode = "TEMPLATE"`, `isTemplate = true`
3. Elements stored in `TemplateElement` table (not in sceneJson)
4. Status: `DRAFT`

### Edit Template
1. Admin opens template in editor
2. All elements are editable (no locks in admin mode)
3. Changes saved to `TemplateElement` table
4. Status remains `DRAFT` until published

### Publish Template
1. Admin clicks "Publish" button
2. Status changes to `APPROVED`
3. Template becomes visible in user template gallery
4. `publishedAt` timestamp recorded (add field to Submission)

### Create Instance from Template
1. User selects template from gallery
2. System creates new submission with:
   - `mode = "EDITOR"`
   - `templateId = <template.id>`
   - `templateVersion = <template.version>`
   - `status = "DRAFT"`
3. For each page:
   - Copy template page metadata into the instance page's `sceneJson.page`
   - Initialize `sceneJson.elements = []`
   - Do NOT copy template elements into the instance
4. User redirected to editor with new instance

### Update Template (Versioning Strategy)
1. Admin edits published template
2. System increments `template.version` field (add to Submission model)
3. Template status temporarily set to `DRAFT` during edits
4. Admin re-publishes → status = `APPROVED`, new version number
5. Existing instances keep their own user layer unchanged
6. In this phase, instances will render the latest template elements for their `templateId` unless revisioned template storage is added

### What Happens to Existing User Instances
- **User layer stays unchanged**: Existing instance `sceneJson` is not rewritten by template edits
- **Template layer is live-linked in this phase**: Existing instances read template elements dynamically from the referenced template
- **Version drift can be detected**: `submission.templateVersion !== template.version` can trigger a warning banner
- **Deleted template**: If the template is deleted, the instance falls back to rendering only its own page metadata and user elements

---

## 7. API Design

### Template Endpoints

**GET /api/admin/templates**
- Purpose: List all templates (admin only)
- Response: `{ templates: [{ id, title, status, version, instanceCount, createdAt }] }`

**POST /api/admin/templates**
- Purpose: Create new template
- Payload: `{ title: string, mode: "TEMPLATE" }`
- Response: `{ template: { id, status } }`

**GET /api/admin/templates/[id]**
- Purpose: Get template details with all elements
- Response: `{ template: { ...Submission }, pages: [{ pageLabel, elements: [...] }] }`

**PUT /api/admin/templates/[id]**
- Purpose: Update template metadata
- Payload: `{ title?: string, status?: string }`

**DELETE /api/admin/templates/[id]**
- Purpose: Delete template (admin only, with instance count warning)
- Response: `{ success: true }`

**POST /api/admin/templates/[id]/publish**
- Purpose: Publish template
- Response: `{ template: { id, status: "APPROVED", version: number } }`

### Public Template Endpoints

**GET /api/templates/public**
- Purpose: List published templates for users
- Response: `{ templates: [{ id, title, previewImage, createdAt }] }`

**GET /api/templates/[id]**
- Purpose: Get template preview (read-only, for gallery)
- Response: `{ template: { id, title, previewPages: [...] } }`

### Instance Endpoints

**POST /api/submissions/from-template**
- Purpose: Create instance from template
- Payload: `{ templateId: string }`
- Response: `{ submission: { id, templateId, status: "DRAFT" } }`
- Logic: Copies template page metadata into the new submission and initializes an empty user layer; template elements stay external

### Page Endpoints (Existing, Extended)

**GET /api/submissions/[id]/pages/[pageLabel]**
- Extended: If submission has `templateId`, also fetch template elements
- Response: `{ page: { ... }, templateElements: [...] }`

**PUT /api/submissions/[id]/pages/[pageLabel]**
- Purpose: Persist page metadata and user elements only
- Payload: `{ scene: { version, page, elements: [...userElementsOnly] } }`
- Logic:
  - Validate that the submitted scene conforms to the existing `EditorScene` schema
  - Validate that submitted `scene.elements` contains user elements only
  - Reject requests that include template element IDs or layer metadata indicating template ownership
  - Enforce the combined element limit using `templateElements.length + userElements.length`
  - Persist only the submitted user-layer scene to `SubmissionPage.sceneJson`
- Server never writes template elements into `sceneJson`

### Element Endpoints

**POST /api/submissions/[id]/pages/[pageLabel]/elements**
- Purpose: Add new user element
- Payload: `{ element: EditorElement }`
- Response: `{ page: { ... } }`

**PUT /api/submissions/[id]/pages/[pageLabel]/elements/[elementId]**
- Purpose: Update user element
- Payload: `{ element: EditorElement }`
- Response: `{ page: { ... } }`

**DELETE /api/submissions/[id]/pages/[pageLabel]/elements/[elementId]**
- Purpose: Delete user element
- Response: `{ page: { ... } }`

---

## 8. Frontend Architecture

### Component Structure

**New Components:**
- `src/components/admin/TemplateManager.tsx` - Admin template list and actions
- `src/components/templates/TemplateGallery.tsx` - User-facing template gallery
- `src/components/templates/TemplateCard.tsx` - Individual template preview card
- `src/components/editor/TemplateLayerIndicator.tsx` - Visual indicator for locked elements
- `src/components/editor/LayerToggle.tsx` - Toggle to show/hide template layer (for user convenience)

**Modified Components:**
- `src/components/editor/EditorWorkspace.tsx`:
  - Add `templateElements` state alongside the existing per-page user scene state
  - Derive merged render scenes before passing to EditorCanvas
  - Add mode detection: `isTemplateMode`, `isInstanceMode`
  - Load template elements on instance initialization

- `src/components/editor/EditorCanvas.tsx`:
  - Accept `layer: "template" | "user"` metadata for each element
  - Conditionally disable interactions for template elements
  - Render lock icon overlay for template elements on hover

- `src/components/editor/PropertiesPanel.tsx`:
  - Disable property editing when selected element is from template layer
  - Show "Locked Element" message instead of controls

- `src/components/layout/Header.tsx`:
  - Add "Templates" link for admin users
  - Add "Create from Template" button in dashboard

### State Management Approach

**Local State in EditorWorkspace:**
```typescript
interface EditorState {
  submissionId: string;
  isTemplate: boolean;
  templateId: string | null;
  templateElements: Record<PageLabel, EditorElement[]>;
  userScenes: Record<PageLabel, EditorScene>; // page metadata + user elements only
  selectedElementId: string | null;
  activePage: PageLabel;
}
```

**Layer Storage:**
- `templateElements`: Fetched once on page load, stored in state, never mutated by user
- `userScenes`: Source of truth for persisted page metadata and user elements
- `combinedScene`: Derived only at render time from `userScene.page + templateElements + userScene.elements`
- Do NOT store merged scenes as source of truth
- Do NOT write template elements into `sceneJson`

**How Editor Distinguishes Layers:**
- Each element tagged with metadata: `{ ...element, layer: "template" | "user" }`
- Tag added during merge, stripped before saving to database
- Layer metadata used by EditorCanvas to determine interaction behavior

**Undo/Redo:**
- History only tracks `userScenes`
- Template elements are excluded from undo/redo stack
- Undo/redo restores only page metadata and user elements

---

## 9. Rendering & PDF Pipeline

### Final Page Construction

**Editor Rendering:**
1. Fetch `templateElements` from API, or read them from the in-session template cache
2. Parse the current instance page `sceneJson` into a user scene
3. Build `combinedElements = [...templateElements, ...userElements]`
4. Preserve z-index relative only within each layer; do not globally re-normalize
5. Build a render-only scene with the persisted page metadata and `combinedElements`
6. Pass that render-only scene to `EditorCanvas`
7. EditorCanvas renders all elements, but disables mutations for template-layer elements

**PDF Generation (src/lib/pdf/generate.ts):**
1. Check if `submission.templateId` exists
2. If yes, fetch template elements for each page from `TemplateElement` table
3. Parse user elements from `SubmissionPage.sceneJson`
4. Merge layers: `mergedElements = [...templateElements, ...userElements]`
5. Create merged scene: `{ ...scene, elements: mergedElements }`
6. Pass to existing `renderEditorSceneForPanel` function
7. PDF renders as single unified image (no layer distinction)

**Rule**
- Template elements are always fetched fresh during rendering and PDF generation
- They are never stored in instance page data

### A4 → A7 Imposition
- No changes required to existing layout pipeline
- Template + user layers are merged before rendering
- `renderEditorSceneForPanel` already handles scene → panel transformation
- Imposition logic in `src/lib/pdf/layout.ts` remains unchanged

---

## 10. UX / UI Indicators

### Locked Element Visual Design

**Selection Behavior:**
- Clicking template element does NOT show transformer handles
- No selection box appears
- Element appears "unselectable"

**Hover States:**
- On hover over template element:
  - Show lock icon overlay (top-right corner of element bounding box)
  - Lock icon: SVG padlock, 16x16px, opacity 0.7
  - Tooltip on hover: "Template element (locked)"
  - Cursor: `not-allowed`

**Icons / Overlays:**
- Lock icon component: `src/components/ui/LockIcon.tsx`
- Rendered as Konva Group overlay on template elements
- Only visible on hover (opacity transitions from 0 to 0.7)
- Color: `#78716c` (stone-500)

**Layer Panel Updates (src/components/editor/LayerPanel.tsx):**
- Group elements by layer: "Template Elements" / "Your Elements"
- Template elements show lock icon next to name
- Template elements cannot be reordered in layer panel
- User can reorder their own elements within user layer group

---

## 11. Edge Cases

### Copying Pages
- If user duplicates a page within an instance:
  - Copy only the instance page metadata and user elements
  - Re-fetch template elements automatically for the duplicated page
  - Template elements remain external and locked

### Duplicating Books
- If user duplicates an entire submission (instance):
  - New submission created with same `templateId` and `templateVersion`
  - Copy only the instance page metadata and user elements
  - Template layer is not duplicated into the new submission

### Deleting Templates
- Admin attempts to delete a template with existing instances:
  - Show warning modal: "This template has X instances. Deleting it will remove the template layer from those drafts."
  - Confirmation required before deletion
  - Template elements in `TemplateElement` table are deleted
  - Existing instances fall back to rendering only their own page metadata and user elements

### "Detach from Template" (Make Fully Editable)
- Advanced feature: User can choose to "Unlock All Template Elements"
- Fetch the current template elements, append them into the instance as user-owned elements, then clear template linkage
- Remove `templateId` and `templateVersion` from the submission
- Warning modal: "This action cannot be undone. All elements will become editable."
- Implementation: Add `POST /api/submissions/[id]/detach-from-template` endpoint
- This is the one intentional exception where template elements are materialized into instance data

### Missing or Outdated Templates
- If template is deleted but instance still references it:
  - Instance renders with page metadata and user elements only
  - UI shows "Template no longer available" badge (non-blocking)
  - `templateId` remains in database for audit trail
- If template is updated to a new version:
  - Existing instances keep their own user layer unchanged
  - Existing instances render the latest template layer in this phase
  - User sees notification: "This template has changed since you created this draft"
  - `templateVersion` can be used for drift detection and messaging
  - If frozen rendering is required, add revisioned template storage before implementation

### Undo/Redo Behavior
- Undo/redo only affects user elements
- Template elements are excluded from history
- If user deletes a user element and undoes, it reappears
- Template elements never enter the undo stack
- Implementation: Filter `templateElements` out before pushing to history in `EditorWorkspace.tsx`

### Z-index Conflicts
- Do not re-normalize z-index across layers
- Template layer always renders below user layer
- If user tries to reorder elements across layers, operation is blocked
- User can only reorder within their own layer

### Element Count Limits
- Existing limit: `EDITOR_MAX_ELEMENTS_PER_PAGE = 100`
- Template elements count toward this limit
- If template has 50 elements, user can only add 50 more
- Show warning when approaching limit: "X of 100 elements used"

---

## 12. Performance Considerations

### Rendering Efficiency
- Template elements are fetched once and cached in state
- No re-fetching on every scene change
- Merge operation is O(N) where N = total elements per page
- Memoize merge function with `useMemo` to avoid unnecessary re-renders

### State Updates
- User element mutations only trigger re-renders for user layer
- Template layer is static (no state changes)
- Use React.memo for template element render components
- Debounce auto-save to avoid excessive API calls

### Avoiding Unnecessary Re-renders
- Separate state for `templateElements` and `userElements`
- Only re-render when `userElements` change
- Template elements are read-only, so no dependency changes
- Use `useCallback` for event handlers passed to child components

### Handling Large Numbers of Elements
- Current limit (100 elements per page) is manageable
- If needed in future: implement virtualization for layer panel
- Canvas rendering with Konva is efficient for 100+ elements
- PDF generation processes elements sequentially (acceptable for 100 elements)

### Database Query Optimization
- Fetch template elements with single query: `WHERE templateId = ? ORDER BY pageLabel, order`
- Use Prisma `include` to fetch template + elements in one query
- Cache template data in-memory if multiple instances use same template

### Template Caching
- Maintain an in-session cache keyed as `templateCache[templateId][pageLabel]`
- Populate the cache once per editor session
- Invalidate and refresh after admin template saves or publishes
- Avoid repeated DB/API calls while editing an instance

---

## 13. Step-by-Step Build Plan

### Phase 1 — Data Layer

**Tasks:**
1. Update `prisma/schema.prisma`:
   - Add `templateId`, `templateVersion`, `isTemplate`, `publishedAt` fields to `Submission`
   - Add `version` field to `Submission` (for template versioning)
   - Create `TemplateElement` model with relations
   - Run `npx prisma migrate dev --name add_template_system`

2. Update TypeScript types:
   - Create a render-only type such as `RenderableEditorElement = EditorElement & { layer: "template" | "user" }`
   - Create new types for template API responses in `src/types/`

3. Seed data:
   - Update `prisma/seed.ts` to create sample templates for testing
   - Create 2-3 templates with different element configurations

**Dependencies:** None
**Order:** Execute first, before any other phases

---

### Phase 2 — Editor Core Changes

**Tasks:**
1. Modify `src/components/editor/EditorWorkspace.tsx`:
   - Add state for `templateElements: Record<PageLabel, EditorElement[]>`
   - Keep `userScenes` as the only persisted page state
   - Create `mergeLayers(templateElements, userElements)` as a render-only helper
   - Update initialization logic:
     - If `submission.templateId` exists, fetch template elements
     - Populate `templateElements` state
     - Parse `sceneJson` as page metadata + user elements only
   - Update `onSceneChange` to only mutate user scenes
   - Exclude template elements from undo/redo history

2. Modify `src/components/editor/EditorCanvas.tsx`:
   - Update element rendering to accept `layer` metadata
   - Add conditional logic: if `layer === "template"`, disable interactions
   - Preserve hover interactions for template elements; do not use `listening={false}` for the actual element node
   - Add lock icon overlay on hover for template elements
   - Test selection, drag, resize, delete behavior for both layers

3. Modify `src/components/editor/PropertiesPanel.tsx`:
   - Check selected element's layer metadata
   - If template layer: show "Locked Element" message, disable controls
   - If user layer: show normal property controls

4. Modify `src/components/editor/LayerPanel.tsx`:
   - Group elements by layer
   - Show lock icons for template elements
   - Disable reordering for template elements

**Dependencies:** Phase 1 complete
**Order:** Execute after Phase 1

---

### Phase 3 — Admin Features

**Tasks:**
1. Create admin template management pages:
   - `src/app/(admin)/admin/templates/page.tsx` - Template list
   - `src/app/(admin)/admin/templates/new/page.tsx` - Create template
   - `src/app/(admin)/admin/templates/[id]/page.tsx` - Edit template

2. Create API endpoints:
   - `src/app/api/admin/templates/route.ts` - GET, POST
   - `src/app/api/admin/templates/[id]/route.ts` - GET, PUT, DELETE
   - `src/app/api/admin/templates/[id]/publish/route.ts` - POST

3. Create frontend components:
   - `src/components/admin/TemplateManager.tsx`
   - `src/components/templates/TemplateCard.tsx`

4. Update admin dashboard:
   - Add "Manage Templates" link to `src/app/(admin)/admin/page.tsx`
   - Show template statistics (count, instances, etc.)

**Dependencies:** Phase 1 complete (Phase 2 can proceed in parallel)
**Order:** Execute after Phase 1, can overlap with Phase 2

---

### Phase 4 — User Interaction Restrictions

**Tasks:**
1. Implement layer-based interaction guards:
   - Update all event handlers in `EditorCanvas.tsx` to check element layer
   - Block selection, drag, resize, delete for template elements
   - Add keyboard shortcut guards (Delete, Backspace, Ctrl+C)

2. Create template gallery for users:
   - `src/app/create/templates/page.tsx` - Public template gallery
   - `src/app/api/templates/public/route.ts` - List published templates
   - `src/components/templates/TemplateGallery.tsx`

3. Implement "Create from Template" flow:
   - User selects template → calls `POST /api/submissions/from-template`
   - Creates instance with linked `templateId` / `templateVersion`, copied page metadata, and empty user elements
   - Redirects to editor with new instance

4. Add UI indicators:
   - Create `src/components/ui/LockIcon.tsx`
   - Add hover overlays for template elements
   - Add "Locked Element" tooltip
   - Update layer panel with grouped view

**Dependencies:** Phase 2 complete
**Order:** Execute after Phase 2

---

### Phase 5 — Rendering + PDF Integration

**Tasks:**
1. Update PDF generation pipeline:
   - Modify `src/lib/pdf/generate.ts`:
     - Check if submission has `templateId`
     - If yes, fetch template elements
     - Merge template + user elements before rendering
   - Test PDF output with template-based submissions

2. Update page API endpoints:
   - Modify `src/app/api/submissions/[id]/pages/[pageLabel]/route.ts`:
     - GET: Return the persisted page scene plus `templateElements` separately
     - PUT: Accept only a user-layer scene and never persist template elements

3. Test edge cases:
   - PDF generation with empty user layer (only template elements)
   - PDF generation with overlapping template and user elements
   - Verify z-index ordering in PDF output

**Dependencies:** Phase 2 and Phase 4 complete
**Order:** Execute after Phase 2 and Phase 4

---

### Phase 6 — Testing & Edge Cases

**Tasks:**
1. Implement "Detach from Template" feature:
   - `POST /api/submissions/[id]/detach-from-template` endpoint
   - UI: "Unlock All Elements" button in editor settings
   - Warning modal with confirmation

2. Handle template updates and versioning:
   - Notification system based on `templateVersion !== template.version`
   - Decide whether "Update to Latest Version" is needed for Phase 1 or deferred
   - Test and document that user data is unchanged while the template layer is live-linked in this phase

3. Comprehensive testing:
   - Create template → create instance → verify locked elements
   - Edit template → verify instance user data is unchanged and understand template-layer update behaviour
   - Delete template → verify instances degrade safely to user-only rendering
   - Test undo/redo with template + user elements
   - Test copy/duplicate pages and submissions
   - Test PDF generation with various element combinations
   - Load testing: 100 elements per page, verify performance

4. Edge case handling:
   - Missing template elements (graceful degradation)
   - Corrupted sceneJson (error boundaries)
   - Concurrent edits (optimistic locking with `updatedAt`)

**Dependencies:** All previous phases complete
**Order:** Execute last, after all core features are implemented

---

## 14. Risks & Failure Points

### Likely Implementation Mistakes
1. **Mixing template and user elements in sceneJson**
   - Risk: Data duplication, sync bugs, and inconsistent rendering
   - Prevention: Enforce strict separation in DB, API, editor state, and PDF rendering

2. **Assuming `templateVersion` guarantees snapshot rendering**
   - Risk: The team promises stable historical rendering without storing revisions
   - Prevention: Treat `templateVersion` as metadata only unless a real revision model is added

3. **Not excluding template elements from undo/redo**
   - Risk: User can accidentally "undo" template-layer state
   - Prevention: Track only user scenes in history

4. **Forgetting to update PDF generation**
   - Risk: PDF output missing template elements
   - Prevention: Add integration tests for PDF generation with templates

### Architectural Pitfalls
1. **Using a hybrid copy/reference model**
   - Risk: Some code reads from `TemplateElement` while other code reads copied template elements from instance pages
   - Prevention: Template elements stay external everywhere except explicit detach

2. **Storing template elements in SubmissionPage.sceneJson**
   - Risk: Cannot distinguish template vs user elements
   - Prevention: Use separate `TemplateElement` table

3. **Not handling template deletion gracefully**
   - Risk: Instance rendering breaks when the referenced template disappears
   - Prevention: Fallback to page metadata + user elements only and surface a warning banner

### Common Bug Areas
1. **Event handler propagation**
   - Bug: Click on template element still triggers mutation handlers
   - Fix: Gate selection, drag, transform, delete, and copy actions by layer ownership

2. **State synchronization between layers**
   - Bug: Template elements mutated accidentally in state updates
   - Fix: Use immutable data patterns; never modify `templateElements` state

3. **API validation gaps**
   - Bug: User submits modified template element in PUT request
   - Fix: Server-side validation to reject elements matching template element IDs

4. **PDF rendering order**
   - Bug: Template elements rendered on top of user elements
   - Fix: Ensure merge order is `[...templateElements, ...userElements]` before passing to renderer

---

## 15. What NOT to Do

### Anti-Patterns to Avoid

1. **DO NOT add a `locked` boolean flag to existing elements in sceneJson**
   - This creates a single mixed list with lock flags (violates dual-layer requirement)
   - Makes it impossible to distinguish template vs user elements cleanly
   - Complicates versioning and template updates

2. **DO NOT copy template elements into instance data**
   - No duplication
   - No syncing
   - No hybrid models
   - The only exception is an explicit "Detach from Template" action

3. **DO NOT modify the existing EditorElement schema**
   - The schema in `src/lib/editor/schema.ts` should remain unchanged
   - Layer metadata is added in-memory only, not persisted
   - Adding `layer` field to schema breaks backward compatibility

4. **DO NOT allow users to reorder template elements**
   - Template element z-index is fixed by admin design
   - Allowing reordering breaks the intended template layout
   - Users can only reorder their own elements

5. **DO NOT automatically propagate template updates to instances**
   - Do not promise frozen instance rendering unless revision storage exists
   - Either accept live-linked template behaviour in Phase 1 or add a real revision model first
   - `templateVersion` metadata alone is not enough

6. **DO NOT store template elements in SubmissionPage.sceneJson for templates**
   - Templates should use `TemplateElement` table exclusively
   - Page metadata may still live in `sceneJson.page`, but `sceneJson.elements` must stay empty for templates
   - Mixing storage approaches creates inconsistency
   - Makes it harder to query and manage templates

7. **DO NOT skip server-side validation**
   - Client-side checks can be bypassed
   - Always validate on server that user is not modifying template elements
   - Reject requests that include template element modifications

8. **DO NOT include template elements in undo/redo history**
   - Template elements are immutable from user perspective
   - Including them in history creates confusing undo behavior
   - Filter template elements before pushing to history stack

9. **DO NOT allow copy/paste of template elements**
   - Copying template elements would create unlocked duplicates
   - Defeats the purpose of locked template layer
   - Block Ctrl+C / Cmd+C for template elements

10. **DO NOT use `listening={false}` as the main template-lock mechanism**
    - It removes hover affordances and makes lock UX harder
    - Block mutations deliberately while still allowing hover feedback

11. **DO NOT hardcode template IDs or element IDs**
    - Always use database-generated IDs (cuid)
    - Hardcoding breaks multi-tenant scenarios
    - Makes testing and seeding difficult

---

## Summary

This plan implements a **dual-layer template system** where:
- Admins create templates with locked elements stored in a separate `TemplateElement` table
- Users create instances that store only page metadata and user elements in `SubmissionPage.sceneJson`
- Editor merges layers in-memory for rendering, but enforces interaction restrictions on template layer
- PDF generation merges layers before rendering for unified output
- Template elements are fetched dynamically; Phase 1 treats `templateVersion` as metadata, not as true revision storage

**Key Architectural Decisions:**
- Separate `TemplateElement` table (not mixed in sceneJson)
- Persist only the user layer in instance page data
- In-memory layer metadata (not persisted to schema)
- Server-side validation for all layer mutations
- No cross-layer z-index normalization

**Implementation Order:**
Phase 1 (Data) → Phase 2 (Editor Core) → Phase 3 (Admin) → Phase 4 (User Restrictions) → Phase 5 (PDF) → Phase 6 (Testing)

This plan is now internally consistent with the current codebase. If the team wants frozen historical template versions rather than live-linked template elements, add revisioned template storage before development starts.
