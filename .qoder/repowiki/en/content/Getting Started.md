# Getting Started

<cite>
**Referenced Files in This Document**
- [README.md](file://README.md)
- [package.json](file://package.json)
- [next.config.ts](file://next.config.ts)
- [tsconfig.json](file://tsconfig.json)
- [eslint.config.mjs](file://eslint.config.mjs)
- [postcss.config.mjs](file://postcss.config.mjs)
- [prisma/schema.prisma](file://prisma/schema.prisma)
- [prisma/seed.ts](file://prisma/seed.ts)
- [src/lib/prisma.ts](file://src/lib/prisma.ts)
- [src/lib/s3.ts](file://src/lib/s3.ts)
- [src/auth.ts](file://src/auth.ts)
- [src/middleware.ts](file://src/middleware.ts)
- [src/lib/constants.ts](file://src/lib/constants.ts)
- [src/lib/editor/constants.ts](file://src/lib/editor/constants.ts)
- [src/lib/editor/schema.ts](file://src/lib/editor/schema.ts)
- [src/lib/editor/validation.ts](file://src/lib/editor/validation.ts)
- [src/lib/pricing/constants.ts](file://src/lib/pricing/constants.ts)
- [src/components/editor/EditorWorkspace.tsx](file://src/components/editor/EditorWorkspace.tsx)
- [src/app/(protected)/create/templates/page.tsx](file://src/app/(protected)/create/templates/page.tsx)
- [src/app/api/submissions/from-template/route.ts](file://src/app/api/submissions/from-template/route.ts)
- [src/app/(admin)/admin/pricing/page.tsx](file://src/app/(admin)/admin/pricing/page.tsx)
- [docs/titchybook-editor-implementation-spec.md](file://docs/titchybook-editor-implementation-spec.md)
</cite>

## Update Summary
**Changes Made**
- Updated comprehensive setup process to reflect new editor workspace, asset management, template system, and pricing engine
- Added detailed sections for editor workspace setup, template system initialization, and pricing configuration
- Enhanced first-run guide with editor features and template gallery
- Expanded environment variable configuration with new pricing and template requirements
- Updated database setup to include new models and relationships

## Table of Contents
1. [Introduction](#introduction)
2. [Prerequisites](#prerequisites)
3. [Installation](#installation)
4. [Development Server Setup](#development-server-setup)
5. [First Run and Feature Exploration](#first-run-and-feature-exploration)
6. [Environment Variables and Configuration](#environment-variables-and-configuration)
7. [Database Setup](#database-setup)
8. [Editor Workspace Setup](#editor-workspace-setup)
9. [Template System Initialization](#template-system-initialization)
10. [Pricing Engine Setup](#pricing-engine-setup)
11. [Asset Management Configuration](#asset-management-configuration)
12. [Common Setup Issues and Troubleshooting](#common-setup-issues-and-troubleshooting)
13. [Project Structure Navigation](#project-structure-navigation)
14. [Conclusion](#conclusion)

## Introduction
Titchybook Creator is a comprehensive Next.js application that enables users to create custom printed books through an advanced editor workspace. The platform features a sophisticated editor with drag-and-drop capabilities, template system, asset management, pricing engine, and order processing. This guide covers the complete setup process including editor workspace configuration, template system initialization, asset management setup, and pricing engine configuration.

## Prerequisites

### Node.js and Package Manager Requirements
- **Node.js**: Compatible with Next.js 16.1.6 and TypeScript; ensure a supported LTS version per your platform's LTS policy
- **Package Managers**: Supports npm, yarn, pnpm, and bun for development scripts
- **TypeScript**: Version 5.x with Next.js App Router support
- **Build Tools**: Tailwind CSS v4 via PostCSS, ESLint for code quality

### Development Dependencies
- Next.js 16.1.6 with App Router
- React 19.2.3 with React DOM
- Prisma Client 5.22.0 for database operations
- NextAuth.js 5.0.0-beta.30 for authentication
- AWS SDK for S3 integration
- OpenAI SDK for AI features
- PDF generation libraries (pdf-lib, sharp)

**Section sources**
- [package.json:1-48](file://package.json#L1-L48)
- [README.md:1-37](file://README.md#L1-L37)

## Installation

### Step 1: Clone and Install Dependencies
1. Clone the repository to your machine
2. Install dependencies using your preferred package manager:
   ```bash
   # npm users
   npm ci
   
   # yarn users  
   yarn install
   
   # pnpm users
   pnpm install
   
   # bun users
   bun install
   ```

### Step 2: Database Migration and Seeding
3. Create and migrate the SQLite database:
   ```bash
   npx prisma migrate dev --name init
   ```
4. Seed the database with initial data:
   ```bash
   npx prisma db seed
   ```
   This creates admin user, pricing configuration, and sample templates.

### Step 3: Environment Configuration
5. Create `.env.local` file with required environment variables:
   ```env
   # Database
   DATABASE_URL="file:./dev.db"
   
   # AWS S3 Configuration
   AWS_REGION="your-region"
   AWS_ACCESS_KEY_ID="your-access-key"
   AWS_SECRET_ACCESS_KEY="your-secret-key"
   S3_BUCKET_NAME="your-bucket-name"
   
   # Optional Admin Credentials
   ADMIN_EMAIL="admin@titchybook.com"
   ADMIN_PASSWORD="admin123456"
   ```

### Step 4: Start Development Server
6. Launch the development server:
   ```bash
   npm run dev
   # or yarn dev, pnpm dev, bun dev
   ```

**Section sources**
- [README.md:5-17](file://README.md#L5-L17)
- [package.json:5-10](file://package.json#L5-L10)
- [prisma/schema.prisma:1-8](file://prisma/schema.prisma#L1-L8)
- [prisma/seed.ts:22-43](file://prisma/seed.ts#L22-L43)

## Development Server Setup

### Starting the Development Server
- Run the development server using your chosen package manager:
  ```bash
  npm run dev
  yarn dev
  pnpm dev
  bun dev
  ```
- Expected output: Terminal displays Next.js starting on port 3000
- Browser automatically opens http://localhost:3000

### Development Features
- Hot reloading for React components
- TypeScript compilation with strict type checking
- ESLint integration for code quality
- Tailwind CSS with PostCSS processing

**Section sources**
- [README.md:5-17](file://README.md#L5-L17)
- [package.json:6](file://package.json#L6)

## First Run and Feature Exploration

### Initial Setup Verification
1. **Admin Account Creation**: The seed script creates an admin user with default credentials
2. **Template Gallery**: Sample templates are pre-populated for immediate use
3. **Pricing Configuration**: Default pricing tiers and shipping zones are established

### Primary Features to Explore
1. **Authentication Flow**:
   - Login with admin credentials
   - Navigate to dashboard and protected routes
   - Access admin panel for order management

2. **Template System**:
   - Browse available templates
   - Create new submissions from templates
   - Customize template elements

3. **Editor Workspace**:
   - Create new drafts from scratch
   - Use drag-and-drop editor
   - Manage assets and layers
   - Save and preview work

4. **Pricing Engine**:
   - Configure shipping zones and rates
   - Set up volume pricing tiers
   - Test order calculations

**Section sources**
- [prisma/seed.ts:338-350](file://prisma/seed.ts#L338-L350)
- [src/app/(protected)/create/templates/page.tsx:14-33](file://src/app/(protected)/create/templates/page.tsx#L14-L33)
- [src/components/editor/EditorWorkspace.tsx:419-457](file://src/components/editor/EditorWorkspace.tsx#L419-L457)

## Environment Variables and Configuration

### Required Environment Variables
| Variable | Purpose | Example |
|----------|---------|---------|
| `DATABASE_URL` | SQLite connection string | `file:./dev.db` |
| `AWS_REGION` | AWS region for S3 | `us-east-1` |
| `AWS_ACCESS_KEY_ID` | AWS access key | `AKIAXXXXXXXXXXXXXXXX` |
| `AWS_SECRET_ACCESS_KEY` | AWS secret key | `XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX` |
| `S3_BUCKET_NAME` | Target S3 bucket | `titchybook-assets` |

### Optional Environment Variables
| Variable | Purpose | Default |
|----------|---------|---------|
| `ADMIN_EMAIL` | Seed admin email | `admin@titchybook.com` |
| `ADMIN_PASSWORD` | Seed admin password | `admin123456` |

### Configuration Notes
- Database URL supports SQLite file paths
- AWS credentials require S3 bucket access permissions
- Environment variables are loaded via dotenv
- Development uses local SQLite database

**Section sources**
- [prisma/schema.prisma:5-8](file://prisma/schema.prisma#L5-L8)
- [src/lib/s3.ts:8-14](file://src/lib/s3.ts#L8-L14)
- [prisma/seed.ts:23-24](file://prisma/seed.ts#L23-L24)

## Database Setup

### Database Schema Overview
The application uses Prisma with SQLite as the default provider. The schema includes several interconnected models:

```mermaid
erDiagram
USER {
string id PK
string email UK
string passwordHash
string role
datetime createdAt
datetime updatedAt
}
ASSET {
string id PK
string userId FK
string s3Key UK
string originalFilename
string mimeType
int width
int height
int fileSize
datetime createdAt
datetime updatedAt
}
SUBMISSION {
string id PK
string userId FK
string mode
string status
string title
boolean isTemplate
string templateId FK
int version
datetime createdAt
datetime updatedAt
}
SUBMISSION_PAGE {
string id PK
string submissionId FK
string pageLabel
int order
string sceneJson
datetime createdAt
datetime updatedAt
}
ORDER {
string id PK
string userId FK
string submissionId FK
int quantity
string zone
int totalHuf
string status
datetime createdAt
datetime updatedAt
}
ASSET ||--o{ USER : "owned_by"
ASSET ||--o{ SUBMISSION_PAGE : "referenced_by"
USER ||--o{ SUBMISSION : "creates"
SUBMISSION ||--o{ SUBMISSION_PAGE : "contains"
SUBMISSION ||--o{ ORDER : "generates"
```

**Diagram sources**
- [prisma/schema.prisma:10-148](file://prisma/schema.prisma#L10-L148)

### Migration Process
1. **Initial Migration**: Creates all database tables with proper constraints
2. **Seed Execution**: Populates database with:
   - Admin user account
   - Pricing configuration
   - Sample templates (Birthday Card, Photo Journal, Minimalist Zine)

### Data Models
- **User**: Authentication and authorization
- **Asset**: Uploaded source images with metadata
- **Submission**: Drafts and final submissions
- **SubmissionPage**: Individual logical pages with editor scenes
- **Order**: Finalized orders with pricing calculations
- **TemplateElement**: Locked template elements for instances

**Section sources**
- [prisma/schema.prisma:10-178](file://prisma/schema.prisma#L10-L178)
- [prisma/seed.ts:338-350](file://prisma/seed.ts#L338-L350)

## Editor Workspace Setup

### Editor Architecture
The editor is built with React and Konva for canvas-based editing:

```mermaid
graph TB
EditorWorkspace["EditorWorkspace.tsx"]
EditorCanvas["EditorCanvas"]
LayerPanel["LayerPanel"]
PropertiesPanel["PropertiesPanel"]
AssetLibrary["AssetLibrary"]
AiChatPanel["AiChatPanel"]
EditorWorkspace --> EditorCanvas
EditorWorkspace --> LayerPanel
EditorWorkspace --> PropertiesPanel
EditorWorkspace --> AssetLibrary
EditorWorkspace --> AiChatPanel
```

**Diagram sources**
- [src/components/editor/EditorWorkspace.tsx:1-50](file://src/components/editor/EditorWorkspace.tsx#L1-L50)

### Key Editor Features
1. **Canvas Editing**: Drag-and-drop elements with precise positioning
2. **Layer Management**: Organize elements with z-index control
3. **Asset Library**: Manage uploaded images and graphics
4. **Template Integration**: Merge template elements with user content
5. **AI Assistance**: Integrated chat for creative suggestions
6. **Auto-save**: Automatic draft saving with undo/redo history

### Editor Configuration
- **Page Dimensions**: 700x1000 pixels (print-safe)
- **Element Limits**: Maximum 100 elements per page
- **Scene Version**: Editor scene schema version 1
- **Safe Margins**: 12px safe zone for print alignment

**Section sources**
- [src/lib/editor/constants.ts:1-21](file://src/lib/editor/constants.ts#L1-L21)
- [src/lib/editor/schema.ts:73-88](file://src/lib/editor/schema.ts#L73-L88)
- [src/lib/editor/validation.ts:16-26](file://src/lib/editor/validation.ts#L16-L26)

## Template System Initialization

### Template Architecture
The template system enables users to create reusable designs:

```mermaid
graph TB
TemplateSystem["Template System"]
Template["Template Submission"]
TemplateElements["Template Elements"]
Instance["Template Instance"]
UserContent["User Content"]
Template --> TemplateElements
Template --> Instance
Instance --> UserContent
Instance --> TemplateElements
```

**Diagram sources**
- [prisma/schema.prisma:150-162](file://prisma/schema.prisma#L150-L162)
- [src/app/api/submissions/from-template/route.ts:32-43](file://src/app/api/submissions/from-template/route.ts#L32-L43)

### Template Creation Process
1. **Template Definition**: Create submissions with `isTemplate: true`
2. **Element Storage**: Store template elements in `TemplateElement` table
3. **Instance Creation**: Users create instances from approved templates
4. **Content Merging**: Template elements become locked background layer

### Pre-configured Templates
The seed script creates three sample templates:
- **Birthday Card**: Celebration-themed design with decorative elements
- **Photo Journal**: Minimalist layout optimized for photos
- **Minimalist Zine**: Clean, modern design with subtle accents

**Section sources**
- [prisma/seed.ts:90-336](file://prisma/seed.ts#L90-L336)
- [src/app/api/submissions/from-template/route.ts:12-100](file://src/app/api/submissions/from-template/route.ts#L12-L100)

## Pricing Engine Setup

### Pricing Architecture
The pricing engine handles complex shipping and calculation logic:

```mermaid
graph TB
PricingEngine["Pricing Engine"]
PricingConfig["PricingConfig"]
WeightBands["Weight Bands"]
ShippingTable["Shipping Table"]
PriceTiers["Price Tiers"]
CurrencyRates["Currency Rates"]
PricingEngine --> PricingConfig
PricingConfig --> WeightBands
PricingConfig --> ShippingTable
PricingConfig --> PriceTiers
PricingConfig --> CurrencyRates
```

**Diagram sources**
- [src/lib/pricing/constants.ts:11-132](file://src/lib/pricing/constants.ts#L11-L132)
- [prisma/schema.prisma:164-177](file://prisma/schema.prisma#L164-L177)

### Pricing Configuration
The seed script establishes default pricing parameters:

#### Shipping Zones
- Hungary (domestic)
- European Union
- United Kingdom
- United States
- Rest of World

#### Weight Bands (grams)
- 50, 100, 250, 500, 1000, 2000

#### Volume Pricing Tiers (HUF per copy)
- 1-8 books: 300 HUF
- 9-40 books: 180 HUF  
- 41-80 books: 120 HUF
- 81-160 books: 90 HUF
- 161+ books: 70 HUF

#### Currency Support
- Hungarian Forint (HUF) - base currency
- Euro (EUR) - 1 HUF = 0.0026 EUR
- British Pound (GBP) - 1 HUF = 0.0022 GBP

### Admin Interface
Access the pricing configuration through the admin panel:
1. Navigate to `/admin/pricing`
2. Modify shipping costs, weight bands, and pricing tiers
3. Update currency exchange rates
4. Test calculations with different scenarios

**Section sources**
- [src/lib/pricing/constants.ts:11-132](file://src/lib/pricing/constants.ts#L11-L132)
- [prisma/seed.ts:45-73](file://prisma/seed.ts#L45-L73)
- [src/app/(admin)/admin/pricing/page.tsx:6-29](file://src/app/(admin)/admin/pricing/page.tsx#L6-L29)

## Asset Management Configuration

### Asset Architecture
The asset management system handles uploaded images and graphics:

```mermaid
graph TB
AssetSystem["Asset System"]
Asset["Asset Model"]
S3Storage["S3 Storage"]
AssetLibrary["Asset Library"]
EditorWorkspace["Editor Workspace"]
Asset --> S3Storage
AssetLibrary --> Asset
EditorWorkspace --> AssetLibrary
```

**Diagram sources**
- [prisma/schema.prisma:88-102](file://prisma/schema.prisma#L88-L102)
- [src/lib/s3.ts:18-36](file://src/lib/s3.ts#L18-L36)

### Asset Features
1. **Upload Management**: Presigned URLs for secure uploads
2. **Metadata Storage**: Width, height, MIME type, and file size
3. **Preview Generation**: Thumbnail and preview URLs
4. **Usage Tracking**: Asset references across submissions
5. **Cleanup**: Automatic cleanup of unused assets

### Upload Process
1. **Presigned URL Generation**: Request upload URL from `/api/assets/presign`
2. **Direct Upload**: Upload file directly to S3 using generated URL
3. **Asset Registration**: Register asset metadata in database
4. **Editor Integration**: Make assets available in editor workspace

### Supported Formats
- JPEG, PNG, WebP images
- Maximum file size: 10MB
- Resolution metadata captured during upload

**Section sources**
- [src/lib/s3.ts:18-36](file://src/lib/s3.ts#L18-L36)
- [src/lib/constants.ts:52-59](file://src/lib/constants.ts#L52-L59)

## Common Setup Issues and Troubleshooting

### Database Connection Issues
**Problem**: Prisma client fails to connect to database
**Solution**: 
1. Verify `DATABASE_URL` points to valid SQLite file
2. Ensure database file has write permissions
3. Run `npx prisma migrate dev --name init` to recreate schema

### AWS Configuration Problems
**Problem**: S3 operations fail with credential errors
**Solution**:
1. Verify AWS credentials are correct and have S3 access
2. Ensure bucket name matches existing S3 bucket
3. Check AWS region matches bucket location
4. Test credentials with AWS CLI

### Template Loading Failures
**Problem**: Templates don't appear in gallery
**Solution**:
1. Verify seed script ran successfully
2. Check template status is `APPROVED`
3. Ensure `isTemplate` flag is set correctly
4. Verify template pages have valid scene data

### Pricing Engine Errors
**Problem**: Pricing calculations incorrect or unavailable
**Solution**:
1. Verify pricing configuration exists in database
2. Check zone definitions match shipping table
3. Ensure weight bands and price tiers are properly formatted
4. Validate currency rates are set correctly

### Editor Not Loading
**Problem**: Editor workspace fails to initialize
**Solution**:
1. Check browser console for JavaScript errors
2. Verify Next.js server is running on port 3000
3. Ensure all required environment variables are set
4. Clear browser cache and reload page

**Section sources**
- [prisma/schema.prisma:5-8](file://prisma/schema.prisma#L5-L8)
- [src/lib/s3.ts:8-14](file://src/lib/s3.ts#L8-L14)
- [prisma/seed.ts:75-88](file://prisma/seed.ts#L75-L88)
- [src/app/api/submissions/from-template/route.ts:38-43](file://src/app/api/submissions/from-template/route.ts#L38-L43)

## Project Structure Navigation

### Key Directories and Files
```
titchybook-app/
├── src/
│   ├── app/                    # Next.js App Router pages
│   │   ├── (protected)/create/  # Editor and template pages
│   │   ├── (admin)/admin/      # Admin panel
│   │   └── (auth)/             # Authentication pages
│   ├── components/             # Reusable React components
│   │   ├── editor/             # Editor workspace components
│   │   ├── admin/              # Admin interface components
│   │   └── auth/               # Authentication forms
│   ├── lib/                    # Shared libraries
│   │   ├── editor/             # Editor utilities and schemas
│   │   ├── pricing/            # Pricing engine logic
│   │   └── constants.ts        # Shared constants
│   └── types/                  # TypeScript type definitions
├── prisma/                     # Database schema and seed
├── public/                     # Static assets
└── docs/                       # Documentation
```

### Important Configuration Files
- **next.config.ts**: Next.js build configuration
- **tsconfig.json**: TypeScript compiler options
- **eslint.config.mjs**: Code quality rules
- **postcss.config.mjs**: Tailwind CSS processing
- **prisma/schema.prisma**: Database schema definition

**Section sources**
- [next.config.ts:1-8](file://next.config.ts#L1-L8)
- [tsconfig.json:1-35](file://tsconfig.json#L1-L35)
- [eslint.config.mjs:1-19](file://eslint.config.mjs#L1-L19)
- [postcss.config.mjs:1-8](file://postcss.config.mjs#L1-L8)

## Conclusion

You now have the complete setup for Titchybook Creator with all major systems configured. The platform includes:

- **Advanced Editor Workspace**: Canvas-based editing with drag-and-drop functionality
- **Template System**: Reusable designs with locked background elements
- **Asset Management**: Secure upload and management of source images
- **Pricing Engine**: Comprehensive shipping and volume pricing calculations
- **Order Processing**: Complete workflow from draft to finalized order

Key next steps:
1. Explore the editor workspace and create your first draft
2. Browse and customize available templates
3. Test the pricing engine with different scenarios
4. Experiment with asset management and AI assistance features

For ongoing development, refer to the comprehensive documentation in `docs/titchybook-editor-implementation-spec.md` for detailed technical specifications and implementation guidelines.