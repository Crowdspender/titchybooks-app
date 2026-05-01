# Component Library

<cite>
**Referenced Files in This Document**
- [Header.tsx](file://src/components/layout/Header.tsx)
- [Providers.tsx](file://src/components/Providers.tsx)
- [layout.tsx](file://src/app/layout.tsx)
- [page.tsx](file://src/app/page.tsx)
- [LoginForm.tsx](file://src/components/auth/LoginForm.tsx)
- [RegisterForm.tsx](file://src/components/auth/RegisterForm.tsx)
- [ImageUploader.tsx](file://src/components/create/ImageUploader.tsx)
- [UploadGrid.tsx](file://src/components/create/UploadGrid.tsx)
- [SubmissionList.tsx](file://src/components/submissions/SubmissionList.tsx)
- [StatusBadge.tsx](file://src/components/submissions/StatusBadge.tsx)
- [AdminDashboard.tsx](file://src/components/admin/AdminDashboard.tsx)
- [constants.ts](file://src/lib/constants.ts)
- [package.json](file://package.json)
</cite>

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
This document describes the React component library used in Titchybook Creator. It focuses on layout components (header navigation, provider wrappers, and page structure), authentication components (login and registration forms, plus authentication state management), upload components (image uploader, upload grid, and validation displays), submission management components (listing, status display, and administrative controls), and UI component documentation with props, events, styling options, and customization guidelines. It also provides usage examples, integration patterns, accessibility considerations, component composition, reusability, performance optimization, testing strategies, and development guidelines.

## Project Structure
The application is a Next.js app with a clear separation of concerns:
- App shell and providers are wired in the root layout.
- Layout components provide global navigation and session-aware UI.
- Feature-specific components live under dedicated folders (auth, create, submissions, admin).
- Shared constants and types are centralized for reuse across components.

```mermaid
graph TB
subgraph "App Shell"
L["RootLayout<br/>(layout.tsx)"]
P["Providers<br/>(Providers.tsx)"]
H["Header<br/>(Header.tsx)"]
end
subgraph "Pages"
HP["Home Page<br/>(page.tsx)"]
LP["Login Page<br/>(.../auth/login/page.tsx)"]
RP["Register Page<br/>(.../auth/register/page.tsx)"]
CP["Create Page<br/>(.../(protected)/create/page.tsx)"]
DP["Dashboard Page<br/>(.../(protected)/dashboard/page.tsx)"]
AP["Admin Page<br/>(.../(admin)/admin/page.tsx)"]
end
subgraph "Components"
AU["Auth Forms<br/>(LoginForm, RegisterForm)"]
IU["Upload Grid<br/>(UploadGrid)"]
IU2["Image Uploader<br/>(ImageUploader)"]
SL["Submission List<br/>(SubmissionList)"]
SB["Status Badge<br/>(StatusBadge)"]
AD["Admin Dashboard<br/>(AdminDashboard)"]
end
L --> P --> H
L --> HP
L --> LP
L --> RP
L --> CP
L --> DP
L --> AP
CP --> IU
IU --> IU2
DP --> SL
SL --> SB
AP --> AD
```

**Diagram sources**
- [layout.tsx:23-41](file://src/app/layout.tsx#L23-L41)
- [Providers.tsx:5-7](file://src/components/Providers.tsx#L5-L7)
- [Header.tsx:6-68](file://src/components/layout/Header.tsx#L6-L68)
- [UploadGrid.tsx:16-114](file://src/components/create/UploadGrid.tsx#L16-L114)
- [ImageUploader.tsx:12-147](file://src/components/create/ImageUploader.tsx#L12-L147)
- [SubmissionList.tsx:15-118](file://src/components/submissions/SubmissionList.tsx#L15-L118)
- [StatusBadge.tsx:1-17](file://src/components/submissions/StatusBadge.tsx#L1-L17)
- [AdminDashboard.tsx:21-167](file://src/components/admin/AdminDashboard.tsx#L21-L167)

**Section sources**
- [layout.tsx:23-41](file://src/app/layout.tsx#L23-L41)
- [page.tsx:3-60](file://src/app/page.tsx#L3-L60)

## Core Components
This section documents the foundational building blocks of the UI.

- Providers
  - Purpose: Wraps the app with NextAuth’s session provider to enable session-aware components.
  - Props: children (ReactNode).
  - Behavior: Passes down session context to descendant components.
  - Accessibility: None by itself; ensures downstream components can read/use session state.
  - Customization: Wrap the app with this provider at the root.

- Header
  - Purpose: Renders the global navigation bar with branding, links, and session-dependent actions.
  - Behavior: Shows “Dashboard”, “New Book”, “Admin” (when role is ADMIN), user email, and “Sign out” when logged in; otherwise shows “Sign in” and “Register”.
  - Accessibility: Uses semantic links and buttons; ensure keyboard navigation and screen reader compatibility via standard anchor/button semantics.
  - Customization: Adjust routes, roles, and styling classes to match brand guidelines.

- Root Layout
  - Purpose: Sets up fonts, providers, header, main content area, and toast notifications.
  - Behavior: Renders the Providers wrapper, Header, and children within a main container; integrates Sonner for toast notifications.
  - Accessibility: Ensures consistent typography and focus management; keep header landmarks and skip links if needed.

**Section sources**
- [Providers.tsx:5-7](file://src/components/Providers.tsx#L5-L7)
- [Header.tsx:6-68](file://src/components/layout/Header.tsx#L6-L68)
- [layout.tsx:23-41](file://src/app/layout.tsx#L23-L41)

## Architecture Overview
The component architecture follows a layered pattern:
- App shell (layout.tsx) composes Providers and Header.
- Feature pages render feature components.
- Authentication state is managed by NextAuth and exposed via hooks.
- Upload components coordinate with serverless APIs to obtain pre-signed URLs and upload images directly to S3.
- Submission components fetch and display user submissions; admin components manage submissions.

```mermaid
sequenceDiagram
participant U as "User"
participant H as "Header"
participant LG as "LoginForm"
participant RG as "RegisterForm"
participant IG as "ImageUploader"
participant GG as "UploadGrid"
participant SL as "SubmissionList"
participant SB as "StatusBadge"
participant AD as "AdminDashboard"
U->>H : Navigate to Login/Register/Dashboard/Create/Admin
U->>LG : Submit credentials
LG-->>U : Redirect to Dashboard or show error
U->>RG : Submit registration
RG-->>U : Redirect to Login with success indicator
U->>GG : Open Create page
GG->>IG : Render 8 upload slots
IG->>IG : Validate file type/size
IG->>IG : Fetch pre-signed URL
IG->>IG : PUT to S3
IG-->>GG : onUploaded callback
GG-->>SL : On successful submission, navigate to Dashboard
SL-->>SB : Render status badges
U->>AD : Admin reviews pending submissions
AD-->>U : Approve/Reject with feedback
```

**Diagram sources**
- [Header.tsx:6-68](file://src/components/layout/Header.tsx#L6-L68)
- [LoginForm.tsx:7-85](file://src/components/auth/LoginForm.tsx#L7-L85)
- [RegisterForm.tsx:6-106](file://src/components/auth/RegisterForm.tsx#L6-L106)
- [ImageUploader.tsx:12-147](file://src/components/create/ImageUploader.tsx#L12-L147)
- [UploadGrid.tsx:16-114](file://src/components/create/UploadGrid.tsx#L16-L114)
- [SubmissionList.tsx:15-118](file://src/components/submissions/SubmissionList.tsx#L15-L118)
- [StatusBadge.tsx:1-17](file://src/components/submissions/StatusBadge.tsx#L1-L17)
- [AdminDashboard.tsx:21-167](file://src/components/admin/AdminDashboard.tsx#L21-L167)

## Detailed Component Analysis

### Authentication Components

#### LoginForm
- Purpose: Handles user login with credential-based authentication.
- Props: None.
- Events: Form submit triggers authentication.
- State:
  - Local form state: email, password.
  - Error and loading flags.
- Behavior:
  - Prevents default form submission.
  - Calls NextAuth signIn with credentials provider.
  - On success, redirects to dashboard; on failure, sets error message.
- Accessibility:
  - Proper labels and inputs.
  - Disabled button during loading.
- Styling and customization:
  - Tailwind utility classes applied; customize via className prop overrides.
- Integration patterns:
  - Place inside a page or modal; ensure Providers wrap the app.
- Testing strategies:
  - Unit test form rendering and state updates.
  - Mock NextAuth signIn and assert navigation/error behavior.

**Section sources**
- [LoginForm.tsx:7-85](file://src/components/auth/LoginForm.tsx#L7-L85)

#### RegisterForm
- Purpose: Registers new users by posting to the registration API.
- Props: None.
- Events: Form submit triggers registration.
- State:
  - Local form state: name, email, password.
  - Error and loading flags.
- Behavior:
  - Submits JSON payload to /api/register.
  - On success, navigates to login with a success indicator.
  - On error, displays user-friendly messages.
- Accessibility:
  - Required fields and minimum length enforced.
- Styling and customization:
  - Tailwind utility classes; adjust spacing and colors via className.
- Integration patterns:
  - Use within a registration page; ensure Providers present.
- Testing strategies:
  - Unit test form rendering and state updates.
  - Mock fetch response and assert navigation and error handling.

**Section sources**
- [RegisterForm.tsx:6-106](file://src/components/auth/RegisterForm.tsx#L6-L106)

### Upload Components

#### ImageUploader
- Purpose: Provides a single upload slot for a labeled page with drag-and-drop and preview.
- Props:
  - pageLabel: Page label type (from constants).
  - submissionId: Unique identifier for the submission.
  - onUploaded: Callback receiving pageLabel, S3 key, and original file.
- Events:
  - Drag-and-drop handlers.
  - Input change handler.
- State:
  - Preview URL, uploading flag, error message, drag-over state.
- Validation:
  - Accepts JPEG, PNG, WebP.
  - Enforces 10 MB limit.
- Behavior:
  - Generates preview via FileReader.
  - Requests a pre-signed URL from /api/upload/presign.
  - Uploads file directly to S3 via PUT.
  - Invokes onUploaded on success; sets error on failure.
- Accessibility:
  - Hidden input paired with visible drop zone; ensure focus styles and ARIA if extending.
- Styling and customization:
  - Tailwind classes define appearance; override via className.
- Integration patterns:
  - Render multiple instances per page label in UploadGrid.
- Performance considerations:
  - Avoid unnecessary renders by memoizing callbacks.
  - Debounce drag-over state if needed.
- Testing strategies:
  - Unit test validation, preview generation, and upload flow.
  - Mock fetch for pre-signed URL and S3 upload.

**Section sources**
- [ImageUploader.tsx:6-147](file://src/components/create/ImageUploader.tsx#L6-L147)
- [constants.ts:18-48](file://src/lib/constants.ts#L18-L48)

#### UploadGrid
- Purpose: Orchestrates 8 ImageUploader instances, tracks uploads, and submits the batch.
- Props: None.
- State:
  - Map of uploaded images keyed by page label.
  - Submitting flag.
- Behavior:
  - Generates a unique submissionId.
  - Collects uploaded images and posts to /api/submissions.
  - Navigates to dashboard on success; shows toasts for success/failure.
- Accessibility:
  - Clear status indicators and button states.
- Styling and customization:
  - Grid layout and button styles; adjust spacing and colors.
- Integration patterns:
  - Render on the create page; wire with ImageUploader instances.
- Performance considerations:
  - Memoize handleUploaded to prevent re-renders.
  - Debounce submission until all 8 uploads are present.
- Testing strategies:
  - Unit test upload collection and submission flow.
  - Mock fetch for submission endpoint.

**Section sources**
- [UploadGrid.tsx:16-114](file://src/components/create/UploadGrid.tsx#L16-L114)

### Submission Management Components

#### SubmissionList
- Purpose: Lists user submissions with status, creation date, and actions.
- Props: None.
- State:
  - Submissions array and loading flag.
- Behavior:
  - Fetches submissions from /api/submissions.
  - Renders cards with StatusBadge and action buttons (download, re-upload).
  - Shows empty state and loading skeletons.
- Accessibility:
  - Semantic list and buttons; ensure keyboard navigation.
- Styling and customization:
  - Card layout and badge styles; adjust colors and spacing.
- Integration patterns:
  - Render on the dashboard page.
- Performance considerations:
  - Skeleton loaders reduce perceived latency.
- Testing strategies:
  - Unit test rendering and action handlers.
  - Mock fetch for submissions endpoint.

**Section sources**
- [SubmissionList.tsx:15-118](file://src/components/submissions/SubmissionList.tsx#L15-L118)

#### StatusBadge
- Purpose: Visual indicator for submission status.
- Props:
  - status: Submission status string.
- Behavior:
  - Applies color classes based on status (PENDING, APPROVED, REJECTED).
- Accessibility:
  - Minimal; ensure sufficient color contrast.
- Styling and customization:
  - Override classes via className prop.
- Integration patterns:
  - Used within SubmissionList and AdminDashboard.

**Section sources**
- [StatusBadge.tsx:1-17](file://src/components/submissions/StatusBadge.tsx#L1-L17)

#### AdminDashboard
- Purpose: Allows administrators to review and approve/reject submissions.
- Props: None.
- State:
  - Submissions array, loading flag, filter, refresh key.
- Behavior:
  - Filters submissions by status.
  - Approves or rejects with optional rejection reason.
  - Refreshes list after actions.
- Accessibility:
  - Buttons and table structure; ensure keyboard navigation.
- Styling and customization:
  - Table and button styles; adjust colors and spacing.
- Integration patterns:
  - Render on the admin page.
- Performance considerations:
  - Cancelable fetch in effect to avoid state updates after unmount.
- Testing strategies:
  - Unit test filtering, approval/rejection actions, and toast feedback.

**Section sources**
- [AdminDashboard.tsx:21-167](file://src/components/admin/AdminDashboard.tsx#L21-L167)

### UI Component Documentation

#### Header
- Props: None.
- Accessibility: Links and buttons are keyboard accessible; ensure focus outlines.
- Styling: Tailwind classes; customize via className.
- Composition: Intended to be rendered at the top of the app shell.

**Section sources**
- [Header.tsx:6-68](file://src/components/layout/Header.tsx#L6-L68)

#### Providers
- Props: children.
- Accessibility: None; ensures session availability.
- Styling: None.

**Section sources**
- [Providers.tsx:5-7](file://src/components/Providers.tsx#L5-L7)

#### Root Layout
- Props: children.
- Accessibility: Consistent typography and landmark structure.
- Styling: Font variables and base styles.

**Section sources**
- [layout.tsx:23-41](file://src/app/layout.tsx#L23-L41)

### Usage Examples and Integration Patterns
- Authentication:
  - Wrap the app with Providers at the root.
  - Use LoginForm and RegisterForm on their respective pages.
  - Use Header for navigation and session-aware actions.
- Upload:
  - Render UploadGrid on the create page.
  - Compose multiple ImageUploader instances per page label.
- Submissions:
  - Render SubmissionList on the dashboard.
  - Use StatusBadge for status indicators.
- Admin:
  - Render AdminDashboard for reviewing submissions.

### Accessibility Considerations
- Ensure labels are associated with inputs.
- Provide keyboard navigation for interactive elements.
- Maintain sufficient color contrast for status badges.
- Use semantic HTML (buttons, links, tables).
- Add ARIA attributes if extending components (e.g., aria-describedby for validation messages).

### Component Composition and Reusability
- Centralize shared constants (page labels, statuses) for type-safe composition.
- Keep components small and focused; pass data and callbacks via props.
- Encapsulate side effects (fetch, uploads) in components to improve testability.

### Performance Optimization
- Memoize callbacks passed to child components to avoid unnecessary re-renders.
- Use skeleton loaders for lists to improve perceived performance.
- Defer heavy computations off the main thread when possible.
- Minimize reflows by batching DOM updates.

## Dependency Analysis
External libraries and their roles:
- next-auth: Authentication state and session management.
- sonner: Toast notifications for user feedback.
- @aws-sdk: S3 operations (client and presigner) for uploads.
- @prisma/client: Database client.
- pdf-lib: PDF generation pipeline (referenced in package.json).
- sharp: Image processing pipeline (referenced in package.json).

```mermaid
graph LR
subgraph "UI Layer"
H["Header"]
LGF["LoginForm"]
RGF["RegisterForm"]
IG["ImageUploader"]
GG["UploadGrid"]
SL["SubmissionList"]
SB["StatusBadge"]
AD["AdminDashboard"]
end
subgraph "Libraries"
NA["next-auth"]
SN["sonner"]
AWS["@aws-sdk/*"]
PRIS["@prisma/client"]
PDF["pdf-lib"]
SH["sharp"]
end
H --> NA
LGF --> NA
RGF --> PRIS
IG --> AWS
GG --> IG
SL --> SB
AD --> SB
GG --> PRIS
SL --> PRIS
AD --> PRIS
IG --> PDF
IG --> SH
H --> SN
LGF --> SN
RGF --> SN
GG --> SN
SL --> SN
AD --> SN
```

**Diagram sources**
- [package.json:11-25](file://package.json#L11-L25)
- [Header.tsx:3](file://src/components/layout/Header.tsx#L3)
- [LoginForm.tsx:3](file://src/components/auth/LoginForm.tsx#L3)
- [ImageUploader.tsx:3](file://src/components/create/ImageUploader.tsx#L3)
- [UploadGrid.tsx:4](file://src/components/create/UploadGrid.tsx#L4)
- [SubmissionList.tsx:3](file://src/components/submissions/SubmissionList.tsx#L3)
- [AdminDashboard.tsx:3](file://src/components/admin/AdminDashboard.tsx#L3)

**Section sources**
- [package.json:11-25](file://package.json#L11-L25)

## Performance Considerations
- Prefer server-side rendering for static content; keep interactive components client-side.
- Use memoization for expensive callbacks and derived data.
- Lazy-load heavy assets or components when appropriate.
- Optimize network requests: batch submissions, cache pre-signed URLs, and abort on unmount.
- Minimize layout thrashing by avoiding synchronous reads of computed styles.

## Troubleshooting Guide
- Authentication failures:
  - LoginForm displays a generic invalid credentials message; ensure credentials provider is configured and backend validates inputs.
- Registration errors:
  - RegisterForm shows user-friendly messages; verify /api/register endpoint and database constraints.
- Upload issues:
  - ImageUploader validates file type and size; confirm pre-signed URL endpoint and S3 permissions.
  - If uploads fail, check network tab and console logs for fetch errors.
- Submission list not updating:
  - AdminDashboard uses a refresh key to refetch; ensure PATCH actions update state and that the API responds correctly.
- Toast feedback:
  - Sonner is globally configured; verify toasts appear on success/failure paths.

**Section sources**
- [LoginForm.tsx:14-33](file://src/components/auth/LoginForm.tsx#L14-L33)
- [RegisterForm.tsx:14-39](file://src/components/auth/RegisterForm.tsx#L14-L39)
- [ImageUploader.tsx:22-73](file://src/components/create/ImageUploader.tsx#L22-L73)
- [UploadGrid.tsx:42-76](file://src/components/create/UploadGrid.tsx#L42-L76)
- [AdminDashboard.tsx:43-62](file://src/components/admin/AdminDashboard.tsx#L43-L62)

## Conclusion
The component library is structured around a clean separation of concerns: layout and providers at the root, feature components for authentication, uploads, submissions, and administration, and shared constants for type safety. Components are designed to be reusable, accessible, and testable, with clear integration patterns and performance-conscious behavior. Extending the library involves adding new components that follow these patterns and leveraging existing providers and utilities.

## Appendices

### Props Reference Summary
- Header: none.
- Providers: children.
- LoginForm: none.
- RegisterForm: none.
- ImageUploader:
  - pageLabel: PageLabel
  - submissionId: string
  - onUploaded: (pageLabel, s3Key, file) => void
- UploadGrid: none.
- SubmissionList: none.
- StatusBadge: status: string.
- AdminDashboard: none.

### Constants Reference
- SubmissionStatus enum and VALID_STATUSES.
- PAGE_LABELS and PAGE_LABEL_DISPLAY.
- ACCEPTED_IMAGE_TYPES and MAX_FILE_SIZE.

**Section sources**
- [constants.ts:6-48](file://src/lib/constants.ts#L6-L48)