# Backend Architecture

<cite>
**Referenced Files in This Document**
- [middleware.ts](file://src/middleware.ts)
- [auth.ts](file://src/auth.ts)
- [prisma.ts](file://src/lib/prisma.ts)
- [s3.ts](file://src/lib/s3.ts)
- [generate.ts](file://src/lib/pdf/generate.ts)
- [constants.ts](file://src/lib/constants.ts)
- [package.json](file://package.json)
- [next.config.ts](file://next.config.ts)
- [api/admin/submissions/route.ts](file://src/app/api/admin/submissions/route.ts)
- [api/admin/submissions/[id]/route.ts](file://src/app/api/admin/submissions/[id]/route.ts)
- [api/submissions/route.ts](file://src/app/api/submissions/route.ts)
- [api/submissions/[id]/route.ts](file://src/app/api/submissions/[id]/route.ts)
- [api/submissions/[id]/pdf/route.ts](file://src/app/api/submissions/[id]/pdf/route.ts)
- [api/register/route.ts](file://src/app/api/register/route.ts)
- [api/upload/presign/route.ts](file://src/app/api/upload/presign/route.ts)
</cite>

## Table of Contents
1. [Introduction](#introduction)
2. [Project Structure](#project-structure)
3. [Core Components](#core-components)
4. [Architecture Overview](#architecture-overview)
5. [Detailed Component Analysis](#detailed-component-analysis)
6. [Dependency Analysis](#dependency-analysis)
7. [Performance Considerations](#performance-considerations)
8. [Security and Compliance](#security-and-compliance)
9. [Troubleshooting Guide](#troubleshooting-guide)
10. [Conclusion](#conclusion)

## Introduction
This document describes the backend architecture of Titchybook Creator, focusing on the serverless API pattern used by Next.js, the middleware-driven route protection, and the NextAuth integration for authentication and session management. It documents the API route structure organized by feature areas (authentication, submissions, admin), the authentication flow from login to protected route access, and error handling, validation, and response formatting strategies. Security considerations such as CORS, rate limiting, and input sanitization are addressed conceptually, along with integration points among middleware, authentication, and API routes.

## Project Structure
The backend is implemented as Next.js Serverless Functions under the app directory. Routes are grouped by feature and protected via middleware and per-route authentication checks. Shared infrastructure includes a Prisma client for database access, AWS S3 integration for uploads/downloads, and PDF generation utilities.

```mermaid
graph TB
subgraph "Middleware"
MW["middleware.ts<br/>matcher: /dashboard /create /admin"]
end
subgraph "NextAuth"
NA["auth.ts<br/>JWT session, callbacks, credentials provider"]
end
subgraph "API Routes"
AUTH_API["/api/auth/...nextauth<br/>NextAuth handler"]
REG_API["/api/register<br/>POST registration"]
PRESIGN_API["/api/upload/presign<br/>GET pre-signed upload URL"]
SUBS_API["/api/submissions<br/>GET list, POST create"]
SUBS_ID_API["/api/submissions/[id]<br/>GET single"]
SUBS_PDF_API["/api/submissions/[id]/pdf<br/>POST regenerate PDF"]
ADMIN_SUBS_API["/api/admin/submissions<br/>GET list"]
ADMIN_SUBS_ID_API["/api/admin/submissions/[id]<br/>PATCH approve/reject"]
end
subgraph "Libraries"
PRISMA["lib/prisma.ts<br/>PrismaClient"]
S3["lib/s3.ts<br/>AWS S3 client & presigned URLs"]
PDF["lib/pdf/generate.ts<br/>PDF composition"]
CONST["lib/constants.ts<br/>Enums, page labels, types"]
end
MW --> AUTH_API
MW --> REG_API
MW --> PRESIGN_API
MW --> SUBS_API
MW --> SUBS_ID_API
MW --> SUBS_PDF_API
MW --> ADMIN_SUBS_API
MW --> ADMIN_SUBS_ID_API
AUTH_API --> NA
REG_API --> PRISMA
PRESIGN_API --> S3
SUBS_API --> PRISMA
SUBS_API --> PDF
SUBS_ID_API --> PRISMA
SUBS_ID_API --> S3
SUBS_PDF_API --> PDF
ADMIN_SUBS_API --> PRISMA
ADMIN_SUBS_API --> S3
ADMIN_SUBS_ID_API --> PRISMA
ADMIN_SUBS_ID_API --> CONST
```

**Diagram sources**
- [middleware.ts:1-6](file://src/middleware.ts#L1-L6)
- [auth.ts:27-79](file://src/auth.ts#L27-L79)
- [prisma.ts:1-10](file://src/lib/prisma.ts#L1-L10)
- [s3.ts:1-81](file://src/lib/s3.ts#L1-L81)
- [generate.ts:23-111](file://src/lib/pdf/generate.ts#L23-L111)
- [constants.ts:6-49](file://src/lib/constants.ts#L6-L49)
- [api/admin/submissions/route.ts:1-38](file://src/app/api/admin/submissions/route.ts#L1-L38)
- [api/admin/submissions/[id]/route.ts:1-63](file://src/app/api/admin/submissions/[id]/route.ts#L1-L63)
- [api/submissions/route.ts:1-96](file://src/app/api/submissions/route.ts#L1-L96)
- [api/submissions/[id]/route.ts:1-37](file://src/app/api/submissions/[id]/route.ts#L1-L37)
- [api/submissions/[id]/pdf/route.ts:1-27](file://src/app/api/submissions/[id]/pdf/route.ts#L1-L27)
- [api/register/route.ts:1-47](file://src/app/api/register/route.ts#L1-L47)
- [api/upload/presign/route.ts:1-38](file://src/app/api/upload/presign/route.ts#L1-L38)

**Section sources**
- [middleware.ts:1-6](file://src/middleware.ts#L1-L6)
- [auth.ts:27-79](file://src/auth.ts#L27-L79)
- [prisma.ts:1-10](file://src/lib/prisma.ts#L1-L10)
- [s3.ts:1-81](file://src/lib/s3.ts#L1-L81)
- [generate.ts:23-111](file://src/lib/pdf/generate.ts#L23-L111)
- [constants.ts:6-49](file://src/lib/constants.ts#L6-L49)

## Core Components
- Middleware: Exposes NextAuth’s auth function and defines URL matchers for protected routes.
- NextAuth: Configures credentials provider, JWT session strategy, pages, and callbacks to attach user role to tokens and sessions.
- Prisma: Singleton client for database operations.
- S3: Presigned URL generation for uploads and downloads, plus direct upload/download helpers.
- PDF Generation: Orchestrates fetching images, processing, composing PDF, uploading to S3, and updating submission records.
- Constants: Strongly typed enums and constants for statuses, page labels, accepted image types, and limits.

**Section sources**
- [middleware.ts:1-6](file://src/middleware.ts#L1-L6)
- [auth.ts:27-79](file://src/auth.ts#L27-L79)
- [prisma.ts:1-10](file://src/lib/prisma.ts#L1-L10)
- [s3.ts:1-81](file://src/lib/s3.ts#L1-L81)
- [generate.ts:23-111](file://src/lib/pdf/generate.ts#L23-L111)
- [constants.ts:6-49](file://src/lib/constants.ts#L6-L49)

## Architecture Overview
The system follows a serverless API pattern with Next.js App Router. Requests are routed to route.ts handlers under src/app/api. Middleware enforces authentication for specific paths, while per-route handlers enforce authorization (roles) and perform domain logic. Authentication relies on NextAuth with JWT strategy and custom callbacks. Data persistence uses Prisma, and media assets are handled via AWS S3 with presigned URLs.

```mermaid
sequenceDiagram
participant C as "Client"
participant MW as "Middleware<br/>matcher"
participant NA as "NextAuth<br/>auth()"
participant AR as "API Route Handler"
C->>MW : "HTTP request to /dashboard|/create|/admin"
MW->>NA : "auth()"
NA-->>MW : "Session (JWT)"
MW-->>C : "Continue if authenticated"
C->>AR : "HTTP request to protected API"
AR->>NA : "auth()"
NA-->>AR : "Session (JWT)"
AR->>AR : "Authorization check (role/id)"
AR-->>C : "JSON response"
```

**Diagram sources**
- [middleware.ts:1-6](file://src/middleware.ts#L1-L6)
- [auth.ts:27-79](file://src/auth.ts#L27-L79)
- [api/submissions/route.ts:20-33](file://src/app/api/submissions/route.ts#L20-L33)
- [api/admin/submissions/route.ts:6-10](file://src/app/api/admin/submissions/route.ts#L6-L10)

## Detailed Component Analysis

### Middleware System and Route Protection
- Purpose: Apply authentication guard to route groups (/dashboard, /create, /admin).
- Behavior: Uses NextAuth’s exported auth function; matcher array controls which paths are intercepted.
- Integration: Ensures unauthenticated clients are redirected or blocked by downstream handlers.

```mermaid
flowchart TD
Start(["Incoming Request"]) --> Match["Matcher matches path?"]
Match --> |No| Allow["Proceed to route handler"]
Match --> |Yes| AuthCall["auth() from NextAuth"]
AuthCall --> HasSession{"Session exists?"}
HasSession --> |Yes| Allow
HasSession --> |No| Block["Return unauthorized/redirect"]
```

**Diagram sources**
- [middleware.ts:3-5](file://src/middleware.ts#L3-L5)
- [auth.ts:27-79](file://src/auth.ts#L27-L79)

**Section sources**
- [middleware.ts:1-6](file://src/middleware.ts#L1-L6)

### NextAuth Integration and Session Management
- Provider: Credentials provider validates email/password against hashed passwords stored in the database.
- Session Strategy: JWT; token carries user id and role; session mirrors token payload.
- Callbacks: jwt callback attaches id and role to the token; session callback injects id and role into session.user.
- Pages: Sign-in page mapped to /login.

```mermaid
classDiagram
class CredentialsProvider {
+authorize(credentials) User|null
}
class JWT {
+string id
+string role
}
class Session {
+User user
}
class User {
+string id
+string email
+string name
+string role
}
CredentialsProvider --> User : "returns"
JWT <.. Session : "mapped by callbacks"
User <.. CredentialsProvider : "from DB"
```

**Diagram sources**
- [auth.ts:27-79](file://src/auth.ts#L27-L79)
- [prisma.ts:1-10](file://src/lib/prisma.ts#L1-L10)

**Section sources**
- [auth.ts:27-79](file://src/auth.ts#L27-L79)

### Authentication Flow: Login to Protected Routes
- Login: Client submits credentials to NextAuth endpoint; provider authorizes and returns user.
- Session: NextAuth stores JWT; subsequent requests include session cookie/token.
- Protected Access: Middleware and route handlers call auth(); handlers enforce role checks (e.g., ADMIN).

```mermaid
sequenceDiagram
participant Client as "Client"
participant NextAuth as "NextAuth"
participant DB as "Prisma"
participant Route as "Protected Route"
Client->>NextAuth : "POST credentials"
NextAuth->>DB : "find user by email"
DB-->>NextAuth : "User with passwordHash"
NextAuth->>NextAuth : "compare password"
NextAuth-->>Client : "Session (JWT)"
Client->>Route : "GET /admin/submissions"
Route->>NextAuth : "auth()"
NextAuth-->>Route : "Session with role"
Route->>Route : "Role check (ADMIN)"
Route-->>Client : "200 OK or 403"
```

**Diagram sources**
- [auth.ts:35-58](file://src/auth.ts#L35-L58)
- [api/admin/submissions/route.ts:7-10](file://src/app/api/admin/submissions/route.ts#L7-L10)

**Section sources**
- [auth.ts:35-58](file://src/auth.ts#L35-L58)
- [api/admin/submissions/route.ts:7-10](file://src/app/api/admin/submissions/route.ts#L7-L10)

### API Route Structure by Feature Areas

#### Authentication and Registration
- POST /api/register: Validates input with Zod, checks uniqueness, hashes password, creates user.
- GET /api/upload/presign: Generates pre-signed upload URL for S3; validates required parameters and content type.

```mermaid
flowchart TD
A["POST /api/register"] --> Parse["Parse JSON with Zod"]
Parse --> Valid{"Valid?"}
Valid --> |No| Err400["Return 400 with error"]
Valid --> |Yes| CheckDup["Check unique email"]
CheckDup --> Exists{"Exists?"}
Exists --> |Yes| Err400Dup["Return 400 duplicate"]
Exists --> |No| Hash["Hash password"]
Hash --> Create["Create user in DB"]
Create --> Ok201["Return 201"]
U["GET /api/upload/presign"] --> Params["Validate params & content-type"]
Params --> ParamsOK{"OK?"}
ParamsOK --> |No| Err400U["Return 400"]
ParamsOK --> |Yes| Presign["Generate pre-signed URL"]
Presign --> Ok200U["Return uploadUrl + s3Key"]
```

**Diagram sources**
- [api/register/route.ts:12-46](file://src/app/api/register/route.ts#L12-L46)
- [api/upload/presign/route.ts:6-37](file://src/app/api/upload/presign/route.ts#L6-L37)

**Section sources**
- [api/register/route.ts:12-46](file://src/app/api/register/route.ts#L12-L46)
- [api/upload/presign/route.ts:6-37](file://src/app/api/upload/presign/route.ts#L6-L37)

#### Submissions (Authenticated Users)
- GET /api/submissions: Lists current user’s submissions.
- POST /api/submissions: Creates a new submission with 8 validated image entries; triggers asynchronous PDF generation.
- GET /api/submissions/[id]: Retrieves a single submission; enforces ownership or ADMIN role; optionally generates presigned PDF URL.
- POST /api/submissions/[id]/pdf: Regenerates PDF for a submission.

```mermaid
sequenceDiagram
participant Client as "Client"
participant Subs as "POST /api/submissions"
participant Val as "Zod Validation"
participant DB as "Prisma"
participant PDF as "PDF Generator"
Client->>Subs : "JSON with 8 images"
Subs->>Val : "safeParse"
Val-->>Subs : "Parsed data or errors"
Subs->>DB : "Create submission + images"
Subs->>PDF : "generateTitchybookPdf(id)"
PDF-->>Subs : "Promise resolves"
Subs-->>Client : "201 with submission id/status"
```

**Diagram sources**
- [api/submissions/route.ts:35-95](file://src/app/api/submissions/route.ts#L35-L95)
- [generate.ts:23-111](file://src/lib/pdf/generate.ts#L23-L111)

**Section sources**
- [api/submissions/route.ts:20-95](file://src/app/api/submissions/route.ts#L20-L95)
- [api/submissions/[id]/route.ts:6-36](file://src/app/api/submissions/[id]/route.ts#L6-L36)
- [api/submissions/[id]/pdf/route.ts:5-26](file://src/app/api/submissions/[id]/pdf/route.ts#L5-L26)

#### Admin (Administrators Only)
- GET /api/admin/submissions: Lists submissions with optional status filter; enriches with presigned PDF URLs.
- PATCH /api/admin/submissions/[id]: Approves or rejects a submission; sets rejection reason when rejected.

```mermaid
flowchart TD
AGet["GET /api/admin/submissions"] --> Filter["Filter by status if provided"]
Filter --> List["Fetch submissions with user/images"]
List --> Urls["Generate presigned PDF URLs"]
Urls --> Ok200A["Return submissions"]
APatch["PATCH /api/admin/submissions/[id]"] --> Role["Verify ADMIN role"]
Role --> |Fail| Err403["Return 403"]
Role --> |Pass| Parse["Parse action + reason"]
Parse --> Update["Update status + reason"]
Update --> Ok200Patch["Return updated submission"]
```

**Diagram sources**
- [api/admin/submissions/route.ts:6-37](file://src/app/api/admin/submissions/route.ts#L6-L37)
- [api/admin/submissions/[id]/route.ts:12-61](file://src/app/api/admin/submissions/[id]/route.ts#L12-L61)

**Section sources**
- [api/admin/submissions/route.ts:6-37](file://src/app/api/admin/submissions/route.ts#L6-L37)
- [api/admin/submissions/[id]/route.ts:12-61](file://src/app/api/admin/submissions/[id]/route.ts#L12-L61)

### Request Validation and Response Formatting
- Validation: Zod schemas define strict shapes for registration and submissions; safeParse returns structured errors.
- Responses: Consistent JSON bodies with either data objects or error messages; appropriate HTTP status codes (200/201/400/401/403/404/500).
- Error Handling: Try/catch blocks wrap async operations; specific branches return 400/404/500 depending on failure mode.

**Section sources**
- [api/register/route.ts:6-10](file://src/app/api/register/route.ts#L6-L10)
- [api/submissions/route.ts:8-18](file://src/app/api/submissions/route.ts#L8-L18)
- [api/upload/presign/route.ts:18-30](file://src/app/api/upload/presign/route.ts#L18-L30)

### Serverless API Pattern in Next.js
- Route Handlers: Each route.ts exports async functions (GET/POST/PATCH) that accept NextRequest/Request and return NextResponse.
- Dynamic Routes: Parameters resolved via params promise; handlers await params to access route segments.
- Environment: Uses Next.js runtime; no traditional server required.

**Section sources**
- [api/submissions/[id]/route.ts:7-20](file://src/app/api/submissions/[id]/route.ts#L7-L20)
- [api/admin/submissions/[id]/route.ts:12-22](file://src/app/api/admin/submissions/[id]/route.ts#L12-L22)

## Dependency Analysis
- Middleware depends on NextAuth for session retrieval.
- API routes depend on NextAuth for auth checks, Prisma for persistence, and S3 for media.
- PDF generation depends on Prisma for data and S3 for storage.
- Constants provide shared types and enums across modules.

```mermaid
graph LR
MW["middleware.ts"] --> NA["auth.ts"]
NA --> PRISMA["lib/prisma.ts"]
REG["api/register/route.ts"] --> PRISMA
PRESIGN["api/upload/presign/route.ts"] --> S3["lib/s3.ts"]
SUBS["api/submissions/route.ts"] --> PRISMA
SUBS --> PDF["lib/pdf/generate.ts"]
SUBSID["api/submissions/[id]/route.ts"] --> PRISMA
SUBSID --> S3
SUBSPDF["api/submissions/[id]/pdf/route.ts"] --> PDF
ADMINS["api/admin/submissions/route.ts"] --> PRISMA
ADMINS --> S3
ADMINID["api/admin/submissions/[id]/route.ts"] --> PRISMA
ADMINID --> CONST["lib/constants.ts"]
```

**Diagram sources**
- [middleware.ts:1-1](file://src/middleware.ts#L1-L1)
- [auth.ts:27-79](file://src/auth.ts#L27-L79)
- [prisma.ts:1-10](file://src/lib/prisma.ts#L1-L10)
- [s3.ts:1-81](file://src/lib/s3.ts#L1-L81)
- [generate.ts:23-111](file://src/lib/pdf/generate.ts#L23-L111)
- [constants.ts:6-49](file://src/lib/constants.ts#L6-L49)
- [api/register/route.ts:1-47](file://src/app/api/register/route.ts#L1-L47)
- [api/upload/presign/route.ts:1-38](file://src/app/api/upload/presign/route.ts#L1-L38)
- [api/submissions/route.ts:1-96](file://src/app/api/submissions/route.ts#L1-L96)
- [api/submissions/[id]/route.ts:1-37](file://src/app/api/submissions/[id]/route.ts#L1-L37)
- [api/submissions/[id]/pdf/route.ts:1-27](file://src/app/api/submissions/[id]/pdf/route.ts#L1-L27)
- [api/admin/submissions/route.ts:1-38](file://src/app/api/admin/submissions/route.ts#L1-L38)
- [api/admin/submissions/[id]/route.ts:1-63](file://src/app/api/admin/submissions/[id]/route.ts#L1-L63)

**Section sources**
- [package.json:11-24](file://package.json#L11-L24)

## Performance Considerations
- Asynchronous PDF Generation: Background generation avoids blocking API responses; failures logged but do not fail the submission creation.
- Parallel Operations: PDF generation downloads and processes images in parallel to reduce latency.
- Presigned URLs: Offloads uploads/downloads to S3; reduces server bandwidth and CPU usage.
- Transactional Writes: Submission creation uses a single transaction to maintain consistency.

[No sources needed since this section provides general guidance]

## Security and Compliance
- Authentication: JWT-based session strategy with NextAuth; credentials provider validates against hashed passwords.
- Authorization: Per-route checks enforce user ownership or ADMIN role.
- Input Validation: Zod schemas validate and sanitize request payloads.
- Content Type Enforcement: Upload endpoint restricts accepted image types.
- Secrets Management: AWS credentials and bucket configured via environment variables; keep secrets out of client bundles.
- CORS: Not explicitly configured in the provided files; configure at the framework level if cross-origin access is required.
- Rate Limiting: Not implemented in the provided files; consider adding rate limiting at the edge or middleware layer.
- Input Sanitization: Strict schema parsing; reject invalid payloads early with 400 responses.

**Section sources**
- [auth.ts:27-79](file://src/auth.ts#L27-L79)
- [api/upload/presign/route.ts:25-30](file://src/app/api/upload/presign/route.ts#L25-L30)
- [api/register/route.ts:17-22](file://src/app/api/register/route.ts#L17-L22)
- [api/submissions/route.ts:45-50](file://src/app/api/submissions/route.ts#L45-L50)

## Troubleshooting Guide
- Unauthorized Access: Ensure auth() is called and session contains user id; verify middleware matcher includes the route.
- Forbidden Access: Confirm ADMIN role for admin endpoints; otherwise, verify ownership for user endpoints.
- Validation Errors: Review Zod error messages returned in the error field; ensure payloads match schemas.
- PDF Generation Failures: Check logs for PDF generation errors; regenerate via POST /api/submissions/[id]/pdf.
- S3 Issues: Verify AWS credentials and bucket name; confirm presigned URL generation succeeds.

**Section sources**
- [api/submissions/route.ts:21-24](file://src/app/api/submissions/route.ts#L21-L24)
- [api/admin/submissions/route.ts:8-10](file://src/app/api/admin/submissions/route.ts#L8-L10)
- [api/submissions/[id]/route.ts:26-28](file://src/app/api/submissions/[id]/route.ts#L26-L28)
- [api/submissions/[id]/pdf/route.ts:19-25](file://src/app/api/submissions/[id]/pdf/route.ts#L19-L25)
- [api/upload/presign/route.ts:34-36](file://src/app/api/upload/presign/route.ts#L34-L36)

## Conclusion
The backend leverages Next.js serverless functions with a robust middleware and NextAuth integration to protect routes and manage sessions. API routes are organized by feature, with strong validation, consistent error handling, and clear authorization checks. Integrations with Prisma and AWS S3 enable scalable persistence and media handling, while asynchronous PDF generation improves responsiveness. Security is enforced through JWT sessions, role-based access control, and strict input validation.