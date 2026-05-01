# Titchybook Creator - Implementation Plan

## Context

Build a greenfield web application that lets users create printable 8-page micro booklets (Titchybooks) from uploaded images. The system accepts 8 images, arranges them into a precise A4 landscape imposition layout, generates a print-ready PDF, and gates download behind admin approval. The project directory (`c:\Users\Dell\titchybook-app`) is currently empty.

## Technology Stack

| Layer | Choice |
|---|---|
| Framework | Next.js 14+ (App Router) + TypeScript |
| Styling | Tailwind CSS |
| Database | SQLite + Prisma ORM |
| Auth | NextAuth v5 (Auth.js) - email/password credentials |
| File Storage | AWS S3 (or S3-compatible) via AWS SDK v3 |
| PDF Generation | pdf-lib (coordinate-based placement) |
| Image Processing | sharp (resize/crop/rotate) |
| Validation | zod |

## Project Structure

```
titchybook-app/
├── prisma/
│   ├── schema.prisma
│   └── seed.ts                    # Creates initial admin user
├── src/
│   ├── app/
│   │   ├── layout.tsx             # Root layout + providers
│   │   ├── page.tsx               # Landing page
│   │   ├── globals.css
│   │   ├── (auth)/
│   │   │   ├── login/page.tsx
│   │   │   └── register/page.tsx
│   │   ├── (protected)/
│   │   │   ├── layout.tsx         # Auth guard
│   │   │   ├── dashboard/page.tsx # User submissions list
│   │   │   └── create/page.tsx    # 8-image upload + submit
│   │   ├── (admin)/
│   │   │   ├── layout.tsx         # Admin guard
│   │   │   └── admin/page.tsx     # Admin dashboard
│   │   └── api/
│   │       ├── auth/[...nextauth]/route.ts
│   │       ├── register/route.ts
│   │       ├── upload/presign/route.ts
│   │       ├── submissions/route.ts
│   │       ├── submissions/[id]/route.ts
│   │       ├── submissions/[id]/pdf/route.ts
│   │       └── admin/submissions/route.ts
│   │           └── [id]/route.ts
│   ├── auth.ts                    # NextAuth config
│   ├── middleware.ts              # Route protection
│   ├── lib/
│   │   ├── prisma.ts             # Singleton Prisma client
│   │   ├── s3.ts                 # S3 client + presign helpers
│   │   ├── pdf/
│   │   │   ├── generate.ts       # PDF composition orchestrator
│   │   │   ├── layout.ts         # Panel coordinates + constants
│   │   │   └── image-processor.ts # Sharp resize/crop/rotate
│   │   └── constants.ts
│   ├── components/
│   │   ├── ui/                   # Button, Card, Input, Badge, etc.
│   │   ├── auth/                 # LoginForm, RegisterForm
│   │   ├── create/               # ImageUploader, UploadGrid
│   │   ├── submissions/          # SubmissionCard, SubmissionList, StatusBadge
│   │   ├── admin/                # AdminSubmissionTable, ActionButtons, PdfPreviewModal
│   │   └── layout/               # Header, Footer
│   └── types/
│       └── index.ts              # Shared types + NextAuth augmentation
├── .env.example
├── next.config.ts
├── tailwind.config.ts
└── package.json
```

## Database Schema (Prisma)

```prisma
enum Role { USER  ADMIN }
enum SubmissionStatus { PENDING  APPROVED  REJECTED }

model User {
  id           String       @id @default(cuid())
  email        String       @unique
  passwordHash String
  name         String?
  role         Role         @default(USER)
  submissions  Submission[]
  createdAt    DateTime     @default(now())
  updatedAt    DateTime     @updatedAt
}

model Submission {
  id              String           @id @default(cuid())
  userId          String
  user            User             @relation(fields: [userId], references: [id])
  status          SubmissionStatus @default(PENDING)
  pdfS3Key        String?
  rejectionReason String?
  images          SubmissionImage[]
  createdAt       DateTime         @default(now())
  updatedAt       DateTime         @updatedAt
}

model SubmissionImage {
  id               String     @id @default(cuid())
  submissionId     String
  submission       Submission @relation(fields: [submissionId], references: [id])
  pageLabel        String     // FRONT_COVER, BACK_COVER, PAGE_2..PAGE_7
  s3Key            String
  order            Int        // 0-7
  originalFilename String
  mimeType         String
  createdAt        DateTime   @default(now())
}
```

## API Design

| Endpoint | Method | Auth | Purpose |
|---|---|---|---|
| `/api/auth/[...nextauth]` | * | Public | NextAuth handlers |
| `/api/register` | POST | Public | User registration (hash pw, create user) |
| `/api/upload/presign` | GET | User | Generate S3 presigned PUT URL |
| `/api/submissions` | GET | User | List current user's submissions |
| `/api/submissions` | POST | User | Create submission (8 images metadata) + trigger PDF gen |
| `/api/submissions/[id]` | GET | User | Get submission detail + presigned PDF download URL |
| `/api/admin/submissions` | GET | Admin | List all submissions |
| `/api/admin/submissions/[id]` | PATCH | Admin | Approve or reject a submission |

## PDF Generation Logic (Critical Path)

### Panel Coordinates (mm) - from spec

**Top Row (upright):**
| Panel | X | Y | Width | Height |
|---|---|---|---|---|
| Back Cover | 3.9 | 3.6 | 67.5 | 91.3 |
| Front Cover | 77.4 | 3.6 | 69.3 | 98 |
| Page 2 | 151.5 | 3.6 | 69.6 | 98.2 |
| Page 3 | 225.5 | 3.7 | 68.4 | 98.2 |

**Bottom Row (rotated 180deg):**
| Panel | X | Y | Width | Height |
|---|---|---|---|---|
| Page 4 | 224.8 | 108.5 | 68.3 | 98 |
| Page 5 | 151.6 | 108.5 | 68.5 | 98 |
| Page 6 | 77.4 | 108.5 | 69 | 97.9 |
| Page 7 | 3.9 | 108.5 | 66.6 | 98.1 |

### Processing Pipeline

1. **Download** all 8 images from S3 in parallel
2. **For each image**, use sharp to:
   - Resize to fill panel at 300 DPI: `targetPx = panelMm / 25.4 * 300`
   - `sharp.resize(w, h, { fit: 'cover', position: 'centre' })` - fills + center crops
   - For bottom-row panels (Pages 4-7): `.rotate(180)` in sharp before embedding
   - Output as PNG
3. **Create PDF** with pdf-lib:
   - Page size: A4 landscape `[mmToPoints(297), mmToPoints(210)]`
   - Convert mm to points: `mm * 72 / 25.4`
   - Coordinate flip (spec uses top-left origin, pdf-lib uses bottom-left): `pdfY = 210 - specY - panelHeight`
   - Embed each PNG and draw at converted coordinates
4. **Upload** generated PDF to S3 at `pdfs/{userId}/{submissionId}/titchybook.pdf`
5. **Update** submission record with `pdfS3Key`

### Key Design Decision: Rotation

Bottom-row images are pre-rotated 180deg using sharp before embedding in the PDF. This avoids complex PDF transformation matrices and keeps pdf-lib drawing logic uniform for all 8 panels.

## S3 Architecture

```
Browser ──GET presign──> Next.js API ──presign──> AWS S3
Browser ──PUT file──────────────────────────────> AWS S3 (direct upload)
Next.js API ──GET object──> AWS S3 (for PDF generation)
Next.js API ──PUT PDF─────> AWS S3 (store generated PDF)
Browser <──presigned download URL── Next.js API (for viewing/downloading)
```

Bucket structure: `uploads/{userId}/{submissionId}/{pageLabel}.{ext}` and `pdfs/{userId}/{submissionId}/titchybook.pdf`

## Auth Flow

- **NextAuth v5** with Credentials provider (email/password)
- JWT session strategy - `role` and `id` injected via callbacks
- `/api/register` route handles user creation (bcryptjs hash)
- `middleware.ts` protects `/dashboard`, `/create` (require auth) and `/admin` (require ADMIN role)
- Seed script creates initial admin user from env vars

## Implementation Order

### Phase 1: Project Bootstrap
1. Scaffold Next.js app with TypeScript + Tailwind
2. Install all dependencies (prisma, next-auth, aws-sdk, pdf-lib, sharp, zod, bcryptjs)
3. Create `.env.example` and `.env`
4. Initialize Prisma with SQLite, write schema, run migration

### Phase 2: Auth
5. Configure NextAuth v5 with Credentials provider in `src/auth.ts`
6. Create `[...nextauth]` route handler and middleware
7. Build `/api/register` route
8. Build login/register pages with forms
9. Build auth-aware Header component
10. Create seed script for admin user

### Phase 3: S3 + Upload
11. Create `src/lib/s3.ts` with presign/download/upload helpers
12. Build `/api/upload/presign` route
13. Build `ImageUploader` component (drag-drop + file input, direct S3 upload)
14. Build `UploadGrid` (8 labeled slots) and `/create` page

### Phase 4: Submissions + PDF Generation
15. Build `src/lib/pdf/layout.ts` - panel coordinate constants
16. Build `src/lib/pdf/image-processor.ts` - sharp resize/crop/rotate
17. Build `src/lib/pdf/generate.ts` - PDF composition orchestrator
18. Build `POST /api/submissions` - create submission + trigger PDF generation
19. Build `GET /api/submissions` and `GET /api/submissions/[id]`

### Phase 5: Dashboards
20. Build user dashboard - SubmissionCard, SubmissionList, StatusBadge
21. Build `/dashboard` page (server component fetches submissions)
22. Build admin API routes (GET all submissions, PATCH approve/reject)
23. Build admin dashboard - AdminSubmissionTable, ActionButtons, PdfPreviewModal
24. Build `/admin` page

### Phase 6: Polish
25. Add toast notifications for feedback
26. Loading states and error boundaries
27. End-to-end testing of full flow

## Verification Plan

1. **Auth**: Register a user, log in, verify session, verify middleware redirects
2. **Upload**: Upload 8 images from `/create`, verify they land in S3 (check via presigned URLs)
3. **PDF Generation**: Submit a booklet, verify PDF is generated and uploaded to S3, download and inspect layout coordinates/rotation manually
4. **Admin Flow**: Log in as admin, view submissions list, preview PDF, approve/reject, verify user dashboard reflects status change
5. **Download**: As approved user, verify "Download PDF" produces correct presigned URL and the PDF downloads
6. **Build**: Run `npm run build` to verify no TypeScript or build errors
7. **Lint**: Run `npm run lint` to verify code quality

## Environment Variables

```
DATABASE_URL="file:./dev.db"
NEXTAUTH_SECRET="<random-string>"
NEXTAUTH_URL="http://localhost:3000"
AWS_REGION="eu-west-1"
AWS_ACCESS_KEY_ID="<key>"
AWS_SECRET_ACCESS_KEY="<secret>"
S3_BUCKET_NAME="titchybook-uploads"
ADMIN_EMAIL="admin@titchybook.com"
ADMIN_PASSWORD="<initial-password>"
```
