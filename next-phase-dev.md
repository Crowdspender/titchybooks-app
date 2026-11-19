# TITCHYBOOKS — SONUS MASTER DEVELOPMENT BRIEF

**Project:** Titchybooks Publishing, Marketplace & Sponsorship Platform  
**Development environment:** Existing Titchybooks application  
**AI development agent:** Qoder Sonus  
**Development approach:** Mandatory read-only audit followed by six controlled implementation stages.

---

# 1. PROJECT VISION

## 1.1 What we're building

Titchybooks is evolving from a personal booklet creation and print-ordering application into an open publishing, retail, sponsorship and distribution platform.

The platform will allow anyone to create and publish small printed publications, sell physical copies and downloadable print-ready PDFs, earn royalties from sales, and participate in a sponsorship marketplace.

Businesses will be able to sponsor publications, gain advertising exposure through printed content, select charity and business placements, and arrange distribution through participating physical outlets.

The platform should ultimately support an ecosystem of:

- Independent authors and creators.
- Readers and customers.
- Businesses and sponsors.
- Charities and community organisations.
- Shops, cafés, hotels and distribution partners.
- Titchybooks administrators and production operators.

The commercial philosophy is that useful, entertaining and educational printed media can provide an alternative to increasingly crowded digital advertising channels.

**Brand positioning: Titchybooks — Make Printed Media Great Again.**

## 1.2 Core commercial objectives

Build infrastructure supporting five revenue opportunities:

1. Physical book sales.
2. Digital PDF sales.
3. Author and creator subscriptions (future phase).
4. Sponsored publication campaigns.
5. Sponsorship placements and distribution partnerships.

The platform should be designed to accommodate substantial catalogue growth and multiple commercial relationships without requiring Titchybooks to create all the publications itself.

## 1.3 Critical development principles

- Preserve existing working functionality.
- Reuse existing components and services wherever practical.
- Avoid unnecessary technology changes.
- Build modularly rather than introducing one large interconnected feature.
- Maintain a single source of truth for book, order and financial data.
- Use secure payment and download processes.
- Make financial transactions auditable.
- Support future integrations with Outernet.
- Avoid hardcoding commercial rates that should be configurable.
- Implement changes through incremental database migrations.
- Do not remove existing customer, book or order records.

---

# 2. MANDATORY PHASE 0 — READ-ONLY TECHNICAL AUDIT

**This phase must be completed before any implementation work begins.**

Sonus must initially operate in read-only inspection mode.

No source files, database records, schema, configuration, environment variables or production settings may be changed during this phase.

Do not generate migrations, install packages, modify dependencies or automatically fix problems discovered during the audit.

## 2.1 Inspect the complete application

Identify and document:

### Application architecture
- Frontend framework and version.
- Backend framework and architecture.
- Programming languages.
- Hosting and deployment environment.
- Database technology and current schema.
- Authentication and authorisation system.
- File storage infrastructure.
- Existing API architecture.
- Third-party integrations.
- Background processing and scheduled jobs, if present.
- Existing testing infrastructure.
- Development, staging and production environments.

Do not assume the current application uses the technology stack of any previous Titchybooks or WordPress project.

The live application is the authoritative source.

### Existing user functionality

Inspect the complete journey:

1. User registration and login.
2. User dashboard.
3. New book creation.
4. Book editing.
5. PDF generation.
6. Book submission for approval.
7. Administrator approval.
8. Approved book management.
9. Order prints functionality.
10. Quantity selection.
11. Print cost calculation.
12. Shipping destination selection.
13. Currency selection and conversion.
14. Stripe payment integration.
15. Order administration.
16. Existing Titchybook Vault functionality, if implemented.

Document which components are working, incomplete or problematic.

### Existing book and PDF architecture

Establish:

- How book records are stored.
- How ownership is established.
- How approval status is recorded.
- How PDF files are generated.
- Where original and generated PDFs are stored.
- Whether PDF versions are retained.
- Whether a PDF can be regenerated.
- Whether an existing PDF can be downloaded securely.
- How the application determines that a book is print-ready.
- Whether existing files can be reused for future sales without regenerating them.

### Existing commerce infrastructure

Inspect the current order page and all related backend services.

The existing interface includes:

- Quantity selector.
- Quantity shortcuts.
- Print price calculation.
- Shipping destination.
- Display currency.
- Shipping cost.
- Total cost.
- Cost per book.
- Shipment weight.
- Stripe payment integration.
- Order review and administration.

Document the actual calculation logic, pricing rules, supported destinations, currency conversion and payment workflow.

Preserve existing functionality wherever possible.

### Database audit

Produce a complete schema inventory including:

- Tables.
- Columns.
- Relationships.
- Primary and foreign keys.
- Indexes.
- Constraints.
- Existing status fields.
- Row-level security or equivalent access policies, if applicable.
- Existing financial and order records.

Identify which existing tables can be extended and which new tables are necessary.

Do not create duplicate functionality or duplicate book/order records.

## 2.2 Audit deliverables

Create the following documents:

1. `CURRENT_ARCHITECTURE.md`
2. `DATABASE_SCHEMA_AUDIT.md`
3. `EXISTING_WORKFLOWS.md`
4. `PAYMENT_AND_PRINTING_AUDIT.md`
5. `PROPOSED_ARCHITECTURE.md`
6. `DATABASE_MIGRATION_PLAN.md`
7. `IMPLEMENTATION_ROADMAP.md`
8. `RISKS_AND_DEPENDENCIES.md`

The proposed architecture must include a diagram of the relationships between publications, editions, orders, authors, sponsors, campaigns, distribution partners and financial records.

## 2.3 Architecture approval gate

After completing the audit:

STOP.

Present a concise but sufficiently detailed report covering:

- Current application architecture.
- Existing functionality that will be reused.
- Existing functionality requiring modification.
- Proposed new functionality.
- Proposed database changes.
- Security and financial considerations.
- Migration risks.
- Recommended implementation order.
- Estimated development complexity.

Do not begin implementation until the audit and proposed architecture have been reviewed and explicitly approved.

---

# 3. IMPLEMENTATION STAGE 1 — OPEN PUBLISHING MARKETPLACE

## Objective

Transform existing approved Titchybooks into independently publishable products that can be discovered and purchased by the general public.

The creator must retain ownership of their publication while allowing Titchybooks to list and sell it under an agreed publishing licence.

## 3.1 Publication lifecycle

Introduce or extend the publication workflow:

1. Creator creates a book.
2. Creator submits it for approval.
3. Administrator reviews the submission.
4. Approved book becomes eligible for publication.
5. Creator chooses whether to list it publicly.
6. Creator configures commercial availability.
7. Book appears in the public marketplace.

Approval and publication must be separate statuses.

An approved book is not automatically publicly available.

## 3.2 Publication management

Each publication should support:

- Book title.
- Subtitle.
- Author/creator.
- Description.
- Cover image.
- Preview images or sample pages.
- Categories.
- Search tags.
- Language.
- Publication status.
- Approval status.
- Public visibility.
- Digital sales availability.
- Physical sales availability.
- Sponsorship eligibility.
- Retail pricing.
- Author commission settings.
- Publication version.
- Creation and modification dates.

The administrator must retain the ability to approve, reject, suspend, unpublish or remove a listing.

Suspending a listing must not destroy its historic sales records.

## 3.3 Public shop

Create a public-facing bookshop.

Visitors must be able to browse without registering.

Include:

- Featured publications.
- New releases.
- Popular publications, based on actual sales.
- Categories.
- Search.
- Filters.
- Book detail pages.
- Author information.
- Sample previews.

Suggested initial categories:

- Entertainment.
- Education.
- Children and families.
- Hobbies and interests.
- Food and cooking.
- Travel and tourism.
- Home and garden.
- Technology.
- Local guides.
- Business and professional.

Categories should be manageable by administrators.

## 3.4 Author profiles

Allow creators to have public author profiles.

Profiles can include:

- Display name.
- Biography.
- Profile image.
- Published publications.
- Author website or portfolio, subject to approval.

Protect personal account information.

Do not expose private email addresses or account identifiers.

## 3.5 Publishing rights

The platform must record that the author retains copyright while granting Titchybooks the necessary licence to list, market, sell and print the publication.

The publishing agreement must define the permitted uses and author responsibilities.

The author must confirm they have the necessary rights to all submitted content, images and other materials.

## Acceptance criteria

- Existing approved books can be listed without being recreated.
- Authors can independently manage their public listings.
- Visitors can browse and preview publications.
- Administrators retain approval control.
- Existing private books remain private.
- Publication ownership is preserved.
- Existing book creation and editing functionality continues to work.

---

# 4. IMPLEMENTATION STAGE 2 — COMMERCE, CHECKOUT AND DIGITAL PRODUCTS

## Objective

Expand the existing print-ordering system into a unified shopping and purchasing platform.

Customers must be able to buy multiple publications, in multiple formats, in one transaction.

## 4.1 Two product formats

Every eligible publication can offer two purchase options.

### A. Printed copies

Customers can:

- Purchase one or more copies.
- Select quantity.
- Select delivery country.
- View applicable shipping charges.
- View the total price.
- Choose supported display currencies.
- Complete payment.
- Receive order confirmation and fulfilment updates.

Reuse the existing print pricing, quantity discount, shipping and Stripe infrastructure.

Do not replace working calculation logic without demonstrating a clear technical reason.

The existing print ordering interface is the starting point.

### B. Downloadable PDF

Customers can purchase a one-off digital licence.

After successful payment:

- The customer receives access to the purchased PDF.
- A download link is provided through the confirmation page and/or account.
- The purchase is recorded.
- The downloaded file is the approved print-ready master.
- The customer can access their purchased downloads again through their account, subject to the licence.

PDF files must not be publicly accessible through predictable storage URLs.

Use secure storage and appropriate signed download links.

The standard digital licence should permit personal printing and folding, but not commercial resale or unauthorised redistribution of the master PDF.

Allow the administrator to manage licence terms.

### C. Mixed-format purchasing

The basket must support different publications and purchase formats.

Example:

| Publication | Format | Quantity |
|---|---|---:|
| The Pocket Gardener | Printed | 3 |
| Love Balaton | Printed | 2 |
| The Pub Quiz Book | PDF | 1 |

A single checkout should handle all three.

Physical and digital order items must be distinguishable.

Shipping should apply only to physical items.

Digital downloads should not affect parcel weight or shipping calculations.

## 4.2 Shopping basket

Implement:

- Add to basket.
- Remove from basket.
- Change quantity.
- Change format where applicable.
- Display item prices.
- Calculate subtotals.
- Calculate physical shipping.
- Display discounts.
- Display final total.
- Proceed to checkout.

Support guest checkout where practical, but require an identifiable customer account or verified email for secure digital delivery.

Do not allow a user to purchase their own publication solely to generate an author commission without appropriate controls.

## 4.3 Payment integration

Reuse the existing Stripe integration where possible.

Requirements:

- Server-side price validation.
- Server-side order creation.
- Secure payment processing.
- Stripe webhook verification.
- Idempotent payment processing.
- Correct handling of failed and abandoned payments.
- Correct handling of refunds.
- Order confirmation.
- Digital download entitlement creation.
- Physical fulfilment records.

Never rely solely on a browser redirect to confirm payment.

## 4.4 Order management

The administrator must be able to see:

- Customer.
- Order reference.
- Order date.
- Purchased publications.
- Product formats.
- Quantities.
- Payment status.
- Print status.
- Shipping status.
- Download status.
- Total paid.
- Applicable commissions.

A mixed order must have a coherent overall status while retaining separate fulfilment status for each order item.

## 4.5 Pricing and currency

Preserve the existing pricing architecture and its HUF-based calculations and exchange-rate conversion, if confirmed by the audit.

Do not introduce inconsistent independent pricing calculations for the shop and existing print-order page.

All financial calculations must be performed and validated server-side.

Prices and exchange rates used at purchase must be retained in the transaction record.

## Acceptance criteria

- Customers can purchase books they did not create.
- Multiple books can be purchased in one basket.
- Printed and digital products can be purchased together.
- Shipping excludes digital products.
- Digital PDFs are securely delivered.
- Stripe payments are correctly reconciled.
- Existing print-order functionality continues to work.
- Customers can view their order history.

---

# 5. IMPLEMENTATION STAGE 3 — AUTHOR COMMISSIONS AND EARNINGS

## Objective

Introduce a transparent creator earnings system.

Authors receive an agreed commission for each eligible copy sold through Titchybooks.

## 5.1 Commission model

Use configurable fixed per-copy commissions as the initial model.

Each publication can have separate commission settings for:

- Printed copies.
- PDF purchases.

Illustrative example:

| Product | Author commission |
|---|---:|
| Printed copy | 50 HUF |
| PDF purchase | 150 HUF |

These are example values only.

Administrators must be able to configure commission rates.

Commission rates should be stored in a way that supports future percentage-based arrangements and campaign-specific royalties.

## 5.2 Transaction ledger

Build an auditable royalty ledger.

Every qualifying transaction should create a royalty entry.

Record:

- Author.
- Publication.
- Order.
- Order item.
- Product format.
- Quantity.
- Commission rate.
- Commission amount.
- Currency.
- Exchange-rate information where applicable.
- Transaction date.
- Eligibility status.
- Payment status.

The commission rate and calculated amount must be snapshotted when the transaction is created.

Future commission changes must not alter previous transactions.

## 5.3 Commission eligibility

Recommended rules:

- Physical commissions become payable after successful fulfilment.
- PDF commissions become payable after successful payment and digital entitlement creation.
- Cancelled transactions do not earn commissions.
- Refunds create corresponding negative adjustments.
- Duplicate payment events must not create duplicate royalties.
- Self-purchases must be subject to anti-abuse rules.
- Sponsored editions follow their separately agreed campaign royalty arrangements.

Do not delete historical ledger entries.

Use adjustment entries to correct previous transactions.

## 5.4 Creator earnings dashboard

Create a dedicated earnings section.

Display:

- Lifetime earnings.
- Pending earnings.
- Available balance.
- Paid earnings.
- Reversed earnings.
- Sales by publication.
- Sales by format.
- Sales history.
- Commission history.
- Payout history.

Allow date filtering and CSV export.

## 5.5 Payout administration

Initially support administrator-managed payouts.

Administrators must be able to:

- View eligible creator balances.
- Review payout requests.
- Record manual bank transfers.
- Record payment references.
- Mark payouts as paid.
- Generate payout reports.

Support configurable minimum payout thresholds.

Keep payout records linked to the individual royalty entries they settle.

Do not introduce automated marketplace payouts until the underlying accounting has been tested.

Design the system so Stripe Connect or another supported payout provider can be introduced later.

## 5.6 Tax and compliance considerations

The system must accommodate the collection of relevant author payment and invoicing information.

Do not assume all authors have the same tax status or reside in the same country.

Flag unresolved legal, VAT, tax and invoicing requirements for review before commercial launch.

## Acceptance criteria

- Each qualifying sale generates exactly one commission.
- Commissions are correctly associated with the author.
- Authors cannot access other authors' financial records.
- Refunds and cancellations are accounted for.
- Administrators can reconcile and settle balances.
- Historical transactions remain immutable and auditable.

---

# 6. IMPLEMENTATION STAGE 4 — SPONSORSHIP MARKETPLACE

## Objective

Create a commercial sponsorship system that connects businesses with approved publications and allows them to finance sponsored print runs.

A sponsorship is a distinct commercial campaign, not simply an advertising field attached to an ordinary book listing.

## 6.1 Sponsor accounts

Introduce sponsor/business profiles.

Include:

- Business name.
- Contact person.
- Contact details.
- Business website.
- Logo.
- Business description.
- Industry/category.
- Billing details.
- Account status.
- Campaign history.

Businesses must be approved before becoming active sponsors.

## 6.2 Sponsor marketplace

Create a sponsor-facing catalogue of publications eligible for sponsorship.

Allow sponsors to:

- Browse publications.
- Search by subject.
- Filter by target audience.
- View previews.
- View author information.
- View suggested sponsor categories.
- Request sponsorship.
- Submit campaign enquiries.

Authors should be able to suggest potential sponsors for their own publications.

Titchybooks administrators must be able to manage sponsor enquiries and approve campaign proposals.

## 6.3 Sponsorship campaign

A campaign should contain:

- Campaign reference.
- Sponsor.
- Original publication.
- Publication version.
- Agreed quantity.
- Campaign budget.
- Sponsorship price.
- Author royalty arrangement.
- Production costs.
- Distribution plan.
- Selected back-page panels.
- Artwork and branding.
- Approval status.
- Payment status.
- Production status.
- Campaign dates.
- Final edition reference.

Support multiple campaigns using the same original publication.

## 6.4 Sponsored editions

This is a fundamental architectural requirement.

Never overwrite or modify the original author's approved publication when creating a sponsored version.

Each sponsored edition must have its own identity.

It should reference:

- Original publication.
- Original approved version.
- Sponsor.
- Campaign.
- Sponsor-specific artwork.
- Eight back-page panels.
- Final generated print-ready PDF.
- Production run.
- Distribution allocations.

Different sponsors must be able to sponsor different editions of the same publication.

Example:

The Pocket Gardener:

- Edition A: Hungarian garden centre sponsorship.
- Edition B: UK gardening retailer sponsorship.
- Edition C: Seed supplier sponsorship.

The editorial content can remain identical while sponsorship and distribution details change.

## 6.5 The eight back-page panels

The folded Titchybook format has eight additional back-page sections available for commercial and community use.

These must become configurable campaign inventory.

Supported panel types:

1. Charity.
2. Distribution outlet.
3. Author/creator promotion.
4. Additional sponsor.
5. Community organisation.

The system must support flexible allocation of all eight panels.

Examples:

- 8 charities.
- 4 charities and 4 outlets.
- 3 charities, 3 outlets, 1 creator and 1 sponsor.
- Other approved combinations.

Each panel should support:

- Panel type.
- Heading.
- Short description.
- Logo or image, where appropriate.
- QR code destination.
- Website or contact details.
- Approval status.
- Final artwork.

### Charity panels

Maintain an approved charity directory.

Charity records should include:

- Organisation name.
- Description.
- Website.
- Donation URL.
- Logo.
- Verification status.
- Contact information.
- Permission to use its identity and materials.

Each charity panel should introduce the organisation and provide a QR code linking to its approved donation destination.

Charity placement fees must be distinguishable from actual charitable donations.

Do not claim that placement fees are donations unless an explicit donation arrangement exists.

### Distribution outlet panels

An outlet featured in a sponsored edition provides an agreed distribution service.

Its panel can contain:

- Business name.
- Short description.
- Location.
- Website.
- QR code.
- Optional offer.

### Creator panels

Allow the author to promote their own:

- Applications.
- SaaS products.
- Websites.
- Services.
- Portfolio.
- Other approved projects.

This is a valuable creator marketing benefit.

### Panel capacity

There must be exactly eight available panel positions per sponsored edition.

The administrator must be able to see which are allocated, reserved, awaiting approval or vacant.

Prevent accidental double allocation.

## 6.6 Sponsorship economics

Create a configurable sponsorship pricing engine.

Potential components:

- Base sponsorship fee.
- Quantity-based pricing.
- Additional panel placements.
- Premium placement fees.
- Production costs.
- Distribution charges.
- Author sponsorship royalty.
- Charity placement fees.
- Titchybooks margin.

Do not hardcode commercial prices or assume a particular commission percentage.

Allow administrators to configure the commercial model.

Provide an internal campaign quotation screen showing the full financial breakdown.

The campaign should not proceed to production until its commercial terms and payment arrangements are approved.

## 6.7 Sponsor approval and production

Implement a controlled workflow:

Draft ? Submitted ? Under review ? Quoted ? Approved ? Awaiting payment ? Paid ? Artwork approved ? Production ready ? Printing ? Dispatched ? Completed.

Allow appropriate rejection, cancellation and revision states.

The administrator must have control over final campaign approval.

## Acceptance criteria

- Sponsors can discover eligible publications.
- Sponsors can submit campaign enquiries.
- Administrators can create and manage campaigns.
- The same book can have multiple sponsored editions.
- Original publications remain unchanged.
- Eight panel positions are independently managed.
- Panel artwork can be approved before production.
- Campaign finances are calculated and recorded.
- Final campaign PDFs are associated with their specific editions.

---

# 7. IMPLEMENTATION STAGE 5 — DISTRIBUTION NETWORK AND TRACKING

## Objective

Create a network of participating businesses and locations that distribute free sponsored Titchybooks.

Potential outlets:

- Shops.
- Cafés.
- Restaurants.
- Hotels.
- Guesthouses.
- Campsites.
- Tourist attractions.
- Libraries.
- Garden centres.
- Visitor centres.
- Outernet Cafes.

The basic proposition:

A business receives a stack of free sponsored publications to display and distribute.

In exchange, it can receive a back-page promotional placement in that particular sponsored edition.

## 7.1 Distribution outlet profiles

Create a reusable outlet directory.

Each outlet should have:

- Business name.
- Contact information.
- Address.
- Location coordinates where available.
- Website.
- Business category.
- Distribution capacity.
- Preferred subjects.
- Approval status.
- Campaign participation history.

An outlet must not automatically receive promotional placement rights for every campaign.

The placement must be explicitly agreed and allocated to a particular edition.

## 7.2 Campaign distribution allocation

For each campaign, record:

- Participating outlet.
- Allocated quantity.
- Dispatch quantity.
- Dispatch date.
- Delivery status.
- Replenishment requests.
- Remaining stock, where reported.
- Distribution completion.

Support campaigns distributed through multiple outlets.

Example:

| Outlet | Copies |
|---|---:|
| Outernet Cafe | 100 |
| Balaton Guesthouse | 100 |
| Garden Centre | 150 |
| Tourist Information | 150 |
| Total | 500 |

## 7.3 Outlet portal

Provide an outlet-facing interface where approved partners can:

- View their current campaigns.
- See allocated quantities.
- Request additional copies.
- Report low stock.
- Update contact details.
- View campaign information.

Keep this interface simple.

An outlet should not need to understand the full Titchybooks publishing or sponsorship system.

## 7.4 QR tracking

Generate unique tracking URLs and QR codes for relevant campaign panels.

Track:

- Publication.
- Campaign.
- Sponsored edition.
- Panel.
- Charity or business.
- Distribution outlet, where applicable.
- Scan date.
- Anonymous engagement data.

Provide campaign-level reporting.

Support outbound redirection to the intended destination.

Avoid collecting unnecessary personal information.

QR scan counts must be treated as engagement metrics, not proof of purchases or donations.

Where possible, support campaign-specific promotional codes and conversion tracking.

## 7.5 Outernet integration readiness

Design the distribution architecture so it can later integrate with Outernet.

Potential future functionality:

- Outernet Cafe directory integration.
- Map display of participating outlets.
- Titchybook availability indicators.
- Cafe-specific book collections.
- Monthly Titchybook of the Month.
- Local publications and community editions.

Do not make Outernet a hard dependency for the initial distribution implementation.

The Titchybooks distribution system must function independently.

## Acceptance criteria

- Administrators can register and approve outlets.
- Campaigns can allocate stock across multiple outlets.
- Outlet promotional placements are recorded.
- Outlets can request replenishment.
- Unique QR tracking works.
- Campaign reports distinguish distribution and engagement.
- The system can later connect to Outernet without requiring a redesign.

---

# 8. IMPLEMENTATION STAGE 6 — INTEGRATION, SECURITY AND COMMERCIAL LAUNCH

## Objective

Ensure the entire platform works as one coherent system.

Do not consider the project complete simply because individual screens and features have been built.

## 8.1 End-to-end testing

Test the following complete journeys.

### Journey A: Independent author

1. User registers.
2. Creates a book.
3. Submits it.
4. Administrator approves it.
5. Author lists it in the shop.
6. Customer buys a printed copy.
7. Order is paid and fulfilled.
8. Author receives the correct commission.
9. Commission appears in the earnings dashboard.
10. Administrator records payout.

### Journey B: Digital purchase

1. Customer browses the shop.
2. Selects a PDF.
3. Pays.
4. Receives download access.
5. Downloads the correct approved PDF.
6. Purchase and author commission are recorded.

### Journey C: Mixed basket

1. Customer adds several publications.
2. Selects different quantities.
3. Selects physical and digital formats.
4. Checkout calculates shipping correctly.
5. Customer pays once.
6. Physical items enter fulfilment.
7. Digital entitlements are created.
8. Author commissions are correctly allocated.

### Journey D: Sponsored publication

1. Sponsor selects an approved book.
2. Requests sponsorship.
3. Administrator prepares a quotation.
4. Sponsor approves and pays.
5. Campaign panels are allocated.
6. Charity and outlet content is approved.
7. Sponsored edition is generated.
8. Final PDF is approved.
9. Print run is created.
10. Books are distributed.
11. Campaign tracking becomes available.
12. Author receives the agreed sponsorship royalty.

### Journey E: Multiple sponsored editions

1. An author publishes one approved book.
2. Sponsor A commissions an edition.
3. Sponsor B commissions a separate edition.
4. Each receives different back-page content.
5. Both editions retain a reference to the original publication.
6. Their production and financial records remain separate.

## 8.2 Security

Review all application permissions.

Ensure:

- Authors can only edit their own publications.
- Authors can only access their own earnings.
- Sponsors can only access their own campaigns.
- Customers can only access their own orders and downloads.
- Outlets can only access their own distribution records.
- Administrators have appropriate management permissions.
- Private PDFs cannot be accessed through public URLs.
- Payment webhooks are verified.
- All financial calculations are server-side.
- Sensitive information is not exposed through APIs.
- All relevant endpoints validate permissions.

If the application uses Supabase, inspect and enforce Row Level Security policies. If it uses another backend, implement equivalent protections.

## 8.3 Reliability

Test:

- Duplicate payment notifications.
- Interrupted checkouts.
- Failed payments.
- Refunds.
- Cancelled orders.
- Duplicate downloads.
- Missing PDFs.
- Invalid QR destinations.
- Failed campaign PDF generation.
- Concurrent orders.
- Invalid quantities.
- Incorrect shipping calculations.

All important financial and production operations should be recoverable and auditable.

## 8.4 Regression testing

The existing application must continue working.

Specifically test:

- Existing user accounts.
- Existing books.
- Existing approval workflow.
- Existing PDF generation.
- Existing dashboard.
- Existing print ordering.
- Existing shipping calculations.
- Existing Stripe integration.
- Existing Titchybook Vault functionality, if implemented.

Do not remove or silently change existing functionality.

## 8.5 Launch readiness

Before public launch, provide:

- Final database schema documentation.
- Migration history.
- Environment variable documentation.
- API documentation.
- Administrator instructions.
- Creator instructions.
- Sponsor instructions.
- Distribution partner instructions.
- Test results.
- Known issues.
- Deployment instructions.
- Rollback procedures.

No production database migration should occur without an approved backup and deployment plan.

---

# 9. PROPOSED CORE DATA ARCHITECTURE

This section defines conceptual entities, not mandatory table names.

Sonus must reconcile these against the existing database during Phase 0.

| Entity | Purpose |
|---|---|
| Users | Registered platform accounts |
| Books | Original publications |
| Book versions | Approved versions and content revisions |
| Book listings | Public shop products |
| Book files | Stored PDFs and associated assets |
| Orders | Customer transactions |
| Order items | Individual purchased products |
| Download entitlements | Digital purchase rights |
| Royalty ledger | Author commission records |
| Payouts | Author payment records |
| Sponsors | Business accounts |
| Sponsorship campaigns | Individual commercial campaigns |
| Sponsored editions | Sponsor-specific book versions |
| Campaign panels | Eight back-page allocations |
| Charities | Approved charity directory |
| Distribution outlets | Physical distribution partners |
| Campaign distributions | Campaign-specific stock allocation |
| QR tracking | Engagement records |

## Critical relationships

A book can have multiple approved versions.

A book can have a public listing.

A book can generate multiple individual orders.

A book can have multiple sponsored editions.

A sponsored edition belongs to one specific campaign.

A campaign can have multiple back-page panel allocations.

A campaign can distribute copies through multiple outlets.

An order can contain multiple order items.

An order item can generate an author royalty.

A sponsored edition can generate a separately agreed author royalty.

All financial records must be linked to their originating transactions.

---

# 10. COMMERCIAL SETTINGS AND ADMINISTRATION

Build an administrator-controlled settings area for:

- Printed retail prices.
- Quantity pricing rules.
- Production costs.
- Shipping rates.
- Exchange-rate configuration.
- PDF prices.
- Author commission rates.
- Sponsorship pricing.
- Charity placement pricing.
- Distribution charges.
- Payout thresholds.
- Minimum order quantities.
- Supported countries.
- Supported currencies.
- Publication categories.
- Panel allocation rules.

Do not bury commercial values in frontend components or scattered backend constants.

Use a central configuration mechanism with suitable validation and permission controls.

Record which settings were applied to each transaction or campaign.

---

# 11. FUTURE EXPANSION — DESIGN FOR COMPATIBILITY

These features are not part of the initial six implementation stages unless already supported by existing functionality.

However, the architecture should accommodate them.

## 11.1 Titchybooks Creator SaaS

Subscription plans offering:

- AI-generated books.
- YouTube-to-book generation.
- Website-to-book generation.
- AI writing and editing tools.
- Downloadable InDesign templates.
- Affinity Publisher templates.
- Canva-compatible resources where technically practical.
- Commercial publishing tools.
- Creator analytics.

Subscription allowances should be configurable.

## 11.2 Creator template marketplace

Independent designers can submit templates.

Approved templates can be made available to subscribers and potentially sold individually.

Template creators can receive revenue shares.

## 11.3 Sponsored content discovery

Introduce a sponsor-facing noticeboard where businesses can post publication requirements.

Examples:

- Looking for a family activity book for our holiday resort.
- Looking for a gardening guide for our garden centre.
- Looking for a pocket guide to local attractions.

Authors can submit suitable publications or create new ones.

## 11.4 Automated sponsorship proposals

AI can assist with:

- Publication suitability assessments.
- Suggested sponsor industries.
- Audience matching.
- Campaign proposals.
- Back-page content drafts.
- QR and campaign artwork generation.

Human approval remains essential.

## 11.5 Outernet integration

Connect Titchybooks to Outernet Cafes and Spaces.

Enable map-based discovery of book distribution locations and community publications.

## 11.6 Memlocal integration

Enable local historical publications, community memories and QR-linked location stories.

---

# 12. SONUS DEVELOPMENT RULES

These instructions apply throughout the project.

### A. Understand before changing

Inspect existing code before proposing replacements.

Never assume functionality is missing simply because it is not immediately visible.

### B. Reuse before rebuilding

Prefer extending working components, services and database structures.

Avoid introducing duplicate pricing, order or payment engines.

### C. No unnecessary technology migration

Keep the existing application framework, backend, database, hosting and deployment arrangements unless the audit establishes a compelling reason to change them.

### D. Incremental migrations

Database changes must be version-controlled and documented.

Avoid destructive migrations.

Preserve existing data and backward compatibility.

### E. Financial integrity

Use server-side calculations.

Use immutable transaction snapshots and auditable financial ledgers.

Ensure payment processing is idempotent.

### F. Security first

Respect existing authentication and authorisation architecture.

Enforce ownership and access permissions at the backend, not just through frontend visibility.

### G. Separate original publications from commercial editions

Never overwrite the author's original approved publication when generating sponsor-specific editions.

### H. Preserve existing user experience

The existing application should evolve coherently rather than becoming a collection of disconnected dashboards.

Reuse existing design conventions and components where appropriate.

### I. Test every implementation stage

Each stage must include:

- Database tests.
- Backend tests.
- Frontend validation.
- Permission tests.
- Relevant payment and financial tests.
- Regression testing.

Do not move to the next stage with unresolved critical defects.

### J. Maintain project documentation

Update architecture, schema and implementation documentation as development progresses.

Record important technical decisions.

### K. No unapproved production changes

Never run destructive migrations, modify production records or change production configuration without explicit approval.

---

# 13. REQUIRED DEVELOPMENT REPORTING

At the end of every implementation stage, provide:

1. What has been implemented.
2. Files created or modified.
3. Database migrations introduced.
4. Existing functionality affected.
5. Tests performed and results.
6. Outstanding issues.
7. Security considerations.
8. Deployment requirements.
9. Recommended next steps.

Maintain a running `IMPLEMENTATION_STATUS.md`.

Use clear stage completion criteria.

Do not report a feature as complete simply because its interface has been created.

A feature is complete only when its underlying business logic, permissions, data handling and relevant tests are working.

---

# 14. FINAL PRODUCT OBJECTIVE

The finished Titchybooks platform should allow:

**A CREATOR**
- To create and publish a book.
- To sell physical copies.
- To sell downloadable PDFs.
- To earn royalties.
- To submit publications for sponsorship.
- To promote their own products through approved back-page placements.

**A CUSTOMER**
- To browse thousands of publications.
- To buy printed copies.
- To purchase print-ready PDFs.
- To manage orders and downloads.

**A SPONSOR**
- To discover suitable publications.
- To commission sponsored editions.
- To select charity and business placements.
- To arrange distribution.
- To measure campaign engagement.

**A DISTRIBUTION PARTNER**
- To receive free sponsored publications.
- To promote its business.
- To manage its distribution allocation.
- To request replenishment.

**A CHARITY**
- To gain awareness.
- To receive visits to its approved donation page.
- To participate in sponsored publication campaigns.

**TITCHYBOOKS**
- To earn from printing, publishing, digital sales, sponsorship and subscriptions.
- To provide infrastructure for independent creators.
- To coordinate a distributed network of physical publications.
- To grow without having to produce all its own content.

---

# 15. INITIAL INSTRUCTION TO SONUS

Begin with PHASE 0 ONLY.

Perform a complete, read-only technical audit of the current Titchybooks application.

Do not modify code, database structures, configuration, dependencies or production data.

Produce all eight audit deliverables specified in Section 2.

Then present:

1. Your understanding of the existing system.
2. Your recommended architecture.
3. Your proposed database changes.
4. Your implementation sequence.
5. Your identified risks.
6. Any questions that must be resolved before development.

Pay particular attention to preserving the existing book creation, approval, PDF generation, print pricing, shipping and Stripe ordering functionality.

Do not assume historical technology choices apply to the current application.

**STOP AFTER THE AUDIT AND WAIT FOR EXPLICIT APPROVAL BEFORE STARTING IMPLEMENTATION STAGE 1.**

The objective is not simply to add features. It is to evolve the existing Titchybooks application into a robust, scalable publishing and sponsorship marketplace without compromising what already works.
