# NextAuth Configuration & Setup

<cite>
**Referenced Files in This Document**
- [auth.ts](file://src/auth.ts)
- [proxy.ts](file://src/proxy.ts)
- [route.ts](file://src/app/api/auth/[...nextauth]/route.ts)
- [LoginForm.tsx](file://src/components/auth/LoginForm.tsx)
- [RegisterForm.tsx](file://src/components/auth/RegisterForm.tsx)
- [LoginPage.tsx](file://src/app/(auth)/login/page.tsx)
- [RegisterPage.tsx](file://src/app/(auth)/register/page.tsx)
- [DashboardPage.tsx](file://src/app/(protected)/dashboard/page.tsx)
- [CreatePage.tsx](file://src/app/(protected)/create/page.tsx)
- [AdminPage.tsx](file://src/app/(admin)/admin/page.tsx)
- [prisma.ts](file://src/lib/prisma.ts)
- [schema.prisma](file://prisma/schema.prisma)
- [package.json](file://package.json)
- [next.config.ts](file://next.config.ts)
</cite>

## Update Summary
**Changes Made**
- Updated authentication guard implementation from middleware.ts to proxy.ts for Next.js 16 compatibility
- Enhanced documentation for NextAuth v5 proxy-based route protection
- Updated architecture diagrams to reflect the new proxy pattern
- Added comprehensive coverage of protected route configuration and behavior
- Updated troubleshooting guide with proxy-specific considerations

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
This document explains the NextAuth configuration in Titchybook Creator, focusing on the JWT strategy, custom credentials provider, TypeScript module augmentation, and callback functions for token-to-session mapping and user role propagation. It covers the NextAuth configuration object structure, provider credentials definition, authentication pages setup, and security considerations for JWT implementation with NextAuth v5 trustHost configuration and Next.js 16 proxy-based route protection.

## Project Structure
The authentication system spans several layers:
- NextAuth configuration with v5 trustHost settings and callbacks
- Proxy-based route protection for Next.js 16 compatibility
- Route handlers with force-dynamic rendering
- Client-side login form using next-auth/react
- Registration API endpoint
- Prisma integration for user lookup and persistence
- Database schema defining user roles and fields

```mermaid
graph TB
subgraph "Client"
UI_Login["LoginForm.tsx"]
UI_Register["RegisterForm.tsx"]
end
subgraph "Server"
NA_Config["auth.ts<br/>NextAuth v5 config"]
PROXY["proxy.ts<br/>Route Protection"]
API_Auth["/api/auth/[...nextauth]<br/>Route Handler"]
API_Reg["/api/register<br/>POST"]
end
subgraph "Data"
PRISMA_LIB["prisma.ts<br/>PrismaClient"]
SCHEMA["schema.prisma<br/>User model"]
end
UI_Login --> |"Credentials provider"| NA_Config
UI_Register --> API_Reg
API_Auth --> NA_Config
API_Reg --> PRISMA_LIB
PRISMA_LIB --> SCHEMA
NA_Config --> PRISMA_LIB
PROXY --> NA_Config
```

**Diagram sources**
- [auth.ts:27-89](file://src/auth.ts#L27-L89)
- [proxy.ts:1-15](file://src/proxy.ts#L1-L15)
- [route.ts:1-4](file://src/app/api/auth/[...nextauth]/route.ts#L1-L4)
- [RegisterForm.tsx:14-39](file://src/components/auth/RegisterForm.tsx#L14-L39)
- [prisma.ts:1-10](file://src/lib/prisma.ts#L1-L10)
- [schema.prisma:10-19](file://prisma/schema.prisma#L10-L19)

**Section sources**
- [auth.ts:27-89](file://src/auth.ts#L27-L89)
- [proxy.ts:1-15](file://src/proxy.ts#L1-L15)
- [route.ts:1-4](file://src/app/api/auth/[...nextauth]/route.ts#L1-L4)
- [RegisterForm.tsx:14-39](file://src/components/auth/RegisterForm.tsx#L14-L39)
- [prisma.ts:1-10](file://src/lib/prisma.ts#L1-L10)
- [schema.prisma:10-19](file://prisma/schema.prisma#L10-L19)

## Core Components
- NextAuth configuration with JWT strategy, credentials provider, and v5 trustHost settings
- Proxy-based route protection for Next.js 16 compatibility
- Module augmentation for TypeScript to include user role in Session and JWT
- Callbacks for JWT and session mapping
- Route handlers with force-dynamic rendering for API endpoints
- Client login form invoking the credentials provider
- Registration API endpoint with Zod validation and bcrypt hashing

**Section sources**
- [auth.ts:6-25](file://src/auth.ts#L6-L25)
- [auth.ts:27-89](file://src/auth.ts#L27-L89)
- [proxy.ts:1-15](file://src/proxy.ts#L1-L15)
- [route.ts:1-4](file://src/app/api/auth/[...nextauth]/route.ts#L1-L4)
- [LoginForm.tsx:14-33](file://src/components/auth/LoginForm.tsx#L14-L33)
- [RegisterForm.tsx:14-39](file://src/components/auth/RegisterForm.tsx#L14-L39)

## Architecture Overview
The authentication flow integrates client-side login, NextAuth's credentials provider with v5 trustHost configuration, server-side user validation via Prisma, and proxy-based route protection for Next.js 16 compatibility. Roles are propagated from the database through the JWT to the session.

```mermaid
sequenceDiagram
participant C as "Client Browser"
participant L as "LoginForm.tsx"
participant P as "Proxy (proxy.ts)"
participant RH as "Route Handler<br/>[...nextauth]"
participant N as "NextAuth (auth.ts)"
participant P as "Prisma (prisma.ts)"
participant D as "SQLite (schema.prisma)"
C->>L : Submit credentials
L->>RH : signIn("credentials", {email,password})
RH->>N : Process auth request
N->>P : Find user by email
P->>D : SELECT user WHERE email
D-->>P : User row
P-->>N : User object
N->>N : Compare passwordHash
N-->>L : {error} or success
alt Success
N->>N : callbacks.jwt(token)<br/>callbacks.session(session)
N-->>C : JWT in cookie/session
else Error
N-->>L : {error}
end
Note over P : Protected routes (/dashboard,<br/>/create, /admin) require<br/>authenticated session
```

**Diagram sources**
- [LoginForm.tsx:19-32](file://src/components/auth/LoginForm.tsx#L19-L32)
- [proxy.ts:3-14](file://src/proxy.ts#L3-L14)
- [route.ts:1-4](file://src/app/api/auth/[...nextauth]/route.ts#L1-L4)
- [auth.ts:35-89](file://src/auth.ts#L35-L89)
- [prisma.ts:1-10](file://src/lib/prisma.ts#L1-L10)
- [schema.prisma:10-19](file://prisma/schema.prisma#L10-L19)

## Detailed Component Analysis

### NextAuth Configuration and JWT Strategy with v5 TrustHost
- Provider: Credentials provider with explicit credential fields for email and password.
- Strategy: JWT-based session strategy.
- Pages: Sign-in page mapped to the login route.
- **Updated**: TrustHost configuration set to `true` for proper production URL resolution in NextAuth v5.
- Callbacks:
  - jwt: Attach user id and role to the token when a user logs in.
  - session: Map token fields to session.user for client-side consumption.

Security considerations:
- JWT strategy avoids server-side session storage.
- Token size is minimized by storing only essential fields (id, role).
- Password verification uses bcrypt comparison against stored passwordHash.
- TrustHost configuration ensures proper URL handling in production environments.

**Section sources**
- [auth.ts:27-89](file://src/auth.ts#L27-L89)
- [schema.prisma:10-19](file://prisma/schema.prisma#L10-L19)

### Module Augmentation for TypeScript Types
TypeScript types are augmented to include:
- Session.user: adds role field alongside id, email, and optional name.
- JWT: adds id and role fields for JWT payloads.

This ensures type safety for accessing user role in both JWT and session contexts.

**Section sources**
- [auth.ts:6-25](file://src/auth.ts#L6-L25)

### Provider Credentials Definition
- Credential fields: email and password.
- authorize function:
  - Validates presence of email and password.
  - Loads user by email via Prisma.
  - Compares password using bcrypt against passwordHash.
  - Returns user object with id, email, name, and role on success.

**Section sources**
- [auth.ts:28-60](file://src/auth.ts#L28-L60)
- [auth.ts:35-58](file://src/auth.ts#L35-L58)
- [prisma.ts:1-10](file://src/lib/prisma.ts#L1-L10)
- [schema.prisma:10-19](file://prisma/schema.prisma#L10-L19)

### Callback Functions: JWT and Session Management
- jwt callback:
  - On initial login, attaches id and role to the token.
  - Subsequent requests reuse the token without re-querying the database.
- session callback:
  - Maps token fields to session.user for client-side access.

Token-to-session mapping and role propagation:
- Role flows from database through authorize → jwt → session → client.

**Section sources**
- [auth.ts:65-89](file://src/auth.ts#L65-L89)

### Authentication Pages Setup
- Sign-in page: mapped to the login route.
- Login UI: LoginForm component posts credentials to the credentials provider.
- Route handler: Uses NextAuth v5 pattern with exported handlers.

**Section sources**
- [auth.ts:62-64](file://src/auth.ts#L62-L64)
- [route.ts:1-4](file://src/app/api/auth/[...nextauth]/route.ts#L1-L4)
- [LoginPage.tsx:1-13](file://src/app/(auth)/login/page.tsx#L1-L13)
- [LoginForm.tsx:19-32](file://src/components/auth/LoginForm.tsx#L19-L32)

### Custom Authorize Function Implementation
- Input validation: Ensures both email and password are present.
- User lookup: Finds user by email using Prisma.
- Password validation: Uses bcrypt compare against stored passwordHash.
- User object construction: Returns id, email, name, and role for successful authentication.

```mermaid
flowchart TD
Start(["authorize(credentials)"]) --> CheckFields["Check email and password present"]
CheckFields --> FieldsOK{"Both present?"}
FieldsOK --> |No| ReturnNull1["Return null"]
FieldsOK --> |Yes| Lookup["Find user by email"]
Lookup --> Found{"User found?"}
Found --> |No| ReturnNull2["Return null"]
Found --> |Yes| Verify["Compare passwordHash"]
Verify --> Valid{"Valid?"}
Valid --> |No| ReturnNull3["Return null"]
Valid --> |Yes| BuildUser["Return {id,email,name,role}"]
ReturnNull1 --> End(["Exit"])
ReturnNull2 --> End
ReturnNull3 --> End
BuildUser --> End
```

**Diagram sources**
- [auth.ts:35-58](file://src/auth.ts#L35-L58)

**Section sources**
- [auth.ts:35-58](file://src/auth.ts#L35-L58)

### Password Validation with bcryptjs
- Registration endpoint hashes passwords with bcrypt before storing.
- Login flow compares provided password with stored hash using bcrypt compare.

**Section sources**
- [RegisterForm.tsx:14-39](file://src/components/auth/RegisterForm.tsx#L14-L39)
- [auth.ts:49](file://src/auth.ts#L49)

### Session Strategy Selection and Token Expiration
- Strategy: JWT.
- Expiration: Not configured, so defaults apply. Review NextAuth documentation for default behavior and configure maxAge/rotate if needed.

**Section sources**
- [auth.ts:61](file://src/auth.ts#L61)

### Next.js 16 Proxy-Based Route Protection
**Updated** The authentication system now uses NextAuth v5's built-in proxy functionality instead of traditional middleware.ts for Next.js 16 compatibility.

Key features:
- **Proxy Configuration**: Routes are protected via the `proxy.ts` file using NextAuth's `auth` export as a proxy.
- **Protected Routes**: The following routes require authentication:
  - `/dashboard` and all nested paths (`/dashboard/:path*`)
  - `/create` and all nested paths (`/create/:path*`)
  - `/admin` and all nested paths (`/admin/:path*`)
- **Automatic Redirection**: Unauthenticated requests are redirected to `/login` with the original path preserved in `callbackUrl`.
- **Prefetch Support**: Works correctly with Next.js prefetch requests and RSC (React Server Components).

How it works:
- The proxy intercepts requests to protected routes before they reach the page components.
- If no authenticated session exists, returns a 307 redirect to `/login?callbackUrl=/original-path`.
- If authenticated, allows the request to proceed to the protected page.
- Maintains full compatibility with Next.js routing patterns and prefetch optimization.

```mermaid
sequenceDiagram
participant B as "Browser"
participant P as "Proxy (proxy.ts)"
participant A as "NextAuth (auth.ts)"
participant PG as "Protected Page"
B->>P : Request /dashboard
P->>A : Check authentication
alt No Session
A-->>P : Unauthorized
P-->>B : 307 Redirect to /login?callbackUrl=/dashboard
else Has Session
A-->>P : Authorized
P-->>B : Continue to /dashboard
B->>PG : Render dashboard page
end
```

**Diagram sources**
- [proxy.ts:1-15](file://src/proxy.ts#L1-L15)
- [auth.ts:68-74](file://src/auth.ts#L68-L74)

**Section sources**
- [proxy.ts:1-15](file://src/proxy.ts#L1-L15)
- [auth.ts:68-74](file://src/auth.ts#L68-L74)

### Security Considerations for JWT Implementation
- Keep payload minimal (id, role) to reduce token size.
- Avoid storing sensitive data in JWT claims.
- Ensure HTTPS in production to protect cookies/tokens.
- Consider setting maxAge and rotating tokens for stronger security.
- **Updated**: TrustHost configuration enables proper URL resolution in production environments.
- **Updated**: Proxy-based route protection provides robust security for Next.js 16 applications.

## Dependency Analysis
- NextAuth depends on:
  - Prisma for user lookup
  - bcryptjs for password hashing/verification
  - Zod for registration validation
- Proxy enforces protected routes using NextAuth's auth export.
- Client components depend on next-auth/react for sign-in actions.
- Route handlers use NextAuth v5 pattern with exported handlers.

```mermaid
graph LR
AUTH["auth.ts"] --> PRISMA["prisma.ts"]
AUTH --> BC["bcryptjs"]
REG_FORM["RegisterForm.tsx"] --> ZOD["Zod schema"]
REG_API["/api/register/route.ts"] --> PRISMA
REG_API --> BC
LOGIN_UI["LoginForm.tsx"] --> AUTH
PROXY["proxy.ts"] --> AUTH
ROUTE_HANDLER["[/...nextauth] route.ts"] --> AUTH
```

**Diagram sources**
- [auth.ts:1-4](file://src/auth.ts#L1-L4)
- [proxy.ts:1-15](file://src/proxy.ts#L1-L15)
- [prisma.ts:1-10](file://src/lib/prisma.ts#L1-L10)
- [RegisterForm.tsx:14-39](file://src/components/auth/RegisterForm.tsx#L14-L39)
- [LoginForm.tsx:3,19-32](file://src/components/auth/LoginForm.tsx#L3,L19-L32)
- [route.ts:1-4](file://src/app/api/auth/[...nextauth]/route.ts#L1-L4)

**Section sources**
- [auth.ts:1-4](file://src/auth.ts#L1-L4)
- [proxy.ts:1-15](file://src/proxy.ts#L1-L15)
- [prisma.ts:1-10](file://src/lib/prisma.ts#L1-L10)
- [RegisterForm.tsx:14-39](file://src/components/auth/RegisterForm.tsx#L14-L39)
- [LoginForm.tsx:3,19-32](file://src/components/auth/LoginForm.tsx#L3,L19-L32)
- [route.ts:1-4](file://src/app/api/auth/[...nextauth]/route.ts#L1-L4)

## Performance Considerations
- JWT strategy reduces server-side session storage overhead.
- Keep token payload small to minimize network overhead.
- Consider adding rate limiting for authentication endpoints.
- Use database indexes on email for efficient user lookup.
- **Updated**: Proxy-based route protection provides optimal performance for Next.js 16 while maintaining security.
- **Updated**: Built-in proxy eliminates middleware overhead and improves request processing speed.

## Troubleshooting Guide
Common issues and resolutions:
- Invalid credentials error:
  - Occurs when email/password are missing or incorrect.
  - Client displays a user-friendly message.
- User not found:
  - authorize returns null when email does not exist.
- Password mismatch:
  - bcrypt compare fails, authorize returns null.
- Registration conflicts:
  - Duplicate email triggers a 400 response with an error message.
- **Updated**: Production URL issues:
  - Ensure NEXTAUTH_URL environment variable is properly configured.
  - TrustHost configuration handles URL resolution in different deployment environments.
- **Updated**: Proxy-related issues:
  - Protected routes returning 307 redirects: Ensure user is authenticated before accessing protected routes.
  - Prefetch requests being blocked: The proxy correctly handles Next.js prefetch requests with proper redirect responses.
  - Route matching issues: Verify that protected routes match the exact patterns defined in proxy.ts matcher array.

**Section sources**
- [LoginForm.tsx:27-32](file://src/components/auth/LoginForm.tsx#L27-L32)
- [auth.ts:35-58](file://src/auth.ts#L35-L58)
- [RegisterForm.tsx:28-32](file://src/components/auth/RegisterForm.tsx#L28-L32)
- [RegisterForm.tsx:34-38](file://src/components/auth/RegisterForm.tsx#L34-38)
- [proxy.ts:3-14](file://src/proxy.ts#L3-L14)

## Conclusion
Titchybook Creator implements a secure, JWT-backed authentication system using NextAuth v5 with enhanced trustHost configuration for proper production URL resolution and Next.js 16 proxy-based route protection. The credentials provider validates users against the database, and module augmentation ensures type-safe access to user roles. The proxy-based approach provides robust route protection for `/dashboard`, `/create`, and `/admin` routes while maintaining full compatibility with Next.js 16 features including prefetch requests and React Server Components. Client components integrate seamlessly with the provider. For production, review token expiration and consider additional security measures such as maxAge and rotation. The combination of trustHost configuration and proxy-based route protection provides robust security and reliability for authenticated API endpoints and protected routes.