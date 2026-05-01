import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { hashSync } from "bcryptjs";
import {
  DEFAULT_CURRENCY_RATES,
  DEFAULT_PRICE_TIERS,
  DEFAULT_SHIPPING_TABLE,
  DEFAULT_WEIGHT_BANDS,
  DEFAULT_WEIGHT_PER_BOOK_GRAMS,
  ZONES,
} from "../src/lib/pricing/constants";
import { PAGE_LABELS } from "../src/lib/constants";
import {
  EDITOR_PAGE_WIDTH_PX,
  EDITOR_PAGE_HEIGHT_PX,
  EDITOR_DEFAULT_BACKGROUND_COLOR,
  EDITOR_SCENE_VERSION,
} from "../src/lib/editor/constants";

const prisma = new PrismaClient();

async function seedAdmin() {
  const email = process.env.ADMIN_EMAIL || "admin@titchybook.com";
  const password = process.env.ADMIN_PASSWORD || "admin123456";

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    console.log(`Admin user already exists: ${email}`);
    return;
  }

  const passwordHash = hashSync(password, 12);
  await prisma.user.create({
    data: {
      email,
      passwordHash,
      name: "Admin",
      role: "ADMIN",
    },
  });

  console.log(`Admin user created: ${email}`);
}

async function seedPricingConfig() {
  const existing = await prisma.pricingConfig.findUnique({
    where: { id: "default" },
  });
  if (existing) {
    console.log("Pricing config already exists (version " + existing.version + ")");
    return;
  }

  await prisma.pricingConfig.create({
    data: {
      id: "default",
      version: 1,
      weightPerBookGrams: DEFAULT_WEIGHT_PER_BOOK_GRAMS,
      handlingFixedHuf: 0,
      handlingPercent: 0,
      enabledZones: JSON.stringify([...ZONES]),
      weightBands: JSON.stringify([...DEFAULT_WEIGHT_BANDS]),
      shippingTable: JSON.stringify(
        Object.fromEntries(
          ZONES.map((zone) => [zone, [...DEFAULT_SHIPPING_TABLE[zone]]])
        )
      ),
      priceTiers: JSON.stringify(DEFAULT_PRICE_TIERS.map((t) => ({ ...t }))),
      currencyRates: JSON.stringify({ ...DEFAULT_CURRENCY_RATES }),
    },
  });
  console.log("Default pricing config created");
}

async function seedTemplates() {
  const admin = await prisma.user.findFirst({ where: { role: "ADMIN" } });
  if (!admin) {
    console.log("No admin user found – skipping template seeding");
    return;
  }

  const existingTemplates = await prisma.submission.count({
    where: { isTemplate: true },
  });
  if (existingTemplates > 0) {
    console.log("Templates already exist – skipping");
    return;
  }

  // --- Template 1: "Birthday Card" ---
  const birthdayTemplate = await prisma.submission.create({
    data: {
      userId: admin.id,
      mode: "TEMPLATE",
      title: "Birthday Card",
      status: "APPROVED",
      isTemplate: true,
      version: 1,
      publishedAt: new Date(),
      pages: {
        create: PAGE_LABELS.map((pageLabel, order) => ({
          pageLabel,
          order,
          sceneJson: JSON.stringify({
            version: EDITOR_SCENE_VERSION,
            page: {
              widthPx: EDITOR_PAGE_WIDTH_PX,
              heightPx: EDITOR_PAGE_HEIGHT_PX,
              backgroundColor: pageLabel === "FRONT_COVER" ? "#fef3c7" : EDITOR_DEFAULT_BACKGROUND_COLOR,
            },
            elements: [],
          }),
        })),
      },
    },
  });

  // Add template elements for the front cover
  await prisma.templateElement.createMany({
    data: [
      {
        templateId: birthdayTemplate.id,
        pageLabel: "FRONT_COVER",
        order: 0,
        elementJson: JSON.stringify({
          id: crypto.randomUUID(),
          type: "text",
          x: 72,
          y: 88,
          width: 556,
          height: 120,
          rotation: 0,
          opacity: 1,
          locked: false,
          visible: true,
          zIndex: 0,
          text: "Happy Birthday!",
          fontFamily: "Arial",
          fontSize: 56,
          fontWeight: 700,
          lineHeight: 1.2,
          letterSpacing: 0,
          color: "#92400e",
          align: "center",
          verticalAlign: "top",
        }),
      },
      {
        templateId: birthdayTemplate.id,
        pageLabel: "FRONT_COVER",
        order: 1,
        elementJson: JSON.stringify({
          id: crypto.randomUUID(),
          type: "shape",
          x: 100,
          y: 240,
          width: 500,
          height: 4,
          rotation: 0,
          opacity: 0.5,
          locked: false,
          visible: true,
          zIndex: 1,
          shape: "line",
          fill: "transparent",
          stroke: "#d97706",
          strokeWidth: 3,
        }),
      },
    ],
  });

  // --- Template 2: "Photo Journal" ---
  const photoTemplate = await prisma.submission.create({
    data: {
      userId: admin.id,
      mode: "TEMPLATE",
      title: "Photo Journal",
      status: "APPROVED",
      isTemplate: true,
      version: 1,
      publishedAt: new Date(),
      pages: {
        create: PAGE_LABELS.map((pageLabel, order) => ({
          pageLabel,
          order,
          sceneJson: JSON.stringify({
            version: EDITOR_SCENE_VERSION,
            page: {
              widthPx: EDITOR_PAGE_WIDTH_PX,
              heightPx: EDITOR_PAGE_HEIGHT_PX,
              backgroundColor: "#f5f5f4",
            },
            elements: [],
          }),
        })),
      },
    },
  });

  await prisma.templateElement.createMany({
    data: [
      {
        templateId: photoTemplate.id,
        pageLabel: "FRONT_COVER",
        order: 0,
        elementJson: JSON.stringify({
          id: crypto.randomUUID(),
          type: "shape",
          x: 0,
          y: 0,
          width: EDITOR_PAGE_WIDTH_PX,
          height: 200,
          rotation: 0,
          opacity: 1,
          locked: false,
          visible: true,
          zIndex: 0,
          shape: "rect",
          fill: "#1c1917",
        }),
      },
      {
        templateId: photoTemplate.id,
        pageLabel: "FRONT_COVER",
        order: 1,
        elementJson: JSON.stringify({
          id: crypto.randomUUID(),
          type: "text",
          x: 40,
          y: 50,
          width: 620,
          height: 100,
          rotation: 0,
          opacity: 1,
          locked: false,
          visible: true,
          zIndex: 1,
          text: "My Photo Journal",
          fontFamily: "Arial",
          fontSize: 44,
          fontWeight: 700,
          lineHeight: 1.2,
          letterSpacing: 2,
          color: "#fafaf9",
          align: "center",
          verticalAlign: "top",
        }),
      },
    ],
  });

  // --- Template 3: "Minimalist Zine" ---
  const zineTemplate = await prisma.submission.create({
    data: {
      userId: admin.id,
      mode: "TEMPLATE",
      title: "Minimalist Zine",
      status: "APPROVED",
      isTemplate: true,
      version: 1,
      publishedAt: new Date(),
      pages: {
        create: PAGE_LABELS.map((pageLabel, order) => ({
          pageLabel,
          order,
          sceneJson: JSON.stringify({
            version: EDITOR_SCENE_VERSION,
            page: {
              widthPx: EDITOR_PAGE_WIDTH_PX,
              heightPx: EDITOR_PAGE_HEIGHT_PX,
              backgroundColor: EDITOR_DEFAULT_BACKGROUND_COLOR,
            },
            elements: [],
          }),
        })),
      },
    },
  });

  await prisma.templateElement.createMany({
    data: [
      {
        templateId: zineTemplate.id,
        pageLabel: "FRONT_COVER",
        order: 0,
        elementJson: JSON.stringify({
          id: crypto.randomUUID(),
          type: "shape",
          x: 100,
          y: 400,
          width: 500,
          height: 2,
          rotation: 0,
          opacity: 0.4,
          locked: false,
          visible: true,
          zIndex: 0,
          shape: "line",
          fill: "transparent",
          stroke: "#78716c",
          strokeWidth: 2,
        }),
      },
      {
        templateId: zineTemplate.id,
        pageLabel: "FRONT_COVER",
        order: 1,
        elementJson: JSON.stringify({
          id: crypto.randomUUID(),
          type: "text",
          x: 100,
          y: 440,
          width: 500,
          height: 60,
          rotation: 0,
          opacity: 0.7,
          locked: false,
          visible: true,
          zIndex: 1,
          text: "A MINIMALIST ZINE",
          fontFamily: "Arial",
          fontSize: 18,
          fontWeight: 400,
          lineHeight: 1.4,
          letterSpacing: 6,
          color: "#78716c",
          align: "center",
          verticalAlign: "top",
        }),
      },
    ],
  });

  console.log("Sample templates created: Birthday Card, Photo Journal, Minimalist Zine");
}

async function main() {
  await seedAdmin();
  await seedPricingConfig();
  await seedTemplates();
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
