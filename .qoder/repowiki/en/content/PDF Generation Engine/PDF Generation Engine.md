# PDF Generation Engine

<cite>
**Referenced Files in This Document**
- [render-job.ts](file://src/lib/pdf/render-job.ts)
- [snapshot.ts](file://src/lib/pdf/snapshot.ts)
- [generate.ts](file://src/lib/pdf/generate.ts)
- [image-processor.ts](file://src/lib/pdf/image-processor.ts)
- [editor-render.ts](file://src/lib/pdf/editor-render.ts)
- [layout.ts](file://src/lib/pdf/layout.ts)
- [render-worker.ts](file://src\workers\render-worker.ts)
- [route.ts](file://src/app/api/submissions/[id]/submit/route.ts)
- [route.ts](file://src/app/api/submissions/route.ts)
- [route.ts](file://src/app/api/submissions/from-template/route.ts)
- [route.ts](file://src/app/api/upload/presign/route.ts)
- [submission-store.ts](file://src/lib/editor/submission-store.ts)
- [constants.ts](file://src/lib/constants.ts)
- [prisma.ts](file://src/lib/prisma.ts)
- [s3.ts](file://src/lib/s3.ts)
- [template-types.ts](file://src/lib/editor/template-types.ts)
- [schema.ts](file://src/lib/editor/schema.ts)
- [constants.ts](file://src/lib/editor/constants.ts)
- [validation.ts](file://src/lib/editor/validation.ts)
- [ImageUploader.tsx](file://src/components/create/ImageUploader.tsx)
- [UploadGrid.tsx](file://src/components/create/UploadGrid.tsx)
- [package.json](file://package.json)
- [schema.prisma](file://prisma/schema.prisma)
</cite>

## Update Summary
**Changes Made**
- Added comprehensive documentation for the new render job management system with transaction-safe queuing, lease-based locking, and heartbeat mechanism
- Documented the retry logic with exponential backoff and input snapshotting for distributed processing
- Enhanced the architecture diagrams to reflect the durable worker pattern and job lifecycle management
- Added detailed explanation of the RenderJob database schema and state transitions
- Expanded the submission workflow to include background job processing with fault tolerance
- Updated error handling and recovery mechanisms for distributed rendering operations

## Table of Contents
1. [Introduction](#introduction)
2. [Project Structure](#project-structure)
3. [Core Components](#core-components)
4. [Architecture Overview](#architecture-overview)
5. [Detailed Component Analysis](#detailed-component-analysis)
6. [Dependency Analysis](#dependency-analysis)
7. [Performance Considerations](#performance-considerations)
8. [Troubleshooting Guide](#troubleshooting-guide)
9. [Conclusion](#conclusion)
10. [Appendices](#appendices)

## Introduction
This document describes the enhanced PDF generation engine that produces an 8-panel booklet on A4 landscape canvas with a robust, distributed render job management system. The engine now supports sophisticated template-based workflows with automatic template merging and text override capabilities, backed by a durable job queue with lease-based locking, heartbeat monitoring, and exponential backoff retry logic. It covers the complete end-to-end workflow from template creation to final PDF output, including transaction-safe queuing, input snapshotting, and improved error handling for distributed processing. The system ensures reliable PDF generation even in multi-worker environments with automatic recovery from failures and process crashes.

## Project Structure
The PDF generation engine now spans multiple specialized layers with enhanced render job management:
- API routes orchestrate both traditional image submissions and template-based editor submissions with background job queuing.
- The render job manager provides transaction-safe queuing, lease-based locking, heartbeat monitoring, and retry logic with exponential backoff.
- The PDF generator coordinates database retrieval, S3 image retrieval, image processing, SVG rendering, PDF composition, and S3 upload within isolated job contexts.
- Dedicated PDF generation components handle image processing and editor scene rendering with input snapshotting for reliability.
- Template management system enables template creation, merging, text overrides, and instance generation with database-backed persistence.
- Durable worker processes claim and process jobs with automatic recovery from failures and lease expiration.
- Constants define page labels, accepted image types, sizes, and editor-specific dimensions.
- S3 utilities manage presigned URLs, uploads, downloads, and key construction with attempt-scoped prefixes.
- Frontend components collect images and manage editor scenes for template-based creation.

```mermaid
graph TB
subgraph "API Layer"
A1["/api/submissions<br/>POST/GET"]
A2["/api/submissions/[id]/submit<br/>POST"]
A3["/api/upload/presign<br/>GET"]
A4["/api/submissions/from-template<br/>POST"]
end
subgraph "Render Job Management"
J1["enqueueInTransaction()<br/>render-job.ts"]
J2["claimRenderJob()<br/>lease-based locking"]
J3["heartbeat()<br/>lease renewal"]
J4["processRenderJob()<br/>retry + snapshot"]
end
subgraph "PDF Engine"
E1["generateTitchybookPdf()<br/>generate.ts"]
E2["processImageForPanel()<br/>image-processor.ts"]
E3["renderEditorSceneForPanel()<br/>editor-render.ts"]
end
subgraph "Durable Worker"
W1["render-worker.ts<br/>poll + claim + process"]
end
subgraph "Template System"
T1["Template Types<br/>template-types.ts"]
T2["Editor Schema<br/>schema.ts"]
T3["Template Elements<br/>Database Schema"]
end
subgraph "Storage"
S3["AWS S3"]
DB["PostgreSQL<br/>RenderJob Table"]
end
A1 --> J1
A2 --> J1
A3 --> S3
A4 --> T1
W1 --> J2
J2 --> J4
J4 --> E1
E1 --> DB
E1 --> S3
E1 --> E2
E1 --> E3
T1 --> E1
T2 --> E3
T3 --> DB
DB --> J1
DB --> J2
```

**Diagram sources**
- [render-job.ts:17-33](file://src/lib/pdf/render-job.ts#L17-L33)
- [render-job.ts:36-52](file://src/lib/pdf/render-job.ts#L36-L52)
- [render-worker.ts:17-32](file://src/workers/render-worker.ts#L17-L32)
- [route.ts:7-16](file://src/app/api/submissions/[id]/submit/route.ts#L7-L16)
- [route.ts:1-147](file://src/app/api/submissions/route.ts#L1-L147)
- [route.ts:1-100](file://src/app/api/submissions/from-template/route.ts#L1-L100)
- [route.ts:1-38](file://src/app/api/upload/presign/route.ts#L1-L38)
- [generate.ts:10-42](file://src/lib/pdf/generate.ts#L10-L42)
- [image-processor.ts:1-30](file://src/lib/pdf/image-processor.ts#L1-L30)
- [editor-render.ts:1-329](file://src/lib/pdf/editor-render.ts#L1-L329)
- [template-types.ts:1-103](file://src/lib/editor/template-types.ts#L1-L103)
- [schema.ts:1-116](file://src/lib/editor/schema.ts#L1-L116)
- [schema.prisma:217-239](file://prisma/schema.prisma#L217-L239)

**Section sources**
- [render-job.ts:17-33](file://src/lib/pdf/render-job.ts#L17-L33)
- [render-job.ts:36-52](file://src/lib/pdf/render-job.ts#L36-L52)
- [render-worker.ts:17-32](file://src/workers/render-worker.ts#L17-L32)
- [route.ts:7-16](file://src/app/api/submissions/[id]/submit/route.ts#L7-L16)
- [route.ts:1-147](file://src/app/api/submissions/route.ts#L1-L147)
- [route.ts:1-100](file://src/app/api/submissions/from-template/route.ts#L1-L100)
- [route.ts:1-38](file://src/app/api/upload/presign/route.ts#L1-L38)
- [generate.ts:10-42](file://src/lib/pdf/generate.ts#L10-L42)
- [image-processor.ts:1-30](file://src/lib/pdf/image-processor.ts#L1-L30)
- [editor-render.ts:1-329](file://src/lib/pdf/editor-render.ts#L1-L329)
- [template-types.ts:1-103](file://src/lib/editor/template-types.ts#L1-L103)
- [schema.ts:1-116](file://src/lib/editor/schema.ts#L1-L116)
- [schema.prisma:217-239](file://prisma/schema.prisma#L217-L239)

## Core Components
- **Submission API**: Validates and persists both traditional 8-panel image entries and editor-based submissions, triggers background PDF generation through the render job queue, and lists user submissions.
- **Render Job Manager**: Provides transaction-safe queuing with submission locking, lease-based job claiming with atomic updates, heartbeat monitoring for long-running jobs, and retry logic with exponential backoff.
- **Input Snapshotting**: Captures immutable render inputs at enqueue time, ensuring consistent rendering even if source data changes during processing.
- **Durable Worker**: Polls for available jobs, claims them with lease-based locking, processes them with automatic recovery, and handles graceful shutdown.
- **PDF Generator**: Handles dual workflows - downloads images from S3 for traditional mode or renders SVG scenes for editor mode, processes them, composes an A4 landscape PDF via pdf-lib, uploads the PDF to S3, and updates the submission status.
- **Image Processor**: Uses sharp to resize, crop, and rotate images to fit panels precisely for traditional image-based generation.
- **Editor Renderer**: Converts editor scenes to SVG, performs text wrapping, applies transformations, and renders to PNG buffers for PDF embedding.
- **Template System**: Manages template creation, element merging, text overrides, and instance generation from templates with database-backed persistence.
- **S3 Utilities**: Provides presigned upload/download URLs and manages uploads/downloads with attempt-scoped prefixes for isolation.
- **Frontend Upload Grid**: Collects 8 images with drag-and-drop for traditional mode, or manages editor scenes for template-based creation.

**Section sources**
- [render-job.ts:17-33](file://src/lib/pdf/render-job.ts#L17-L33)
- [render-job.ts:36-52](file://src/lib/pdf/render-job.ts#L36-L52)
- [render-job.ts:107-124](file://src/lib/pdf/render-job.ts#L107-L124)
- [render-worker.ts:17-32](file://src/workers/render-worker.ts#L17-L32)
- [snapshot.ts:39-60](file://src/lib/pdf/snapshot.ts#L39-L60)
- [generate.ts:10-42](file://src/lib/pdf/generate.ts#L10-L42)
- [image-processor.ts:1-30](file://src/lib/pdf/image-processor.ts#L1-L30)
- [editor-render.ts:1-329](file://src/lib/pdf/editor-render.ts#L1-L329)
- [template-types.ts:1-103](file://src/lib/editor/template-types.ts#L1-L103)
- [s3.ts:1-81](file://src/lib/s3.ts#L1-L81)
- [ImageUploader.tsx:1-148](file://src/components/create/ImageUploader.tsx#L1-L148)
- [UploadGrid.tsx:1-115](file://src/components/create/UploadGrid.tsx#L1-L115)

## Architecture Overview
The engine now supports two distinct pipelines with advanced template capabilities and robust job management:
1. **Traditional Workflow**: User uploads 8 images through the frontend, backend validates and persists entries, enqueues a render job in the queue, background worker processes images, and creates a PDF with automatic retry and recovery.
2. **Template-Based Workflow**: User creates submissions in EDITOR mode, optionally from templates, the system merges template elements with user content, applies text overrides, enqueues a render job, background worker renders SVG scenes, and generates PDFs with fault tolerance.

```mermaid
sequenceDiagram
participant FE as "Frontend"
participant API as "Submissions API"
participant QM as "Queue Manager"
participant W as "Worker"
participant GEN as "PDF Generator"
participant DB as "PostgreSQL"
participant S3 as "S3"
FE->>API : "POST /api/submissions {mode : EDITOR}"
API->>QM : "enqueueInTransaction(submissionId)"
QM->>DB : "Lock submission + create RenderJob"
QM-->>FE : "201 Created {jobId,status}"
par Background Processing
W->>Q : "claimRenderJob()"
Q->>DB : "Atomic UPDATE with FOR UPDATE SKIP LOCKED"
DB-->>W : "Claimed job with lease"
loop Heartbeat (every 20s)
W->>Q : "heartbeat(job)"
Q->>DB : "Extend leaseExpiresAt"
end
W->>GEN : "processRenderJob(job)"
GEN->>DB : "Read frozen inputSnapshot"
alt Template-Based Mode
GEN->>DB : "Fetch template elements by pageLabel"
GEN->>GEN : "Merge template + user scenes<br/>Apply text overrides"
GEN->>GEN : "renderEditorSceneForPanel()"
GEN->>GEN : "SVG rendering + text wrapping"
else Traditional Image Mode
GEN->>S3 : "Download 8 image buffers"
GEN->>GEN : "processImageForPanel() per panel"
GEN->>GEN : "PNG encoding"
end
GEN->>GEN : "Compose A4 landscape PDF"
GEN->>S3 : "Upload PDF with attempt prefix"
GEN->>Q : "publishRender(job, artifacts)"
Q->>DB : "Update submission + job status"
end
```

**Diagram sources**
- [render-job.ts:17-33](file://src/lib/pdf/render-job.ts#L17-L33)
- [render-job.ts:36-52](file://src/lib/pdf/render-job.ts#L36-L52)
- [render-job.ts:107-124](file://src/lib/pdf/render-job.ts#L107-L124)
- [render-worker.ts:17-32](file://src/workers/render-worker.ts#L17-L32)
- [route.ts:7-16](file://src/app/api/submissions/[id]/submit/route.ts#L7-L16)
- [generate.ts:10-42](file://src/lib/pdf/generate.ts#L10-L42)
- [schema.prisma:217-239](file://prisma/schema.prisma#L217-L239)

## Detailed Component Analysis

### Enhanced 8-Page Booklet Template Design
The engine now supports sophisticated template-based layouts with automatic merging and robust job management:
- Canvas: A4 landscape page with precise panel coordinates in millimeters.
- Panels: Eight panels arranged to form a folded 8-page booklet when printed.
- Dimensions and Layout: Panel widths, heights, and positions are defined in the layout module and converted from millimeters to PDF points for pdf-lib.
- Origin: pdf-lib uses bottom-left origin; the generator converts top-left panel coordinates accordingly.
- Back Cover Branding: Special handling for permanent branding band on back cover panels.
- Template Integration: Seamless integration with template system for dynamic content generation with job isolation.
- Job Isolation: Each render job operates on frozen input snapshots, ensuring consistent results even with concurrent edits.

```mermaid
flowchart TD
Start(["Submit for Rendering"]) --> Queue["enqueueInTransaction()<br/>Lock submission + capture snapshot"]
Queue --> JobCreated["RenderJob created<br/>status = PROCESSING"]
JobCreated --> Worker{"Worker Available?"}
Worker --> |Yes| Claim["claimRenderJob()<br/>Atomic lock with SKIP LOCKED"]
Worker --> |No| Wait["Poll nextAttemptAt"]
Claim --> Process["processRenderJob()<br/>Load frozen inputSnapshot"]
Process --> Mode{"Mode Check"}
Mode --> |EDITOR| Merge["Merge template + user scenes<br/>Apply text overrides"]
Mode --> |LEGACY| Images["Download 8 image buffers"]
Merge --> Render["renderEditorSceneForPanel()<br/>SVG rendering + text wrapping"]
Images --> ProcessImg["processImageForPanel()<br/>resize/crop/rotate"]
Render --> Embed["Embed PNG into PDF"]
ProcessImg --> Embed
Embed --> Position["Convert mm to points<br/>Flip Y-axis for pdf-lib origin"]
Position --> Draw["Draw image on page"]
Draw --> Branding{"Back Cover Panel?"}
Branding --> |Yes| Brand["Draw branding band<br/>+ text overlay"]
Branding --> |No| Next{"More panels?"}
Brand --> Next
Next --> |Yes| Mode
Next --> |No| Save["Save PDF bytes"]
Save --> Publish["publishRender()<br/>Update submission + job"]
Publish --> End(["Ready for admin review"])
```

**Diagram sources**
- [render-job.ts:17-33](file://src/lib/pdf/render-job.ts#L17-L33)
- [render-job.ts:36-52](file://src/lib/pdf/render-job.ts#L36-L52)
- [render-job.ts:107-124](file://src/lib/pdf/render-job.ts#L107-L124)
- [generate.ts:10-42](file://src/lib/pdf/generate.ts#L10-L42)
- [snapshot.ts:39-60](file://src/lib/pdf/snapshot.ts#L39-L60)

**Section sources**
- [render-job.ts:17-33](file://src/lib/pdf/render-job.ts#L17-L33)
- [render-job.ts:36-52](file://src/lib/pdf/render-job.ts#L36-L52)
- [render-job.ts:107-124](file://src/lib/pdf/render-job.ts#L107-L124)
- [generate.ts:10-42](file://src/lib/pdf/generate.ts#L10-L42)
- [snapshot.ts:39-60](file://src/lib/pdf/snapshot.ts#L39-L60)
- [layout.ts:1-105](file://src/lib/pdf/layout.ts#L1-L105)
- [constants.ts:1-59](file://src/lib/constants.ts#L1-L59)

### Template Merging and Text Override System
The template system enables sophisticated content management with dynamic customization and job isolation:
- Template Elements: Stored separately from user content in the database, allowing reuse across multiple instances.
- Merge Strategy: Template elements are merged with user scenes, with template elements placed below user elements.
- Text Overrides: Per-instance text overrides allow users to customize template text while keeping other properties fixed.
- Instance Tracking: Each submission maintains templateId and templateVersion for auditability.
- Database Integration: Template elements are stored with pageLabel grouping for efficient retrieval and merging.
- Input Freezing: Template merges are captured in input snapshots, ensuring consistent rendering even if templates change.
- Job Isolation: Each render job operates on its own frozen snapshot, preventing race conditions during template updates.

```mermaid
flowchart TD
A["Template Elements<br/>(pageLabel grouped)"] --> B["User Scene<br/>(editor page)"]
B --> C["Parse Editor Scene"]
C --> D{"Template Elements Exist?"}
D --> |Yes| E["Parse Template Elements<br/>JSON -> EditorElement"]
E --> F["Apply Text Overrides<br/>templateTextOverrides"]
F --> G["Merge Elements<br/>Template Below User"]
D --> |No| H["Use User Scene Only"]
G --> I["Create Merged Scene"]
H --> I
I --> J["Capture in Input Snapshot"]
J --> K["renderEditorSceneForPanel()"]
K --> L["Job operates on frozen snapshot"]
```

**Diagram sources**
- [render-job.ts:24-26](file://src/lib/pdf/render-job.ts#L24-L26)
- [snapshot.ts:49-57](file://src/lib/pdf/snapshot.ts#L49-L57)
- [generate.ts:23-25](file://src/lib/pdf/generate.ts#L23-L25)

**Section sources**
- [render-job.ts:24-26](file://src/lib/pdf/render-job.ts#L24-L26)
- [snapshot.ts:49-57](file://src/lib/pdf/snapshot.ts#L49-L57)
- [generate.ts:23-25](file://src/lib/pdf/generate.ts#L23-L25)
- [template-types.ts:95-102](file://src/lib/editor/template-types.ts#L95-L102)
- [schema.ts:85-87](file://src/lib/editor/schema.ts#L85-L87)

### Advanced Image Processing Pipeline
The pipeline now handles both traditional images and template-rendered content with job isolation:
- **Traditional Images**: Sharp-based processing with 300 DPI target, cover-fit resizing, center-cropping, and optional 180° rotation for bottom panels.
- **Template Scenes**: SVG rendering with precise text wrapping, font estimation, and element sorting by zIndex.
- **Output**: PNG-encoded buffers embedded into the PDF for lossless fidelity.
- **Parallelization**: All assets and panels are processed concurrently to minimize latency within each job.
- **Template Integration**: Template elements are seamlessly integrated into the processing pipeline with frozen inputs.
- **Job Isolation**: Each job operates on its own input snapshot, ensuring consistent results regardless of concurrent edits.

```mermaid
flowchart TD
A["Frozen Input Snapshot"] --> B{"Traditional Image?"}
B --> |Yes| C["processImageForPanel()<br/>Sharp pipeline"]
C --> D["Target: 300 DPI<br/>Cover fit + center crop"]
D --> E["Optional 180° Rotation"]
E --> F["PNG Encoding"]
B --> |No| G["renderEditorSceneForPanel()<br/>SVG Rendering"]
G --> H["Text Wrapping<br/>Font Estimation"]
H --> I["Element Sorting<br/>by zIndex"]
I --> J["SVG to PNG<br/>Panel Dimensions"]
F --> K["Return Buffer"]
J --> K
K --> L["Embed in PDF"]
```

**Diagram sources**
- [render-job.ts:114-118](file://src/lib/pdf/render-job.ts#L114-L118)
- [image-processor.ts:9-29](file://src/lib/pdf/image-processor.ts#L9-L29)
- [editor-render.ts:290-329](file://src/lib/pdf/editor-render.ts#L290-L329)
- [generate.ts:23-30](file://src/lib/pdf/generate.ts#L23-L30)

**Section sources**
- [render-job.ts:114-118](file://src/lib/pdf/render-job.ts#L114-L118)
- [image-processor.ts:9-29](file://src/lib/pdf/image-processor.ts#L9-L29)
- [editor-render.ts:290-329](file://src/lib/pdf/editor-render.ts#L290-L329)
- [generate.ts:23-30](file://src/lib/pdf/generate.ts#L23-L30)
- [layout.ts:16](file://src/lib/pdf/layout.ts#L16)

### PDF Creation with pdf-lib
Enhanced PDF creation supporting both image and template-based content with job isolation:
- PDF creation: A new PDF document is created and an A4 landscape page is added.
- Embedding: Each processed image (PNG) is embedded into the PDF.
- Positioning: Coordinates are converted from millimeters to points; Y is flipped to match pdf-lib's bottom-left origin.
- Back Cover Branding: Special handling for permanent branding band with color fills and text overlays.
- Template Integration: Template elements contribute to the final PDF through the rendering pipeline with frozen inputs.
- Saving: The PDF is saved to bytes and uploaded to S3 with attempt-scoped prefixes for isolation.
- Job Completion: Successful completion updates submission status and clears job lease.

```mermaid
sequenceDiagram
participant JOB as "Render Job"
participant GEN as "PDF Generator"
participant PDF as "PDFDocument"
participant IMG as "Processed Buffer"
participant S3 as "S3"
JOB->>GEN : "processRenderJob(job)"
GEN->>PDF : "create()"
GEN->>PDF : "addPage([width,height])"
loop For each panel (8 panels)
GEN->>IMG : "embedPng(buffer)"
GEN->>PDF : "drawImage(..., x,y,width,height)"
Note over GEN,PDF : Back Cover Branding
GEN->>PDF : "drawRectangle(band)"
GEN->>PDF : "drawText(brand)"
end
GEN->>PDF : "save()"
PDF-->>GEN : "Uint8Array"
GEN->>S3 : "uploadToS3(key, buffer, 'application/pdf')"
GEN->>JOB : "publishRender(job, artifacts)"
JOB->>S3 : "Clear lease + update status"
```

**Diagram sources**
- [render-job.ts:68-79](file://src/lib/pdf/render-job.ts#L68-L79)
- [generate.ts:16-41](file://src/lib/pdf/generate.ts#L16-L41)

**Section sources**
- [render-job.ts:68-79](file://src/lib/pdf/render-job.ts#L68-L79)
- [generate.ts:16-41](file://src/lib/pdf/generate.ts#L16-L41)

### Database Retrieval and Enhanced Submission Lifecycle
The enhanced lifecycle supports both traditional and template-based workflows with robust job management:
- **Traditional Mode**: Validates exactly 8 unique page labels with order indices 0–7, enqueues render job, background worker processes images, and generates PDF.
- **Template Mode**: Creates empty pages with editor scene metadata, supports template merging, applies text overrides, enqueues render job, and handles template instances.
- **Template Instances**: Each instance tracks templateId and templateVersion for auditability and template versioning.
- **Status Management**: Initial status set to PROCESSING upon job creation, then updates to PENDING upon completion or FAILED after retries exhausted.
- **Template Elements**: Stored in database with pageLabel grouping for efficient retrieval and merging.
- **Regeneration**: Users can regenerate PDFs via the dedicated endpoint regardless of mode with deduplication.
- **Job Deduplication**: Concurrent enqueue requests return the same jobId, preventing duplicate processing.

```mermaid
flowchart TD
Start(["Create Submission"]) --> Mode{"Submission Mode"}
Mode --> |IMAGE| ValidateImages["Validate 8 unique page labels<br/>and orders 0..7"]
Mode --> |EDITOR| CreatePages["Create empty editor pages<br/>with scene metadata"]
ValidateImages --> PersistImages["Persist images in DB"]
CreatePages --> PersistEditor["Persist pages with empty scenes"]
PersistImages --> Enqueue["enqueueInTransaction()<br/>capture snapshot"]
PersistEditor --> Enqueue
Enqueue --> JobCreated["RenderJob created<br/>status = PROCESSING"]
JobCreated --> Worker{"Worker Claims Job"}
Worker --> |Yes| Process["processRenderJob()<br/>load frozen input"]
Worker --> |No| Wait["Wait for due time"]
Process --> Gen["Generate PDF (image or template mode)<br/>and upload to S3"]
Gen --> Success{"Success?"}
Success --> |Yes| Complete["publishRender()<br/>status = PENDING"]
Success --> |No| Retry{"Attempts < max?"}
Retry --> |Yes| Delay["Set nextAttemptAt<br/>status = QUEUED"]
Retry --> |No| Fail["status = FAILED"]
Complete --> End(["Ready for admin review"])
Fail --> End
Delay --> Wait
```

**Diagram sources**
- [render-job.ts:17-33](file://src/lib/pdf/render-job.ts#L17-L33)
- [render-job.ts:81-94](file://src/lib/pdf/render-job.ts#L81-L94)
- [render-job.ts:107-124](file://src/lib/pdf/render-job.ts#L107-L124)
- [route.ts:7-16](file://src/app/api/submissions/[id]/submit/route.ts#L7-L16)

**Section sources**
- [render-job.ts:17-33](file://src/lib/pdf/render-job.ts#L17-L33)
- [render-job.ts:81-94](file://src/lib/pdf/render-job.ts#L81-L94)
- [render-job.ts:107-124](file://src/lib/pdf/render-job.ts#L107-L124)
- [route.ts:7-16](file://src/app/api/submissions/[id]/submit/route.ts#L7-L16)
- [route.ts:57-92](file://src/app/api/submissions/route.ts#L57-L92)
- [route.ts:46-80](file://src/app/api/submissions/from-template/route.ts#L46-L80)
- [generate.ts:36-305](file://src/lib/pdf/generate.ts#L36-L305)

### Quality Settings, Compression, and Print-Ready Specifications
Enhanced quality management for both workflows with job isolation:
- **Traditional Images**:
  - Resize preserves aspect ratio and targets 300 DPI for print quality.
  - Center-cropping ensures pixel-perfect panel coverage.
  - Rotation aligns images according to panel orientation.
- **Template Scenes**:
  - SVG rendering preserves vector quality for scalable elements.
  - Text wrapping uses font estimation for accurate line breaking.
  - Element sorting ensures proper layering.
  - Template elements maintain their original properties while user elements can be customized.
- **PDF Embedding**:
  - Images are embedded as PNG for lossless fidelity.
  - No explicit JPEG compression is applied; PNG ensures print-quality output.
  - Back cover branding uses solid color fills for consistent appearance.
- **Print-ready Canvas**:
  - A4 landscape page size with precise panel coordinates.
  - Target DPI maintained at 300 for professional printing.
- **Template Quality**:
  - Template elements are stored as JSON for consistent rendering.
  - Text overrides preserve template styling while allowing content customization.
- **Job Isolation**:
  - Each job operates on frozen input snapshots, ensuring consistent quality regardless of concurrent edits.
  - Attempt-scoped S3 keys prevent output conflicts between retry attempts.
- **Recommendations**:
  - For smaller file sizes, consider optional JPEG encoding with controlled quality and embedded ICC profiles for color accuracy.
  - Add DPI checks to ensure images meet minimum resolution requirements for print.
  - Implement template caching for frequently used template elements.

**Section sources**
- [render-job.ts:114-118](file://src/lib/pdf/render-job.ts#L114-L118)
- [image-processor.ts:9-29](file://src/lib/pdf/image-processor.ts#L9-L29)
- [editor-render.ts:126-170](file://src/lib/pdf/editor-render.ts#L126-L170)
- [generate.ts:223-277](file://src/lib/pdf/generate.ts#L223-L277)
- [layout.ts:16](file://src/lib/pdf/layout.ts#L16)

### Metadata, Security, and Download Management
Enhanced metadata and security features with job isolation:
- **Metadata**:
  - The current implementation focuses on content generation rather than PDF metadata.
  - Template instances track templateId and templateVersion for auditability.
  - Submission records maintain template association and version information.
  - RenderJob tracks attempts, timestamps, and error messages for debugging.
- **Security**:
  - S3 uploads use presigned URLs with short expiration windows to reduce exposure.
  - S3 downloads use presigned URLs with longer expiration for PDF retrieval.
  - Authentication enforced on all protected endpoints.
  - Template access controlled by approval status and user permissions.
  - Input snapshots capture authorized asset references at enqueue time.
- **Download Management**:
  - Presigned download URLs are generated for PDFs stored under structured paths with attempt prefixes.
  - Template previews and editor scenes handled through secure API endpoints.
  - Template elements are securely stored and retrieved with proper authorization.
  - Job isolation prevents output conflicts between concurrent processing attempts.

**Section sources**
- [render-job.ts:117-118](file://src/lib/pdf/render-job.ts#L117-L118)
- [route.ts:1-38](file://src/app/api/upload/presign/route.ts#L1-L38)
- [route.ts:14-17](file://src/app/api/submissions/from-template/route.ts#L14-L17)
- [s3.ts:18-36](file://src/lib/s3.ts#L18-L36)
- [s3.ts:75-80](file://src/lib/s3.ts#L75-L80)
- [snapshot.ts:43-47](file://src/lib/pdf/snapshot.ts#L43-L47)

### Examples: Template Customization and Layout Modifications
Enhanced customization options for both workflows with job isolation:
- **Template Creation**:
  - Create reusable templates with predefined layouts and elements.
  - Support for text placeholders and customizable content areas.
  - Template approval workflow for quality control.
- **Template Merging**:
  - Automatic merging of template elements with user content.
  - Text override system for dynamic content personalization.
  - Layer separation between template and user elements.
  - Frozen snapshots ensure consistent merging results.
- **Layout Modifications**:
  - Update panel widths, heights, and positions in the layout module.
  - Ensure mm-to-points conversion remains consistent across both workflows.
  - Template elements adapt to different panel configurations.
- **Multi-page Booklets**:
  - Extend the generator to create multiple pages and arrange panels accordingly.
  - Support for complex page arrangements beyond the standard 8-panel layout.
  - Template elements can be reused across different booklet formats.
- **Job Management**:
  - Configure retry delays and maximum attempts for different workloads.
  - Monitor job progress through status endpoints with attempt tracking.
  - Handle graceful worker shutdown with lease expiration recovery.

**Section sources**
- [render-job.ts:14](file://src/lib/pdf/render-job.ts#L14)
- [render-job.ts:81-94](file://src/lib/pdf/render-job.ts#L81-L94)
- [generate.ts:66-103](file://src/lib/pdf/generate.ts#L66-L103)
- [template-types.ts:95-102](file://src/lib/editor/template-types.ts#L95-L102)
- [layout.ts:29-104](file://src/lib/pdf/layout.ts#L29-L104)

## Dependency Analysis
Enhanced external libraries and their roles with job management:
- **pdf-lib**: PDF creation, embedding images, drawing, and saving.
- **sharp**: Image resizing, cropping, rotation, and SVG rendering.
- **AWS SDK**: S3 operations for uploads, downloads, and presigned URLs.
- **Prisma**: Database access for submissions, images, pages, template elements, template instances, and render jobs.
- **Zod**: Validation of submission payloads, editor schemas, and render snapshots.
- **next-auth**: Authentication enforcement on protected endpoints.
- **Template System**: Editor schema validation, template management utilities, and database integration.
- **Node.js Timers**: Sleep functions for worker polling and heartbeat intervals.
- **Crypto**: UUID generation for job claim tokens.

```mermaid
graph LR
WORKER["render-worker.ts"] --> QUEUE["render-job.ts"]
QUEUE --> SNAPSHOT["snapshot.ts"]
QUEUE --> PRISMA["prisma.ts"]
QUEUE --> SUBSTORE["submission-store.ts"]
QUEUE --> GENERATE["generate.ts"]
GENERATE --> PDFLIB["pdf-lib"]
GENERATE --> SHARP["sharp"]
GENERATE --> S3UTIL["s3.ts"]
GENERATE --> LAYOUT["layout.ts"]
GENERATE --> IMGPROC["image-processor.ts"]
GENERATE --> EDITREND["editor-render.ts"]
IMGPROC --> SHARP
EDITREND --> SHARP
TEMPLATES["template-types.ts"] --> GENERATE
SCHEMA["schema.ts"] --> EDITREND
SUBAPI["submissions/route.ts"] --> QUEUE
FROMTEMPLATE["from-template/route.ts"] --> TEMPLATES
PRESIGN["upload/presign/route.ts"] --> S3UTIL
FE["UploadGrid.tsx / ImageUploader.tsx"] --> SUBAPI
```

**Diagram sources**
- [render-worker.ts:1-33](file://src/workers/render-worker.ts#L1-L33)
- [render-job.ts:1-125](file://src/lib/pdf/render-job.ts#L1-L125)
- [snapshot.ts:1-61](file://src/lib/pdf/snapshot.ts#L1-L61)
- [generate.ts:1-43](file://src/lib/pdf/generate.ts#L1-L43)
- [image-processor.ts:1-30](file://src/lib/pdf/image-processor.ts#L1-L30)
- [editor-render.ts:1-329](file://src/lib/pdf/editor-render.ts#L1-L329)
- [layout.ts:1-105](file://src/lib/pdf/layout.ts#L1-L105)
- [route.ts:1-147](file://src/app/api/submissions/route.ts#L1-L147)
- [route.ts:1-100](file://src/app/api/submissions/from-template/route.ts#L1-L100)
- [route.ts:1-38](file://src/app/api/upload/presign/route.ts#L1-L38)
- [s3.ts:1-81](file://src/lib/s3.ts#L1-L81)
- [prisma.ts:1-10](file://src/lib/prisma.ts#L1-L10)
- [template-types.ts:1-103](file://src/lib/editor/template-types.ts#L1-L103)
- [schema.ts:1-116](file://src/lib/editor/schema.ts#L1-L116)
- [package.json:11-24](file://package.json#L11-L24)

**Section sources**
- [render-worker.ts:1-33](file://src/workers/render-worker.ts#L1-L33)
- [render-job.ts:1-125](file://src/lib/pdf/render-job.ts#L1-L125)
- [snapshot.ts:1-61](file://src/lib/pdf/snapshot.ts#L1-L61)
- [generate.ts:1-43](file://src/lib/pdf/generate.ts#L1-L43)
- [image-processor.ts:1-30](file://src/lib/pdf/image-processor.ts#L1-L30)
- [editor-render.ts:1-329](file://src/lib/pdf/editor-render.ts#L1-L329)
- [layout.ts:1-105](file://src/lib/pdf/layout.ts#L1-L105)
- [route.ts:1-147](file://src/app/api/submissions/route.ts#L1-L147)
- [route.ts:1-100](file://src/app/api/submissions/from-template/route.ts#L1-L100)
- [route.ts:1-38](file://src/app/api/upload/presign/route.ts#L1-L38)
- [s3.ts:1-81](file://src/lib/s3.ts#L1-L81)
- [prisma.ts:1-10](file://src/lib/prisma.ts#L1-L10)
- [template-types.ts:1-103](file://src/lib/editor/template-types.ts#L1-L103)
- [schema.ts:1-116](file://src/lib/editor/schema.ts#L1-L116)
- [package.json:11-24](file://package.json#L11-L24)

## Performance Considerations
Enhanced performance optimizations for both workflows with job management:
- **Concurrency**:
  - Parallel downloads and processing of images/assets reduce total generation time.
  - Concurrent template element fetching and scene merging improve scalability.
  - Template elements are cached per submission to avoid repeated database queries.
  - Multiple workers can claim jobs concurrently without duplication using SKIP LOCKED.
- **Memory Management**:
  - Stream S3 downloads and avoid holding multiple large buffers in memory longer than necessary.
  - Dispose of intermediate image buffers promptly after embedding.
  - SVG rendering optimized with efficient string building and minimal DOM operations.
  - Template element parsing and caching reduces memory footprint.
  - Sequential panel processing bounds peak raster memory usage.
- **Scaling**:
  - Offload PDF generation to background workers or serverless functions to avoid blocking API responses.
  - Consider pagination for very large batches and incremental processing.
  - Template caching for frequently used template elements.
  - Database indexing on templateId and pageLabel for fast template element retrieval.
  - Horizontal scaling supported through lease-based job distribution.
- **Caching**:
  - Cache processed images if regeneration frequency is high and inputs are stable.
  - Cache SVG render results for identical scenes to reduce computation.
  - Cache template elements per submission to avoid repeated parsing.
  - Input snapshots eliminate redundant data capture across retries.
- **I/O Optimization**:
  - Use presigned URLs to shift upload/download off the application server.
  - Batch template element queries to minimize database round trips.
  - Efficient asset loading and caching for template images.
  - Attempt-scoped S3 keys prevent output conflicts.
- **Template Efficiency**:
  - Pre-parse template elements once per submission rather than on-demand.
  - Use efficient data structures (Maps) for scene lookups and asset management.
  - Template element ordering preserved for consistent rendering.
  - Frozen snapshots ensure consistent template merging across retries.
- **Job Management**:
  - Exponential backoff reduces database load during retry storms.
  - Lease-based locking prevents duplicate processing across workers.
  - Heartbeat mechanism extends leases for long-running jobs.
  - Graceful worker shutdown allows job recovery through lease expiration.

## Troubleshooting Guide
Enhanced troubleshooting for dual-mode operation with job management:
- **Unauthorized Access**:
  - Ensure authentication is present on all protected endpoints.
  - Verify user permissions for template access and editing.
  - Check template approval status for template-based submissions.
- **Missing Content**:
  - Traditional mode: Generator throws if any panel lacks an associated image.
  - Editor mode: Generator throws if merged scene is missing for any panel.
  - Template mode: Verify template elements exist and are properly ordered.
  - Template instances: Ensure templateId references valid approved templates.
  - Job failures: Check RenderJob errorMessage field for detailed failure reasons.
- **Large Files**:
  - Enforce client-side size limits and server-side validation.
  - Images exceeding the limit are rejected in traditional mode.
  - Monitor SVG complexity in editor mode to prevent excessive memory usage.
  - Template elements should be validated to prevent oversized JSON payloads.
  - Input snapshots capture resource constraints at enqueue time.
- **PDF Generation Failures**:
  - Inspect logs for errors during S3 operations, image processing, or PDF save.
  - Confirm AWS credentials and bucket permissions.
  - Check template parsing errors and scene validation failures.
  - Verify template element JSON integrity and editor schema compliance.
  - Monitor job attempts and retry delays for persistent issues.
- **Template Issues**:
  - Verify template status is APPROVED and accessible.
  - Ensure template elements are properly ordered and formatted.
  - Check text override compatibility with template element types.
  - Validate template element JSON structure and element schemas.
  - Input snapshots freeze template state at enqueue time.
- **Editor Scene Problems**:
  - Validate scene JSON structure and element schemas.
  - Check asset availability and accessibility for image elements.
  - Monitor font rendering and text wrapping calculations.
  - Ensure templateTextOverrides keys match template element IDs.
  - Frozen snapshots prevent race conditions during scene edits.
- **Job Management Issues**:
  - Check RenderJob status transitions: QUEUED → PROCESSING → COMPLETED/FAILED.
  - Verify lease expiration and heartbeat functionality for long-running jobs.
  - Monitor worker health and connection stability.
  - Investigate stuck jobs with expired leases or failed heartbeats.
  - Review retry logic and exponential backoff configuration.

**Section sources**
- [render-job.ts:81-94](file://src/lib/pdf/render-job.ts#L81-L94)
- [render-job.ts:107-124](file://src/lib/pdf/render-job.ts#L107-L124)
- [render-worker.ts:17-32](file://src/workers/render-worker.ts#L17-L32)
- [route.ts:7-16](file://src/app/api/submissions/[id]/submit/route.ts#L7-L16)
- [snapshot.ts:33-36](file://src/lib/pdf/snapshot.ts#L33-L36)
- [schema.prisma:217-239](file://prisma/schema.prisma#L217-L239)

## Conclusion
The enhanced PDF generation engine now provides a comprehensive solution supporting both traditional image-based and advanced template-based workflows with robust, distributed job management. The addition of sophisticated template merging, text override capabilities, SVG rendering, and a durable render job queue significantly expands the system's flexibility and reliability. By leveraging transaction-safe queuing, lease-based locking, heartbeat monitoring, exponential backoff retry logic, and input snapshotting, it scales effectively across multiple workers while maintaining high-quality output suitable for professional printing. The dual-mode architecture allows users to choose between simple image uploads and sophisticated template-based design, making the system adaptable to various use cases and skill levels. The template system enables content reusability, dynamic customization, and professional-quality output generation, while the job management system ensures reliable processing even in distributed environments with automatic recovery from failures and process crashes.

## Appendices

### Appendix A: End-to-End Workflow Summary
Enhanced workflow covering both traditional and template-based modes with job management:
- **Traditional Mode**: Frontend uploads 8 images with drag-and-drop, backend validates and persists entries, enqueues render job in queue, background worker processes images, composes PDF, uploads to S3, and updates submission status.
- **Template Mode**: Frontend creates submissions in EDITOR mode, backend validates and persists empty pages, enqueues render job with frozen input snapshot, background worker merges template elements, applies text overrides, renders SVG scenes, completes PDF generation, and updates submission status.
- **Template Instance Creation**: Users can create instances from approved templates, with automatic merging of template elements and user content, supporting text overrides and customizations with job isolation.
- **Template Management**: Templates are stored with pageLabel grouping, approval workflow, and versioning for auditability with frozen snapshots ensuring consistency.
- **Job Lifecycle**: Submit → Enqueue → Claim → Process → Publish/Fail → Complete, with automatic retry and recovery mechanisms.
- **Worker Coordination**: Multiple workers can safely claim and process jobs concurrently using lease-based locking and heartbeat monitoring.

**Section sources**
- [UploadGrid.tsx:42-76](file://src/components/create/UploadGrid.tsx#L42-L76)
- [render-job.ts:17-33](file://src/lib/pdf/render-job.ts#L17-L33)
- [render-job.ts:36-52](file://src/lib/pdf/render-job.ts#L36-L52)
- [render-job.ts:107-124](file://src/lib/pdf/render-job.ts#L107-L124)
- [render-worker.ts:17-32](file://src/workers/render-worker.ts#L17-L32)
- [route.ts:7-16](file://src/app/api/submissions/[id]/submit/route.ts#L7-L16)
- [route.ts:57-92](file://src/app/api/submissions/route.ts#L57-L92)
- [route.ts:46-80](file://src/app/api/submissions/from-template/route.ts#L46-L80)
- [generate.ts:10-42](file://src/lib/pdf/generate.ts#L10-L42)
- [snapshot.ts:39-60](file://src/lib/pdf/snapshot.ts#L39-L60)