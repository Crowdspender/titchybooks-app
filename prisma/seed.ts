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
import { seedTemplates } from "./seed-templates";

const prisma = new PrismaClient();

async function seedAdmin() {
  const email = process.env.ADMIN_EMAIL || "admin@titchybook.com";
  // No default password: an accidentally-seeded admin with a known password
  // is a full compromise. Set ADMIN_PASSWORD before seeding.
  const password = process.env.ADMIN_PASSWORD;
  if (!password) {
    throw new Error(
      "ADMIN_PASSWORD is not set. Refusing to seed an admin account with a default password.",
    );
  }

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

async function main() {
  await seedAdmin();
  await seedPricingConfig();

  // Starter templates need an owner. They are matched by `managedKey`, so this
  // re-seeds only the recipes the seed owns and leaves admin-authored
  // templates untouched.
  const admin = await prisma.user.findFirst({
    where: { role: "ADMIN" },
    select: { id: true },
  });
  if (!admin) {
    console.log("No admin user found – skipping template seeding");
    return;
  }

  await seedTemplates(prisma, admin.id);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
