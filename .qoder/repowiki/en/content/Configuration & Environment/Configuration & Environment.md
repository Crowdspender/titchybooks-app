# Configuration & Environment

<cite>
**Referenced Files in This Document**
- [package.json](file://package.json)
- [next.config.ts](file://next.config.ts)
- [tsconfig.json](file://tsconfig.json)
- [prisma/schema.prisma](file://prisma/schema.prisma)
- [prisma/seed.ts](file://prisma/seed.ts)
- [src/lib/prisma.ts](file://src/lib/prisma.ts)
- [src/lib/s3.ts](file://src/lib/s3.ts)
- [src/auth.ts](file://src/auth.ts)
- [src/middleware.ts](file://src/middleware.ts)
- [src/app/api/auth/[...nextauth]/route.ts](file://src/app/api/auth/[...nextauth]/route.ts)
- [src/app/api/upload/presign/route.ts](file://src/app/api/upload/presign/route.ts)
- [src/app/api/submissions/route.ts](file://src/app/api/submissions/route.ts)
- [src/components/auth/LoginForm.tsx](file://src/components/auth/LoginForm.tsx)
- [src/components/create/ImageUploader.tsx](file://src/components/create/ImageUploader.tsx)
- [src/lib/constants.ts](file://src/lib/constants.ts)
- [src/lib/pdf/generate.ts](file://src/lib/pdf/generate.ts)
- [README.md](file://README.md)
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
This document provides comprehensive configuration and environment documentation for Titchybook Creator. It covers environment variables for database connections, AWS S3, NextAuth, and application settings; Next.js and TypeScript configuration; Prisma setup for schema and migrations; AWS S3 integration and security; authentication and authorization; deployment considerations; and operational best practices.

## Project Structure
The project is a Next.js 16 application using TypeScript, Prisma for database access, NextAuth v5 for authentication, and AWS SDK for S3 integration. Configuration is primarily driven by environment variables loaded at runtime and validated through runtime checks and schema validation.

```mermaid
graph TB
subgraph "Environment Variables"
ENV_DB["DATABASE_URL"]
ENV_AWS["AWS_REGION<br/>AWS_ACCESS_KEY_ID<br/>AWS_SECRET_ACCESS_KEY<br/>S3_BUCKET_NAME"]
ENV_NEXTAUTH["NEXTAUTH_URL<br/>NEXTAUTH_SECRET"]
end
subgraph "Next.js Runtime"
NEXTCONF["next.config.ts"]
TS["tsconfig.json"]
AUTH["src/auth.ts"]
MW["src/middleware.ts"]
end
subgraph "Prisma"
SCHEMA["prisma/schema.prisma"]
PRISMA_LIB["src/lib/prisma.ts"]
SEED["prisma/seed.ts"]
end
subgraph "AWS S3"
S3LIB["src/lib/s3.ts"]
PRESIGN["/api/upload/presign"]
PDFGEN["/lib/pdf/generate.ts"]
end
ENV_DB --> PRISMA_LIB
ENV_DB --> SCHEMA
ENV_AWS --> S3LIB
ENV_NEXTAUTH --> AUTH
AUTH --> MW
PRISMA_LIB --> AUTH
PRISMA_LIB --> PDFGEN
S3LIB --> PRESIGN
S3LIB --> PDFGEN
NEXTCONF --> AUTH
TS --> AUTH
```

**Diagram sources**
- [next.config.ts:1-8](file://next.config.ts#L1-L8)
- [tsconfig.json:1-35](file://tsconfig.json#L1-L35)
- [prisma/schema.prisma:1-48](file://prisma/schema.prisma#L1-L48)
- [src/lib/prisma.ts:1-10](file://src/lib/prisma.ts#L1-L10)
- [prisma/seed.ts:1-36](file://prisma/seed.ts#L1-L36)
- [src/lib/s3.ts:1-81](file://src/lib/s3.ts#L1-L81)
- [src/auth.ts:1-80](file://src/auth.ts#L1-L80)
- [src/middleware.ts:1-6](file://src/middleware.ts#L1-L6)
- [src/app/api/upload/presign/route.ts:1-38](file://src/app/api/upload/presign/route.ts#L1-L38)
- [src/lib/pdf/generate.ts:1-112](file://src/lib/pdf/generate.ts#L1-L112)

**Section sources**
- [README.md:1-37](file://README.md#L1-L37)
- [package.json:1-43](file://package.json#L1-L43)
- [next.config.ts:1-8](file://next.config.ts#L1-L8)
- [tsconfig.json:1-35](file://tsconfig.json#L1-L35)

## Core Components
- Database connection via Prisma using an environment-driven datasource URL.
- Authentication via NextAuth with JWT strategy and credentials provider.
- AWS S3 integration for signed uploads and downloads, with presigned URLs for secure client-side uploads.
- PDF generation pipeline that composes images into an A4 landscape PDF and stores it in S3.
- Middleware enforcing protected routes for dashboard, creation, and admin areas.

**Section sources**
- [prisma/schema.prisma:1-48](file://prisma/schema.prisma#L1-L48)
- [src/lib/prisma.ts:1-10](file://src/lib/prisma.ts#L1-L10)
- [src/auth.ts:1-80](file://src/auth.ts#L1-L80)
- [src/lib/s3.ts:1-81](file://src/lib/s3.ts#L1-L81)
- [src/lib/pdf/generate.ts:1-112](file://src/lib/pdf/generate.ts#L1-L112)
- [src/middleware.ts:1-6](file://src/middleware.ts#L1-L6)

## Architecture Overview
The application relies on environment variables for external configuration. Authentication is handled by NextAuth, which integrates with the Prisma user model. S3 operations are performed through the AWS SDK with presigned URLs to offload uploads to the cloud. PDF generation is triggered after submission creation and updates the database with the generated PDF key.

```mermaid
sequenceDiagram
participant Client as "Browser"
participant NextAuth as "NextAuth Handlers"
participant Prisma as "Prisma Client"
participant S3 as "AWS S3"
participant PDFGen as "PDF Generator"
Client->>NextAuth : "POST /api/auth/[...nextauth]"
NextAuth->>Prisma : "Find user by email"
Prisma-->>NextAuth : "User record"
NextAuth-->>Client : "JWT session"
Client->>S3 : "GET /api/upload/presign?filename&contentType&submissionId&pageLabel"
S3-->>Client : "{uploadUrl, s3Key}"
Client->>S3 : "PUT uploadUrl (file)"
S3-->>Client : "200 OK"
Client->>Prisma : "POST /api/submissions (images)"
Prisma-->>Client : "Submission created"
Prisma->>PDFGen : "Trigger PDF generation"
PDFGen->>S3 : "Upload generated PDF"
S3-->>PDFGen : "Success"
PDFGen->>Prisma : "Update submission with pdfS3Key"
```

**Diagram sources**
- [src/app/api/auth/[...nextauth]/route.ts](file://src/app/api/auth/[...nextauth]/route.ts#L1-L4)
- [src/auth.ts:1-80](file://src/auth.ts#L1-L80)
- [src/lib/prisma.ts:1-10](file://src/lib/prisma.ts#L1-L10)
- [src/app/api/upload/presign/route.ts:1-38](file://src/app/api/upload/presign/route.ts#L1-L38)
- [src/lib/s3.ts:1-81](file://src/lib/s3.ts#L1-L81)
- [src/app/api/submissions/route.ts:1-96](file://src/app/api/submissions/route.ts#L1-L96)
- [src/lib/pdf/generate.ts:1-112](file://src/lib/pdf/generate.ts#L1-L112)

## Detailed Component Analysis

### Environment Variables and Secrets
- Database
  - DATABASE_URL: Points to the database provider and connection string. The schema defines the provider and reads the URL from the environment.
- AWS S3
  - AWS_REGION: Region for S3 client initialization.
  - AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY: Credentials for S3 client.
  - S3_BUCKET_NAME: Target bucket for uploads and PDF storage.
- NextAuth
  - NEXTAUTH_URL: Base URL for NextAuth endpoints.
  - NEXTAUTH_SECRET: Secret used to encrypt JWT tokens.
- Application
  - ADMIN_EMAIL and ADMIN_PASSWORD: Used by the seed script to provision an initial admin user.

Validation and usage occur at runtime:
- S3 client initialization requires all AWS_* variables.
- Prisma client initialization reads DATABASE_URL.
- NextAuth requires NEXTAUTH_URL and NEXTAUTH_SECRET.
- Seed script conditionally uses ADMIN_EMAIL and ADMIN_PASSWORD.

Security considerations:
- Never commit secrets to version control.
- Use platform-managed secrets for deployments (e.g., Vercel, Docker, CI/CD).
- Restrict AWS credentials to least privilege and dedicated IAM user/role.

**Section sources**
- [prisma/schema.prisma:5-8](file://prisma/schema.prisma#L5-L8)
- [src/lib/prisma.ts:1-10](file://src/lib/prisma.ts#L1-L10)
- [src/lib/s3.ts:8-14](file://src/lib/s3.ts#L8-L14)
- [src/auth.ts:27-64](file://src/auth.ts#L27-L64)
- [prisma/seed.ts:7-25](file://prisma/seed.ts#L7-L25)

### Next.js Configuration
- next.config.ts: Empty default configuration indicates minimal overrides. Add optimization flags here if needed (e.g., experimental settings, output traces).
- Middleware: Uses NextAuth middleware to protect routes under specific paths.

Recommendations:
- Enable output traces for production builds to analyze bundle size.
- Consider enabling the React Server Components optimizer if not already enabled by the Next.js version.

**Section sources**
- [next.config.ts:1-8](file://next.config.ts#L1-L8)
- [src/middleware.ts:1-6](file://src/middleware.ts#L1-L6)

### TypeScript Configuration
- Strict mode enabled for robust type checking.
- Bundler module resolution for ESM compatibility.
- Path aliases (@/*) mapped to src/.
- Incremental compilation enabled for faster builds.

Recommendations:
- Keep strict mode enabled.
- Pin TypeScript and ESLint versions to match the project’s lockfile.
- Add tsconfig paths to IDE settings for accurate imports.

**Section sources**
- [tsconfig.json:1-35](file://tsconfig.json#L1-L35)

### Prisma Configuration and Schema
- Provider: sqlite.
- Datasource URL sourced from DATABASE_URL.
- Models:
  - User: email, passwordHash, name, role, timestamps.
  - Submission: belongs to User, status, optional pdfS3Key, rejectionReason, timestamps.
  - SubmissionImage: belongs to Submission, pageLabel, s3Key, order, filenames, mime types, timestamps.
- Indexes: composite indexes on foreign keys for efficient joins.

Initialization:
- Global singleton pattern prevents multiple Prisma clients in development.
- Seed script creates an admin user if not present, using ADMIN_EMAIL and ADMIN_PASSWORD.

Migrations:
- Migrations are managed under prisma/migrations with a lock file ensuring safe concurrent runs.

**Section sources**
- [prisma/schema.prisma:1-48](file://prisma/schema.prisma#L1-L48)
- [src/lib/prisma.ts:1-10](file://src/lib/prisma.ts#L1-L10)
- [prisma/seed.ts:1-36](file://prisma/seed.ts#L1-L36)

### AWS S3 Integration
- Client initialization: region and credentials from environment variables.
- Bucket name from environment variable.
- Presigned URLs:
  - Upload: PUT URL with 10-minute expiry.
  - Download: GET URL with 1-hour expiry.
- Upload/download helpers:
  - uploadToS3 and downloadFromS3 for programmatic operations.
  - Key builders:
    - buildUploadKey: uploads/<userId>/<submissionId>/<pageLabel>.<ext>
    - buildPdfKey: pdfs/<userId>/<submissionId>/titchybook.pdf
- API endpoint:
  - GET /api/upload/presign validates content type against accepted image types and constructs S3 key before returning presigned URL.

Security:
- Presigned URLs limit exposure of long-lived credentials.
- Content-type validation reduces risk of malicious uploads.
- Bucket policies should restrict access to authorized users and roles.

**Section sources**
- [src/lib/s3.ts:1-81](file://src/lib/s3.ts#L1-L81)
- [src/app/api/upload/presign/route.ts:1-38](file://src/app/api/upload/presign/route.ts#L1-L38)
- [src/lib/constants.ts:42-49](file://src/lib/constants.ts#L42-L49)

### NextAuth Configuration
- Provider: Credentials with email and password fields.
- Authorization: Queries Prisma for user by email, compares hashed password.
- Session strategy: JWT with callbacks to attach user id and role to token/session.
- Pages: Login page mapped to /login.
- API: Exposed via /api/auth/[...nextauth].

Security:
- Password hashing is handled by bcryptjs.
- JWT encryption depends on NEXTAUTH_SECRET.
- Ensure NEXTAUTH_URL matches deployed domain.

**Section sources**
- [src/auth.ts:1-80](file://src/auth.ts#L1-L80)
- [src/app/api/auth/[...nextauth]/route.ts](file://src/app/api/auth/[...nextauth]/route.ts#L1-L4)
- [src/components/auth/LoginForm.tsx:1-86](file://src/components/auth/LoginForm.tsx#L1-L86)

### PDF Generation Pipeline
- Triggers after submission creation.
- Sets submission status to PROCESSING during generation.
- Downloads 8 required images from S3, processes them, composes an A4 landscape PDF, uploads the PDF to S3, and updates the submission with pdfS3Key and resets status to PENDING.

**Section sources**
- [src/app/api/submissions/route.ts:35-96](file://src/app/api/submissions/route.ts#L35-L96)
- [src/lib/pdf/generate.ts:1-112](file://src/lib/pdf/generate.ts#L1-L112)

### Client-Side Upload Flow
- Validates file type and size.
- Requests a presigned upload URL from the backend.
- Uploads directly to S3 using the returned URL.
- On success, notifies parent component with s3Key.

**Section sources**
- [src/components/create/ImageUploader.tsx:1-148](file://src/components/create/ImageUploader.tsx#L1-L148)
- [src/app/api/upload/presign/route.ts:1-38](file://src/app/api/upload/presign/route.ts#L1-L38)

## Dependency Analysis
External dependencies relevant to configuration:
- next: Application runtime and routing.
- next-auth: Authentication framework.
- @prisma/client: Database client.
- @aws-sdk/client-s3 and @aws-sdk/s3-request-presigner: S3 operations and presigned URLs.
- pdf-lib: PDF composition.
- sharp: Image processing.
- bcryptjs: Password hashing.
- dotenv: Seed script support.

Build and dev dependencies include TypeScript, ESLint, Tailwind, and Prisma CLI.

**Section sources**
- [package.json:11-41](file://package.json#L11-L41)

## Performance Considerations
- Use presigned uploads to reduce server bandwidth and latency.
- Parallelize S3 downloads and image processing for PDF generation.
- Keep TypeScript strict mode enabled to catch performance-related type issues early.
- Consider enabling Next.js output tracing for production builds to analyze bundle composition.
- Optimize image sizes and formats on the client before upload to minimize S3 costs and processing time.

[No sources needed since this section provides general guidance]

## Troubleshooting Guide
Common issues and resolutions:
- Authentication fails
  - Verify NEXTAUTH_URL and NEXTAUTH_SECRET are set and correct.
  - Ensure user exists in the database with a valid password hash.
- Unauthorized on protected routes
  - Confirm middleware matcher targets the intended paths and NextAuth is initialized.
- S3 upload failures
  - Check AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, and S3_BUCKET_NAME.
  - Validate content type against accepted image types.
  - Ensure presigned URL is requested with required parameters.
- PDF generation errors
  - Confirm all 8 page labels are present and images are uploaded.
  - Verify S3 connectivity and permissions for the bucket.
- Prisma connection errors
  - Ensure DATABASE_URL points to a valid sqlite path or external database.
  - Run migrations if schema changes are detected.

**Section sources**
- [src/auth.ts:27-64](file://src/auth.ts#L27-L64)
- [src/middleware.ts:3-5](file://src/middleware.ts#L3-L5)
- [src/lib/s3.ts:8-14](file://src/lib/s3.ts#L8-L14)
- [src/app/api/upload/presign/route.ts:18-30](file://src/app/api/upload/presign/route.ts#L18-L30)
- [src/lib/pdf/generate.ts:23-30](file://src/lib/pdf/generate.ts#L23-L30)
- [prisma/schema.prisma:5-8](file://prisma/schema.prisma#L5-L8)

## Conclusion
Titchybook Creator’s configuration is driven by environment variables and modularized libraries. By securing secrets, validating inputs, and leveraging presigned URLs, the system achieves a balance between developer productivity and operational safety. Adhering to the recommendations and troubleshooting steps outlined here will help maintain a reliable and scalable deployment across environments.

[No sources needed since this section summarizes without analyzing specific files]

## Appendices

### Environment Variable Reference
- Database
  - DATABASE_URL: Database connection string/provider.
- AWS S3
  - AWS_REGION: AWS region for S3 client.
  - AWS_ACCESS_KEY_ID: Access key ID for S3.
  - AWS_SECRET_ACCESS_KEY: Secret access key for S3.
  - S3_BUCKET_NAME: Target S3 bucket.
- NextAuth
  - NEXTAUTH_URL: Base URL for NextAuth endpoints.
  - NEXTAUTH_SECRET: Secret for JWT encryption.
- Application
  - ADMIN_EMAIL: Seed script admin email override.
  - ADMIN_PASSWORD: Seed script admin password override.

**Section sources**
- [prisma/schema.prisma:5-8](file://prisma/schema.prisma#L5-L8)
- [src/lib/s3.ts:8-14](file://src/lib/s3.ts#L8-L14)
- [src/auth.ts:27-64](file://src/auth.ts#L27-L64)
- [prisma/seed.ts:7-25](file://prisma/seed.ts#L7-L25)

### Deployment Checklist
- Set environment variables for database, AWS, and NextAuth.
- Configure IAM user/role with least privilege for S3 bucket access.
- Run Prisma migrations prior to starting the server.
- Test authentication and upload flows in staging.
- Monitor PDF generation logs and S3 storage costs.
- Back up database regularly and review retention policies.

[No sources needed since this section provides general guidance]