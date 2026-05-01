# Architecture Overview

<cite>
**Referenced Files in This Document**
- [src/app/layout.tsx](file://src/app/layout.tsx)
- [src/components/Providers.tsx](file://src/components/Providers.tsx)
- [src/middleware.ts](file://src/middleware.ts)
- [src/auth.ts](file://src/auth.ts)
- [src/app/api/auth/[...nextauth]/route.ts](file://src/app/api/auth/[...nextauth]/route.ts)
- [src/lib/prisma.ts](file://src/lib/prisma.ts)
- [prisma/schema.prisma](file://prisma/schema.prisma)
- [src/lib/s3.ts](file://src/lib/s3.ts)
- [src/lib/constants.ts](file://src/lib/constants.ts)
- [src/app/(auth)/login/page.tsx](file://src/app/(auth)/login/page.tsx)
- [src/app/(protected)/dashboard/page.tsx](file://src/app/(protected)/dashboard/page.tsx)
- [src/app/api/admin/submissions/route.ts](file://src/app/api/admin/submissions/route.ts)
- [src/app/api/upload/presign/route.ts](file://src/app/api/upload/presign/route.ts)
- [src/app/api/submissions/[id]/route.ts](file://src/app/api/submissions/[id]/route.ts)
- [src/components/create/ImageUploader.tsx](file://src/components/create/ImageUploader.tsx)
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
This document describes the system architecture of Titchybook Creator, a Next.js application that enables users to create printable 8-page micro booklets from uploaded images. The system follows a layered architecture with presentation, business logic, and data access layers. It leverages the Next.js App Router with route groups to organize authentication, protected, and administrative areas. Security is enforced via middleware and NextAuth-based session management. Data persistence uses Prisma ORM with a local SQLite database, while binary assets are stored in AWS S3 using pre-signed URLs for secure uploads and downloads.

## Project Structure
The project is organized around the Next.js App Router:
- Presentation layer: React components under src/components and pages under src/app.
- Business logic: Route handlers under src/app/api implement request handling and orchestrate domain operations.
- Data access: Prisma client in src/lib/prisma.ts and S3 utilities in src/lib/s3.ts.
- Authentication and middleware: src/auth.ts defines NextAuth configuration, src/middleware.ts enforces route protection, and src/app/api/auth/[...nextauth]/route.ts exposes NextAuth endpoints.

```mermaid
graph TB
subgraph "Presentation Layer"
L["Root Layout<br/>src/app/layout.tsx"]
P["Providers<br/>src/components/Providers.tsx"]
C1["Login Page<br/>src/app/(auth)/login/page.tsx"]
C2["Dashboard Page<br/>src/app/(protected)/dashboard/page.tsx"]
U["ImageUploader Component<br/>src/components/create/ImageUploader.tsx"]
end
subgraph "Business Logic"
A1["/api/auth/[...nextauth]<br/>src/app/api/auth/[...nextauth]/route.ts"]
A2["/api/upload/presign<br/>src/app/api/upload/presign/route.ts"]
A3["/api/admin/submissions<br/>src/app/api/admin/submissions/route.ts"]
A4["/api/submissions/[id]<br/>src/app/api/submissions/[id]/route.ts"]
end
subgraph "Data Access"
PRISMA["Prisma Client<br/>src/lib/prisma.ts"]
SCHEMA["Prisma Schema<br/>prisma/schema.prisma"]
S3["S3 Utilities<br/>src/lib/s3.ts"]
end
subgraph "Security & Routing"
AUTH["NextAuth Config<br/>src/auth.ts"]
MW["Middleware<br/>src/middleware.ts"]
end
L --> P
L --> C1
L --> C2
C1 --> A1
C2 --> A3
U --> A2
A1 --> AUTH
A2 --> AUTH
A3 --> AUTH
A4 --> AUTH
AUTH --> PRISMA
A2 --> S3
A3 --> S3
A4 --> S3
MW --> AUTH
PRISMA --> SCHEMA
```

**Diagram sources**
- [src/app/layout.tsx:23-41](file://src/app/layout.tsx#L23-L41)
- [src/components/Providers.tsx:5-7](file://src/components/Providers.tsx#L5-L7)
- [src/app/(auth)/login/page.tsx](file://src/app/(auth)/login/page.tsx#L1-L13)
- [src/app/(protected)/dashboard/page.tsx](file://src/app/(protected)/dashboard/page.tsx#L1-L20)
- [src/app/api/auth/[...nextauth]/route.ts](file://src/app/api/auth/[...nextauth]/route.ts#L1-L4)
- [src/app/api/upload/presign/route.ts:1-38](file://src/app/api/upload/presign/route.ts#L1-L38)
- [src/app/api/admin/submissions/route.ts:1-38](file://src/app/api/admin/submissions/route.ts#L1-L38)
- [src/app/api/submissions/[id]/route.ts](file://src/app/api/submissions/[id]/route.ts#L1-L37)
- [src/auth.ts:27-79](file://src/auth.ts#L27-L79)
- [src/middleware.ts:1-6](file://src/middleware.ts#L1-L6)
- [src/lib/prisma.ts:1-10](file://src/lib/prisma.ts#L1-L10)
- [prisma/schema.prisma:1-48](file://prisma/schema.prisma#L1-L48)
- [src/lib/s3.ts:1-81](file://src/lib/s3.ts#L1-L81)

**Section sources**
- [src/app/layout.tsx:1-42](file://src/app/layout.tsx#L1-L42)
- [src/components/Providers.tsx:1-8](file://src/components/Providers.tsx#L1-L8)
- [src/middleware.ts:1-6](file://src/middleware.ts#L1-L6)
- [src/auth.ts:1-80](file://src/auth.ts#L1-L80)
- [src/app/api/auth/[...nextauth]/route.ts](file://src/app/api/auth/[...nextauth]/route.ts#L1-L4)
- [src/lib/prisma.ts:1-10](file://src/lib/prisma.ts#L1-L10)
- [prisma/schema.prisma:1-48](file://prisma/schema.prisma#L1-L48)
- [src/lib/s3.ts:1-81](file://src/lib/s3.ts#L1-L81)
- [src/lib/constants.ts:1-49](file://src/lib/constants.ts#L1-L49)
- [src/app/(auth)/login/page.tsx](file://src/app/(auth)/login/page.tsx#L1-L13)
- [src/app/(protected)/dashboard/page.tsx](file://src/app/(protected)/dashboard/page.tsx#L1-L20)
- [src/app/api/admin/submissions/route.ts:1-38](file://src/app/api/admin/submissions/route.ts#L1-L38)
- [src/app/api/upload/presign/route.ts:1-38](file://src/app/api/upload/presign/route.ts#L1-L38)
- [src/app/api/submissions/[id]/route.ts](file://src/app/api/submissions/[id]/route.ts#L1-L37)
- [src/components/create/ImageUploader.tsx:1-148](file://src/components/create/ImageUploader.tsx#L1-L148)

## Core Components
- Root layout and providers: The root layout composes Providers to enable session management across the app. See [src/app/layout.tsx:23-41](file://src/app/layout.tsx#L23-L41) and [src/components/Providers.tsx:5-7](file://src/components/Providers.tsx#L5-L7).
- Middleware: Enforces authentication for protected routes using NextAuth. See [src/middleware.ts:1-6](file://src/middleware.ts#L1-L6).
- Authentication: NextAuth configuration with JWT session strategy, credential provider, and typed session/JWT interfaces. See [src/auth.ts:27-79](file://src/auth.ts#L27-L79).
- API routes: Implement business logic for authentication, upload pre-signing, admin submissions, and submission retrieval. See:
  - [src/app/api/auth/[...nextauth]/route.ts](file://src/app/api/auth/[...nextauth]/route.ts#L1-L4)
  - [src/app/api/upload/presign/route.ts:1-38](file://src/app/api/upload/presign/route.ts#L1-L38)
  - [src/app/api/admin/submissions/route.ts:1-38](file://src/app/api/admin/submissions/route.ts#L1-L38)
  - [src/app/api/submissions/[id]/route.ts](file://src/app/api/submissions/[id]/route.ts#L1-L37)
- Data access:
  - Prisma client initialization and schema modeling. See [src/lib/prisma.ts:1-10](file://src/lib/prisma.ts#L1-L10) and [prisma/schema.prisma:1-48](file://prisma/schema.prisma#L1-L48).
  - S3 utilities for pre-signed URLs and direct uploads/downloads. See [src/lib/s3.ts:1-81](file://src/lib/s3.ts#L1-L81).
- Constants and types: Submission statuses, page labels, accepted image types, and sizes. See [src/lib/constants.ts:1-49](file://src/lib/constants.ts#L1-L49).
- Presentation components:
  - Login page and dashboard page. See [src/app/(auth)/login/page.tsx](file://src/app/(auth)/login/page.tsx#L1-L13) and [src/app/(protected)/dashboard/page.tsx](file://src/app/(protected)/dashboard/page.tsx#L1-L20).
  - Image uploader component that integrates with the pre-sign API. See [src/components/create/ImageUploader.tsx:1-148](file://src/components/create/ImageUploader.tsx#L1-L148).

**Section sources**
- [src/app/layout.tsx:23-41](file://src/app/layout.tsx#L23-L41)
- [src/components/Providers.tsx:5-7](file://src/components/Providers.tsx#L5-L7)
- [src/middleware.ts:1-6](file://src/middleware.ts#L1-L6)
- [src/auth.ts:27-79](file://src/auth.ts#L27-L79)
- [src/app/api/auth/[...nextauth]/route.ts](file://src/app/api/auth/[...nextauth]/route.ts#L1-L4)
- [src/app/api/upload/presign/route.ts:1-38](file://src/app/api/upload/presign/route.ts#L1-L38)
- [src/app/api/admin/submissions/route.ts:1-38](file://src/app/api/admin/submissions/route.ts#L1-L38)
- [src/app/api/submissions/[id]/route.ts](file://src/app/api/submissions/[id]/route.ts#L1-L37)
- [src/lib/prisma.ts:1-10](file://src/lib/prisma.ts#L1-L10)
- [prisma/schema.prisma:1-48](file://prisma/schema.prisma#L1-L48)
- [src/lib/s3.ts:1-81](file://src/lib/s3.ts#L1-L81)
- [src/lib/constants.ts:1-49](file://src/lib/constants.ts#L1-L49)
- [src/app/(auth)/login/page.tsx](file://src/app/(auth)/login/page.tsx#L1-L13)
- [src/app/(protected)/dashboard/page.tsx](file://src/app/(protected)/dashboard/page.tsx#L1-L20)
- [src/components/create/ImageUploader.tsx:1-148](file://src/components/create/ImageUploader.tsx#L1-L148)

## Architecture Overview
The system employs a layered architecture:
- Presentation layer: Next.js App Router pages and React components render UI and collect user input.
- Business logic layer: API routes encapsulate request handling, validation, authorization checks, and orchestration of data access.
- Data access layer: Prisma ORM manages relational data, and S3 utilities manage binary assets with pre-signed URLs.

```mermaid
graph TB
UI["Pages & Components<br/>src/app/*, src/components/*"] --> API["API Routes<br/>src/app/api/*"]
API --> AUTH["NextAuth<br/>src/auth.ts"]
API --> PRISMA["Prisma ORM<br/>src/lib/prisma.ts"]
API --> S3["AWS S3<br/>src/lib/s3.ts"]
AUTH --> PRISMA
MW["Middleware<br/>src/middleware.ts"] --> AUTH
```

**Diagram sources**
- [src/app/(auth)/login/page.tsx](file://src/app/(auth)/login/page.tsx#L1-L13)
- [src/app/(protected)/dashboard/page.tsx](file://src/app/(protected)/dashboard/page.tsx#L1-L20)
- [src/components/create/ImageUploader.tsx:1-148](file://src/components/create/ImageUploader.tsx#L1-L148)
- [src/app/api/upload/presign/route.ts:1-38](file://src/app/api/upload/presign/route.ts#L1-L38)
- [src/app/api/admin/submissions/route.ts:1-38](file://src/app/api/admin/submissions/route.ts#L1-L38)
- [src/app/api/submissions/[id]/route.ts](file://src/app/api/submissions/[id]/route.ts#L1-L37)
- [src/auth.ts:27-79](file://src/auth.ts#L27-L79)
- [src/lib/prisma.ts:1-10](file://src/lib/prisma.ts#L1-L10)
- [src/lib/s3.ts:1-81](file://src/lib/s3.ts#L1-L81)
- [src/middleware.ts:1-6](file://src/middleware.ts#L1-L6)

## Detailed Component Analysis

### Layered Architecture and Component Hierarchy
- Root layout composes Providers to enable session management for all pages. Providers wraps the header, main content, and toast notifications.
- Pages under route groups:
  - Authentication group: login page renders LoginForm and delegates to NextAuth endpoints.
  - Protected group: dashboard page lists user submissions and links to creation flow.
- Component hierarchy starts at the root layout, passes through Providers, and reaches individual pages and shared components.

```mermaid
sequenceDiagram
participant Browser as "Browser"
participant Layout as "RootLayout<br/>layout.tsx"
participant Providers as "Providers<br/>Providers.tsx"
participant Page as "Protected Page<br/>dashboard/page.tsx"
participant MW as "Middleware<br/>middleware.ts"
participant Auth as "NextAuth<br/>auth.ts"
Browser->>MW : "Navigate to /dashboard"
MW->>Auth : "auth()"
Auth-->>MW : "Session (JWT)"
MW-->>Browser : "Allow"
Browser->>Layout : "Render"
Layout->>Providers : "Wrap children"
Providers->>Page : "Render dashboard"
```

**Diagram sources**
- [src/app/layout.tsx:23-41](file://src/app/layout.tsx#L23-L41)
- [src/components/Providers.tsx:5-7](file://src/components/Providers.tsx#L5-L7)
- [src/app/(protected)/dashboard/page.tsx](file://src/app/(protected)/dashboard/page.tsx#L1-L20)
- [src/middleware.ts:1-6](file://src/middleware.ts#L1-L6)
- [src/auth.ts:27-79](file://src/auth.ts#L27-L79)

**Section sources**
- [src/app/layout.tsx:23-41](file://src/app/layout.tsx#L23-L41)
- [src/components/Providers.tsx:5-7](file://src/components/Providers.tsx#L5-L7)
- [src/app/(protected)/dashboard/page.tsx](file://src/app/(protected)/dashboard/page.tsx#L1-L20)
- [src/middleware.ts:1-6](file://src/middleware.ts#L1-L6)
- [src/auth.ts:27-79](file://src/auth.ts#L27-L79)

### Next.js App Router Pattern and Route Groups
- Route groups segment functionality:
  - (auth): Login and registration flows.
  - (protected): User dashboard and creation flows.
  - (admin): Administrative submission management.
- Grouping allows clean separation of concerns and simplified routing without affecting URLs.

```mermaid
graph TB
G1["Route Group (auth)<br/>/login, /register"]
G2["Route Group (protected)<br/>/dashboard, /create"]
G3["Route Group (admin)<br/>/admin"]
G1 --> P1["Login Page<br/>login/page.tsx"]
G2 --> P2["Dashboard Page<br/>dashboard/page.tsx"]
G3 --> P3["Admin Page<br/>admin/page.tsx"]
```

**Diagram sources**
- [src/app/(auth)/login/page.tsx](file://src/app/(auth)/login/page.tsx#L1-L13)
- [src/app/(protected)/dashboard/page.tsx](file://src/app/(protected)/dashboard/page.tsx#L1-L20)
- [src/app/(admin)/admin/page.tsx](file://src/app/(admin)/admin/page.tsx)

**Section sources**
- [src/app/(auth)/login/page.tsx](file://src/app/(auth)/login/page.tsx#L1-L13)
- [src/app/(protected)/dashboard/page.tsx](file://src/app/(protected)/dashboard/page.tsx#L1-L20)

### Middleware Implementation for Route Protection
- Middleware exports NextAuth’s auth function and matches protected routes.
- Unauthorized access is blocked before rendering protected pages.

```mermaid
flowchart TD
Start(["Incoming Request"]) --> Match["Match against protected routes"]
Match --> |Match| CallAuth["Call auth()"]
Match --> |No match| Allow["Allow request"]
CallAuth --> HasSession{"Has session?"}
HasSession --> |Yes| Allow
HasSession --> |No| Deny["Return 401/Redirect"]
Allow --> End(["Proceed to page"])
Deny --> End
```

**Diagram sources**
- [src/middleware.ts:1-6](file://src/middleware.ts#L1-L6)
- [src/auth.ts:27-79](file://src/auth.ts#L27-L79)

**Section sources**
- [src/middleware.ts:1-6](file://src/middleware.ts#L1-L6)
- [src/auth.ts:27-79](file://src/auth.ts#L27-L79)

### Authentication Flow and Session Management
- NextAuth handles credential-based login, JWT session storage, and typed session/JWT payloads.
- NextAuth endpoints are exposed via a catch-all API route.
- The Providers component wraps the app to make session data available to client components.

```mermaid
sequenceDiagram
participant Client as "Client Component"
participant Providers as "Providers"
participant NextAuthAPI as "NextAuth API<br/>/api/auth/[...nextauth]"
participant Auth as "NextAuth Config<br/>auth.ts"
participant Prisma as "Prisma Client<br/>prisma.ts"
Client->>Providers : "Wrap app"
Client->>NextAuthAPI : "POST /api/auth/callback/credentials"
NextAuthAPI->>Auth : "authorize(credentials)"
Auth->>Prisma : "Find user by email"
Prisma-->>Auth : "User record"
Auth-->>NextAuthAPI : "User payload"
NextAuthAPI-->>Client : "JWT session"
```

**Diagram sources**
- [src/components/Providers.tsx:5-7](file://src/components/Providers.tsx#L5-L7)
- [src/app/api/auth/[...nextauth]/route.ts](file://src/app/api/auth/[...nextauth]/route.ts#L1-L4)
- [src/auth.ts:27-79](file://src/auth.ts#L27-L79)
- [src/lib/prisma.ts:1-10](file://src/lib/prisma.ts#L1-L10)

**Section sources**
- [src/components/Providers.tsx:5-7](file://src/components/Providers.tsx#L5-L7)
- [src/app/api/auth/[...nextauth]/route.ts](file://src/app/api/auth/[...nextauth]/route.ts#L1-L4)
- [src/auth.ts:27-79](file://src/auth.ts#L27-L79)
- [src/lib/prisma.ts:1-10](file://src/lib/prisma.ts#L1-L10)

### Integration Patterns: React Components, API Routes, Prisma, and S3
- ImageUploader component:
  - Validates file type and size.
  - Requests a pre-signed upload URL from /api/upload/presign.
  - Uploads directly to S3 and notifies parent on success.
- Pre-signed URL generation:
  - API validates session, constructs S3 key, and returns a pre-signed PUT URL.
- Submission retrieval:
  - API validates session, enforces ownership or admin privileges, and optionally generates a pre-signed PDF download URL.
- Admin submissions:
  - API validates admin role, queries submissions with filters, and enriches results with pre-signed PDF URLs.

```mermaid
sequenceDiagram
participant UI as "ImageUploader<br/>ImageUploader.tsx"
participant API as "Pre-Sign API<br/>/api/upload/presign/route.ts"
participant Auth as "NextAuth<br/>auth.ts"
participant S3 as "S3 Utilities<br/>s3.ts"
participant DB as "Prisma<br/>prisma.ts"
UI->>API : "GET /api/upload/presign?filename&contentType&submissionId&pageLabel"
API->>Auth : "auth()"
Auth-->>API : "Session"
API->>S3 : "getPresignedUploadUrl(buildUploadKey(...))"
S3-->>API : "uploadUrl"
API-->>UI : "{uploadUrl, s3Key}"
UI->>S3 : "PUT uploadUrl (file)"
S3-->>UI : "Success"
UI-->>DB : "Persist image metadata (via subsequent flows)"
```

**Diagram sources**
- [src/components/create/ImageUploader.tsx:22-73](file://src/components/create/ImageUploader.tsx#L22-L73)
- [src/app/api/upload/presign/route.ts:6-37](file://src/app/api/upload/presign/route.ts#L6-L37)
- [src/auth.ts:27-79](file://src/auth.ts#L27-L79)
- [src/lib/s3.ts:18-28](file://src/lib/s3.ts#L18-L28)
- [src/lib/prisma.ts:1-10](file://src/lib/prisma.ts#L1-L10)

**Section sources**
- [src/components/create/ImageUploader.tsx:1-148](file://src/components/create/ImageUploader.tsx#L1-L148)
- [src/app/api/upload/presign/route.ts:1-38](file://src/app/api/upload/presign/route.ts#L1-L38)
- [src/lib/s3.ts:1-81](file://src/lib/s3.ts#L1-L81)
- [src/lib/prisma.ts:1-10](file://src/lib/prisma.ts#L1-L10)
- [src/auth.ts:27-79](file://src/auth.ts#L27-L79)

### Data Model and Repository/Factory Patterns
- Data model:
  - User, Submission, SubmissionImage entities define relationships and indexes.
- Repository pattern:
  - API routes act as repositories, orchestrating Prisma queries and S3 operations.
- Factory pattern:
  - S3 utilities construct keys for uploads and PDFs, acting as factories for S3 keys.

```mermaid
erDiagram
USER {
string id PK
string email UK
string passwordHash
string name
string role
datetime createdAt
datetime updatedAt
}
SUBMISSION {
string id PK
string userId FK
string status
string pdfS3Key
string rejectionReason
datetime createdAt
datetime updatedAt
}
SUBMISSION_IMAGE {
string id PK
string submissionId FK
string pageLabel
string s3Key
int order
string originalFilename
string mimeType
datetime createdAt
}
USER ||--o{ SUBMISSION : "creates"
SUBMISSION ||--o{ SUBMISSION_IMAGE : "contains"
```

**Diagram sources**
- [prisma/schema.prisma:10-47](file://prisma/schema.prisma#L10-L47)

**Section sources**
- [prisma/schema.prisma:1-48](file://prisma/schema.prisma#L1-L48)
- [src/lib/s3.ts:66-80](file://src/lib/s3.ts#L66-L80)

### Security Architecture and Authorization
- Session strategy: JWT-based sessions managed by NextAuth.
- Role-based access control:
  - Admin-only endpoint requires ADMIN role.
  - Submission retrieval enforces ownership or ADMIN role.
- Middleware-based protection:
  - Protects routes under /dashboard, /create, and /admin.

```mermaid
flowchart TD
Req["Request"] --> MW["Middleware<br/>auth()"]
MW --> |Unauthorized| R401["401 Unauthorized"]
MW --> |Authorized| ACL["ACL Checks"]
ACL --> Admin{"Admin Endpoint?"}
Admin --> |Yes| Role{"Role == ADMIN?"}
Role --> |No| R403["403 Forbidden"]
Role --> |Yes| OK["Proceed"]
Admin --> |No| Owner{"Owner or Admin?"}
Owner --> |No| R403
Owner --> |Yes| OK
```

**Diagram sources**
- [src/middleware.ts:1-6](file://src/middleware.ts#L1-L6)
- [src/app/api/admin/submissions/route.ts:7-10](file://src/app/api/admin/submissions/route.ts#L7-L10)
- [src/app/api/submissions/[id]/route.ts](file://src/app/api/submissions/[id]/route.ts#L26-L28)
- [src/auth.ts:65-78](file://src/auth.ts#L65-L78)

**Section sources**
- [src/middleware.ts:1-6](file://src/middleware.ts#L1-L6)
- [src/app/api/admin/submissions/route.ts:1-38](file://src/app/api/admin/submissions/route.ts#L1-L38)
- [src/app/api/submissions/[id]/route.ts](file://src/app/api/submissions/[id]/route.ts#L1-L37)
- [src/auth.ts:65-78](file://src/auth.ts#L65-L78)

## Dependency Analysis
- Presentation depends on:
  - Providers for session context.
  - API routes for server interactions.
- API routes depend on:
  - NextAuth for session validation.
  - Prisma for data access.
  - S3 utilities for asset operations.
- Middleware depends on NextAuth to enforce access control.

```mermaid
graph LR
UI["UI Components"] --> API["API Routes"]
API --> AUTH["NextAuth"]
API --> PRISMA["Prisma"]
API --> S3["S3 Utils"]
MW["Middleware"] --> AUTH
```

**Diagram sources**
- [src/components/Providers.tsx:5-7](file://src/components/Providers.tsx#L5-L7)
- [src/app/api/upload/presign/route.ts:1-38](file://src/app/api/upload/presign/route.ts#L1-L38)
- [src/app/api/admin/submissions/route.ts:1-38](file://src/app/api/admin/submissions/route.ts#L1-L38)
- [src/app/api/submissions/[id]/route.ts](file://src/app/api/submissions/[id]/route.ts#L1-L37)
- [src/auth.ts:27-79](file://src/auth.ts#L27-L79)
- [src/lib/prisma.ts:1-10](file://src/lib/prisma.ts#L1-L10)
- [src/lib/s3.ts:1-81](file://src/lib/s3.ts#L1-L81)
- [src/middleware.ts:1-6](file://src/middleware.ts#L1-L6)

**Section sources**
- [src/components/Providers.tsx:5-7](file://src/components/Providers.tsx#L5-L7)
- [src/app/api/upload/presign/route.ts:1-38](file://src/app/api/upload/presign/route.ts#L1-L38)
- [src/app/api/admin/submissions/route.ts:1-38](file://src/app/api/admin/submissions/route.ts#L1-L38)
- [src/app/api/submissions/[id]/route.ts](file://src/app/api/submissions/[id]/route.ts#L1-L37)
- [src/auth.ts:27-79](file://src/auth.ts#L27-L79)
- [src/lib/prisma.ts:1-10](file://src/lib/prisma.ts#L1-L10)
- [src/lib/s3.ts:1-81](file://src/lib/s3.ts#L1-L81)
- [src/middleware.ts:1-6](file://src/middleware.ts#L1-L6)

## Performance Considerations
- Pre-signed S3 URLs eliminate server bandwidth for large uploads and downloads.
- Batch enrichment of submission lists with pre-signed URLs reduces round-trips.
- Client-side validation prevents unnecessary requests for invalid files.
- Prisma queries include selective includes and ordering to minimize payload size.

## Troubleshooting Guide
- Authentication failures:
  - Verify NextAuth endpoints are reachable and session strategy is configured.
  - Confirm environment variables for JWT secret and provider credentials.
- Middleware blocking legitimate requests:
  - Ensure matcher patterns align with intended protected routes.
- Upload failures:
  - Validate accepted content types and file size limits.
  - Confirm S3 bucket permissions and region configuration.
- Database errors:
  - Check Prisma client initialization and schema migrations.

**Section sources**
- [src/app/api/auth/[...nextauth]/route.ts](file://src/app/api/auth/[...nextauth]/route.ts#L1-L4)
- [src/middleware.ts:1-6](file://src/middleware.ts#L1-L6)
- [src/lib/constants.ts:42-49](file://src/lib/constants.ts#L42-L49)
- [src/lib/s3.ts:8-14](file://src/lib/s3.ts#L8-L14)
- [src/lib/prisma.ts:1-10](file://src/lib/prisma.ts#L1-L10)

## Conclusion
Titchybook Creator implements a clean layered architecture with clear separation between presentation, business logic, and data access. The Next.js App Router with route groups organizes authentication, protected, and administrative flows. Middleware and NextAuth provide robust session management and authorization. Prisma and S3 integrate seamlessly through API routes, enabling scalable and maintainable data and asset handling.