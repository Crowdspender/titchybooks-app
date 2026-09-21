# Design System & UI Components

<cite>
**Referenced Files in This Document**
- [globals.css](file://src/app/globals.css)
- [ErrorDisplay.tsx](file://src/components/ui/ErrorDisplay.tsx)
- [LoadingSkeleton.tsx](file://src/components/ui/LoadingSkeleton.tsx)
- [Header.tsx](file://src/components/layout/Header.tsx)
- [Providers.tsx](file://src/components/Providers.tsx)
- [EditorCanvas.tsx](file://src/components/editor/EditorCanvas.tsx)
- [PropertiesPanel.tsx](file://src/components/editor/PropertiesPanel.tsx)
- [LayerPanel.tsx](file://src/components/editor/LayerPanel.tsx)
- [ColorPicker.tsx](file://src/components/editor/ColorPicker.tsx)
- [StatusBadge.tsx](file://src/components/submissions/StatusBadge.tsx)
- [Hero.tsx](file://src/components/home/Hero.tsx)
- [LoginForm.tsx](file://src/components/auth/LoginForm.tsx)
- [ImageUploader.tsx](file://src/components/create/ImageUploader.tsx)
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

## Introduction
This document describes the design system and UI components used across the application. It explains how tokens, shared styles, and reusable components form a consistent visual language and interaction model for pages, forms, editor surfaces, and feedback elements. The goal is to help developers and designers extend or adapt the UI while preserving consistency, accessibility, and performance.

## Project Structure
The design system is centered around:
- Global CSS tokens and base styles that define colors, typography, spacing, shadows, radii, transitions, and component primitives (buttons, cards, inputs, badges).
- Reusable UI primitives under src/components/ui for error states and loading skeletons.
- Layout and navigation via Header.
- Feature-specific panels and controls in src/components/editor, src/components/auth, src/components/home, and src/components/create.
- A minimal Providers wrapper to supply session context globally.

```mermaid
graph TB
subgraph "Design Tokens"
G["globals.css"]
end
subgraph "UI Primitives"
E["ErrorDisplay.tsx"]
S["LoadingSkeleton.tsx"]
end
subgraph "Layout"
H["Header.tsx"]
P["Providers.tsx"]
end
subgraph "Editor"
C["EditorCanvas.tsx"]
PP["PropertiesPanel.tsx"]
LP["LayerPanel.tsx"]
CP["ColorPicker.tsx"]
end
subgraph "Feature Pages"
HB["Hero.tsx"]
LF["LoginForm.tsx"]
IU["ImageUploader.tsx"]
SB["StatusBadge.tsx"]
end
G --> E
G --> S
G --> H
G --> C
G --> PP
G --> LP
G --> CP
G --> HB
G --> LF
G --> IU
G --> SB
P --> H
```

**Diagram sources**
- [globals.css:1-92](file://src/app/globals.css#L1-L92)
- [ErrorDisplay.tsx:1-56](file://src/components/ui/ErrorDisplay.tsx#L1-L56)
- [LoadingSkeleton.tsx:1-112](file://src/components/ui/LoadingSkeleton.tsx#L1-L112)
- [Header.tsx:1-296](file://src/components/layout/Header.tsx#L1-L296)
- [Providers.tsx:1-8](file://src/components/Providers.tsx#L1-L8)
- [EditorCanvas.tsx:1-800](file://src/components/editor/EditorCanvas.tsx#L1-L800)
- [PropertiesPanel.tsx:1-736](file://src/components/editor/PropertiesPanel.tsx#L1-L736)
- [LayerPanel.tsx:1-270](file://src/components/editor/LayerPanel.tsx#L1-L270)
- [ColorPicker.tsx:1-263](file://src/components/editor/ColorPicker.tsx#L1-L263)
- [Hero.tsx:1-84](file://src/components/home/Hero.tsx#L1-L84)
- [LoginForm.tsx:1-119](file://src/components/auth/LoginForm.tsx#L1-L119)
- [ImageUploader.tsx:1-184](file://src/components/create/ImageUploader.tsx#L1-L184)
- [StatusBadge.tsx:1-17](file://src/components/submissions/StatusBadge.tsx#L1-L17)

**Section sources**
- [globals.css:1-92](file://src/app/globals.css#L1-L92)
- [Header.tsx:1-296](file://src/components/layout/Header.tsx#L1-L296)
- [Providers.tsx:1-8](file://src/components/Providers.tsx#L1-L8)

## Core Components
- Design tokens and theme bridge: Centralized CSS variables for palette, surfaces, text, borders, semantic colors, shadows, typography, radius, and transitions. These are bridged into Tailwind’s theme so utilities can consume them consistently.
- Button system: Primary, secondary, outline, ghost, danger, success, with size variants and disabled states.
- Card system: Elevated surface with border, radius, shadow, and hover elevation.
- Input system: Consistent input styling with focus ring and label conventions.
- Badge system: Semantic status badges for draft, pending, approved, rejected, processing.
- Layout helpers: Page container, section labels, dividers.
- Toast overrides: Styled to match the warm editorial theme.

These primitives are consumed by feature components such as forms, editor panels, and page sections to ensure visual and behavioral consistency.

**Section sources**
- [globals.css:94-393](file://src/app/globals.css#L94-L393)

## Architecture Overview
The UI architecture layers are:
- Token layer: CSS variables define the brand and semantics.
- Primitive layer: Base classes for buttons, cards, inputs, badges, and layout helpers.
- Composition layer: Feature components compose primitives to build pages and complex interfaces.
- Context layer: Providers wrap the app to supply global state (e.g., NextAuth session).

```mermaid
graph LR
T["Tokens<br/>globals.css"] --> B["Primitives<br/>.btn, .card, .input, .badge"]
B --> F["Feature Components<br/>Forms, Editor Panels, Pages"]
F --> UX["User Experience<br/>Consistency, Accessibility"]
Ctx["Context<br/>Providers.tsx"] --> F
```

**Diagram sources**
- [globals.css:1-92](file://src/app/globals.css#L1-L92)
- [globals.css:136-393](file://src/app/globals.css#L136-L393)
- [Providers.tsx:1-8](file://src/components/Providers.tsx#L1-L8)

## Detailed Component Analysis

### Error Display
A client-side error view that uses design tokens for icon background, text color, and button styling. It provides a clear message and a “Try again” action wired to a reset callback.

```mermaid
flowchart TD
Start(["Render ErrorDisplay"]) --> ShowIcon["Show error icon with token-based background"]
ShowIcon --> ShowMessage["Render heading and descriptive message"]
ShowMessage --> Action{"User clicks 'Try again'?"}
Action --> |Yes| Reset["Invoke reset()"]
Action --> |No| End(["Idle"])
Reset --> End
```

**Diagram sources**
- [ErrorDisplay.tsx:1-56](file://src/components/ui/ErrorDisplay.tsx#L1-L56)

**Section sources**
- [ErrorDisplay.tsx:1-56](file://src/components/ui/ErrorDisplay.tsx#L1-L56)

### Loading Skeletons
Reusable skeleton primitives for placeholder content during data loading. They use the pulse animation and token-driven backgrounds/borders. Variants include block, page header, card, list, grid, and detail card.

```mermaid
classDiagram
class SkeletonBlock {
+className
+style
}
class SkeletonPageHeader {
+subtitle
}
class SkeletonCard {
+lines
+className
}
class SkeletonList {
+count
}
class SkeletonGrid {
+count
+cols
}
class SkeletonDetailCard {
+rows
+className
}
SkeletonPageHeader --> SkeletonBlock : "uses"
SkeletonCard --> SkeletonBlock : "uses"
SkeletonList --> SkeletonCard : "uses"
SkeletonGrid --> SkeletonCard : "uses"
SkeletonDetailCard --> SkeletonBlock : "uses"
```

**Diagram sources**
- [LoadingSkeleton.tsx:1-112](file://src/components/ui/LoadingSkeleton.tsx#L1-L112)

**Section sources**
- [LoadingSkeleton.tsx:1-112](file://src/components/ui/LoadingSkeleton.tsx#L1-L112)

### Header and Navigation
Sticky header with responsive navigation, role-aware menu items, and sign-in/sign-out flows. Uses tokens for backdrop blur, borders, and interactive states. Includes mobile drawer toggling.

```mermaid
sequenceDiagram
participant U as "User"
participant H as "Header.tsx"
participant N as "NextAuth Session"
U->>H : Open site
H->>N : Read session
alt Logged in
H-->>U : Show Dashboard, New Book, Vault, Admin links
U->>H : Click Sign out
H->>N : signOut()
N-->>H : Redirect to "/"
else Not logged in
H-->>U : Show Sign in, Vault, Get started
end
```

**Diagram sources**
- [Header.tsx:1-296](file://src/components/layout/Header.tsx#L1-L296)
- [Providers.tsx:1-8](file://src/components/Providers.tsx#L1-L8)

**Section sources**
- [Header.tsx:1-296](file://src/components/layout/Header.tsx#L1-L296)
- [Providers.tsx:1-8](file://src/components/Providers.tsx#L1-L8)

### Editor Canvas
A Konva-based canvas rendering images, text, and shapes with selection, dragging, resizing, rotation, cropping overlays, and template mode constraints. It coordinates element interactions and updates scene state.

```mermaid
sequenceDiagram
participant U as "User"
participant EC as "EditorCanvas.tsx"
participant K as "Konva Stage"
participant PS as "PropertiesPanel.tsx"
U->>EC : Select element
EC->>K : Attach Transformer
U->>EC : Drag/Resize/Rotate
EC->>EC : Compute new bounds
EC->>PS : Update selected element props
PS-->>EC : onChangeElement(updater)
EC->>EC : Apply changes to scene
```

**Diagram sources**
- [EditorCanvas.tsx:1-800](file://src/components/editor/EditorCanvas.tsx#L1-L800)
- [PropertiesPanel.tsx:1-736](file://src/components/editor/PropertiesPanel.tsx#L1-L736)

**Section sources**
- [EditorCanvas.tsx:1-800](file://src/components/editor/EditorCanvas.tsx#L1-L800)

### Properties Panel
Controls for editing element properties including position, size, rotation, opacity, visibility, lock state, layer order, and type-specific options (text content, font size/color; shape fill/stroke; image crop/DPI indicator). Supports instance mode where template elements are locked except editable text.

```mermaid
flowchart TD
Sel["Selected Element"] --> Type{"Element Type"}
Type --> |Text| TextProps["Edit text, font size, color"]
Type --> |Shape| ShapeProps["Fill, stroke, width"]
Type --> |Image| ImageProps["Crop zoom/focus, DPI indicator"]
TextProps --> Actions["Visibility/Lock, Duplicate, Layer Order, Delete"]
ShapeProps --> Actions
ImageProps --> Actions
Actions --> Update["onChangeElement(updater)"]
```

**Diagram sources**
- [PropertiesPanel.tsx:1-736](file://src/components/editor/PropertiesPanel.tsx#L1-L736)

**Section sources**
- [PropertiesPanel.tsx:1-736](file://src/components/editor/PropertiesPanel.tsx#L1-L736)

### Layer Panel
Displays ordered user and template elements with selection highlighting, visibility/lock toggles, duplication, and deletion. In instance mode, separates template vs user layers and indicates editable text capability.

```mermaid
flowchart TD
Start(["Render Layers"]) --> Sort["Sort by zIndex"]
Sort --> Sections{"Instance Mode?"}
Sections --> |Yes| TemplateSec["Template Elements Section"]
Sections --> |No| UserSec["User Elements Only"]
TemplateSec --> UserSec
UserSec --> Interact{"User Interaction"}
Interact --> |Select| Highlight["Highlight selected"]
Interact --> |Toggle| State["Update visibility/lock"]
Interact --> |Actions| Ops["Duplicate/Delete"]
Highlight --> End(["Done"])
State --> End
Ops --> End
```

**Diagram sources**
- [LayerPanel.tsx:1-270](file://src/components/editor/LayerPanel.tsx#L1-L270)

**Section sources**
- [LayerPanel.tsx:1-270](file://src/components/editor/LayerPanel.tsx#L1-L270)

### Color Picker
Inline color picker with preset swatches, hex input validation, native color input, and optional transparent option. Normalizes color values and closes on outside click.

```mermaid
flowchart TD
Open["Open Picker"] --> Choose{"Choose Color"}
Choose --> |Preset| SetPreset["Set preset color"]
Choose --> |Hex Input| Validate["Validate hex format"]
Validate --> |Valid| Apply["Apply normalized color"]
Validate --> |Invalid| Revert["Revert to previous value"]
Choose --> |Native Picker| Apply
Apply --> Close["Close picker"]
Revert --> Close
```

**Diagram sources**
- [ColorPicker.tsx:1-263](file://src/components/editor/ColorPicker.tsx#L1-L263)

**Section sources**
- [ColorPicker.tsx:1-263](file://src/components/editor/ColorPicker.tsx#L1-L263)

### Status Badge
Renders a semantic badge based on submission status using predefined style classes from the design system.

```mermaid
flowchart TD
S["Status String"] --> Map["Map to badge class"]
Map --> Render["Render span with class and label"]
```

**Diagram sources**
- [StatusBadge.tsx:1-17](file://src/components/submissions/StatusBadge.tsx#L1-L17)

**Section sources**
- [StatusBadge.tsx:1-17](file://src/components/submissions/StatusBadge.tsx#L1-L17)

### Hero Section
Marketing hero using tokens for typography, colors, and spacing. Demonstrates composition of buttons and imagery within the design system.

**Section sources**
- [Hero.tsx:1-84](file://src/components/home/Hero.tsx#L1-L84)

### Login Form
Uses the input and button primitives, integrates toast notifications, and handles authentication flow with NextAuth.

**Section sources**
- [LoginForm.tsx:1-119](file://src/components/auth/LoginForm.tsx#L1-L119)

### Image Uploader
Drag-and-drop image upload with preview, file validation, presigned URL workflow, and toast feedback. Uses tokens for visual states (drag over, success, errors).

**Section sources**
- [ImageUploader.tsx:1-184](file://src/components/create/ImageUploader.tsx#L1-L184)

## Dependency Analysis
- All components rely on global tokens defined in globals.css for consistent appearance.
- Editor components depend on Konva primitives and internal editor utilities for geometry and validation.
- Header depends on NextAuth session context provided by Providers.
- Forms and uploads integrate with toast notifications and routing.

```mermaid
graph LR
G["globals.css"] --> All["All Components"]
PA["Providers.tsx"] --> H["Header.tsx"]
EC["EditorCanvas.tsx"] --> PP["PropertiesPanel.tsx"]
EC --> LP["LayerPanel.tsx"]
PP --> CP["ColorPicker.tsx"]
```

**Diagram sources**
- [globals.css:1-92](file://src/app/globals.css#L1-L92)
- [Providers.tsx:1-8](file://src/components/Providers.tsx#L1-L8)
- [EditorCanvas.tsx:1-800](file://src/components/editor/EditorCanvas.tsx#L1-L800)
- [PropertiesPanel.tsx:1-736](file://src/components/editor/PropertiesPanel.tsx#L1-L736)
- [LayerPanel.tsx:1-270](file://src/components/editor/LayerPanel.tsx#L1-L270)
- [ColorPicker.tsx:1-263](file://src/components/editor/ColorPicker.tsx#L1-L263)

**Section sources**
- [globals.css:1-92](file://src/app/globals.css#L1-L92)
- [Providers.tsx:1-8](file://src/components/Providers.tsx#L1-L8)
- [EditorCanvas.tsx:1-800](file://src/components/editor/EditorCanvas.tsx#L1-L800)
- [PropertiesPanel.tsx:1-736](file://src/components/editor/PropertiesPanel.tsx#L1-L736)
- [LayerPanel.tsx:1-270](file://src/components/editor/LayerPanel.tsx#L1-L270)
- [ColorPicker.tsx:1-263](file://src/components/editor/ColorPicker.tsx#L1-L263)

## Performance Considerations
- Use skeleton placeholders to reduce perceived load time during data fetching.
- Keep canvas interactions efficient by updating only necessary nodes and leveraging batch drawing.
- Prefer token-driven styles to minimize inline style churn and improve caching.
- Debounce heavy operations in editor panels if needed (e.g., real-time previews).
- Optimize image assets and use appropriate formats/sizes to maintain responsiveness.

[No sources needed since this section provides general guidance]

## Troubleshooting Guide
- Error display: Ensure the reset function is correctly bound to recover from error boundaries.
- Upload failures: Validate file types and sizes before upload; check presign endpoint responses and network errors.
- Editor state mismatches: Verify that property changes propagate back to the scene and that transformer bounds are enforced.
- Theme inconsistencies: Confirm that CSS variables are loaded and not overridden by conflicting styles.

**Section sources**
- [ErrorDisplay.tsx:1-56](file://src/components/ui/ErrorDisplay.tsx#L1-L56)
- [ImageUploader.tsx:1-184](file://src/components/create/ImageUploader.tsx#L1-L184)
- [EditorCanvas.tsx:1-800](file://src/components/editor/EditorCanvas.tsx#L1-L800)
- [globals.css:1-92](file://src/app/globals.css#L1-L92)

## Conclusion
The design system establishes a cohesive visual language through centralized tokens and reusable primitives, enabling consistent, accessible, and performant UI across pages and complex editor experiences. By composing these building blocks, teams can rapidly iterate while maintaining brand integrity and user experience quality.