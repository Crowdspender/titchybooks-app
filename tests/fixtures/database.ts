import { randomUUID } from 'node:crypto';
import { PrismaClient, type UserRole } from '@prisma/client';
import { testEnvironment } from '../../scripts/test-environment.mts';
import { SEED_RECIPES, elementSeeds, pageSeeds, type SeedRecipe } from '../../prisma/seed-recipes';
import { createEmptySubmissionPageSeeds } from '@/lib/editor/validation';
import { textElement } from './scenes';

// Explicit datasource prevents this fixture from ever using the application database.
const env = testEnvironment();
export const db = new PrismaClient({ datasources: { db: { url: env.DATABASE_URL } } });
const users: string[] = [];
const paymentEvents: string[] = [];
const fixtureEmails: string[] = [];
const rateLimitKeys: string[] = [];
export function trackPaymentEvent(id: string) { paymentEvents.push(id); return id; }
export function trackFixtureRateLimit(key: string) {
  testEnvironment();
  if (!key) throw new Error('Supply an exact test-owned limiter key');
  rateLimitKeys.push(key); return key;
}
// Registration-route acceptance creates its own user instead of a DB fixture.
// Only explicit synthetic fixture identities may join this cleanup registry.
export function trackFixtureUser<T extends { id: string; email: string }>(user: T): T {
  testEnvironment();
  if (!user.id || !/^sprint-[0-9a-f-]{36}@example\.invalid$/.test(user.email)) {
    throw new Error('Only synthetic sprint identities can be tracked for cleanup');
  }
  users.push(user.id); fixtureEmails.push(user.email.toLowerCase());
  return user;
}
export async function createUser(role: UserRole = 'USER', passwordHash = 'not-a-login-password') {
  const user = await db.user.create({ data: {
    email: `sprint-${randomUUID()}@example.invalid`, passwordHash, name: 'Sprint Test', role,
  } });
  return trackFixtureUser(user);
}
export async function createDraft(userId: string, isTemplate = false) {
  return db.submission.create({ data: {
    userId, mode: isTemplate ? 'TEMPLATE' : 'EDITOR', status: 'DRAFT', isTemplate,
    pages: { create: createEmptySubmissionPageSeeds().map(({ pageLabel, order, sceneJson }) => ({ pageLabel, order, sceneJson })) },
  } });
}
export interface TemplateTextSlotSeed {
  pageLabel: string;
  id: string;
  text?: string;
  width?: number;
  height?: number;
  fontSize?: number;
}
/**
 * Seed an APPROVED template carrying text slots, so the autonomous AI pipeline
 * has a published template to instantiate. Slots default to a large box that
 * comfortably fits short text (happy path); pass a small box to force overflow.
 */
export async function createApprovedTemplateWithText(userId: string, slots: TemplateTextSlotSeed[]) {
  const template = await createDraft(userId, true);
  await db.templateElement.createMany({ data: slots.map((slot, order) => ({
    templateId: template.id, pageLabel: slot.pageLabel, order,
    elementJson: JSON.stringify({ ...textElement(slot.id, slot.text ?? 'Example text'),
      width: slot.width ?? 600, height: slot.height ?? 400, fontSize: slot.fontSize ?? 24 }),
  })) });
  return db.submission.update({ where: { id: template.id }, data: { status: 'APPROVED' } });
}
/**
 * An AI-ready template built from a starter recipe.
 *
 * The pipeline refuses a template that fails the shared preflight, so fixtures
 * must be complete books — a title slot, all six interior pages and generated
 * closing copy — not a single cover slot.
 */
export async function createAiReadyTemplate(userId: string, recipe: SeedRecipe = SEED_RECIPES[0]) {
  const template = await db.submission.create({ data: {
    userId, mode: 'TEMPLATE', isTemplate: true, status: 'APPROVED',
    title: recipe.title, version: 1, aiReady: true,
    pages: { create: pageSeeds(recipe) },
  } });
  await db.templateElement.createMany({
    data: elementSeeds(recipe).map((row) => ({ templateId: template.id, ...row })),
  });
  return template;
}
export async function cleanupFixtures() {
  if (!users.length && !paymentEvents.length && !rateLimitKeys.length) return;
  testEnvironment();
  await db.$transaction(async tx => {
    // Exact identities registered by this process only; shared/unknown buckets survive.
    const ownedKeys = [...rateLimitKeys,
      ...users.flatMap(id => ['submission:user', 'quote:user', 'order:user', 'pay:user', 'ai-book:user', 'payment-review:admin'].map(prefix => `${prefix}:${id}`)),
      ...fixtureEmails.flatMap(email => [`login:${email}`, `forgot:email:${email}`])];
    await tx.rateLimitBucket.deleteMany({ where: { bucketKey: { in: ownedKeys } } });
    await tx.aiBookJob.deleteMany({ where: { userId: { in: users } } });
    await tx.renderJob.deleteMany({ where: { submission: { userId: { in: users } } } });
    // Vault entries reference orders and submissions; orders reference submissions.
    await tx.vaultEntry.deleteMany({ where: { order: { userId: { in: users } } } });
    // Delete only tracked payment fixtures before their retained-history foreign keys.
    await tx.paymentEvent.deleteMany({ where: { OR: [
      { order: { userId: { in: users } } }, { id: { in: paymentEvents } },
    ] } });
    await tx.paymentAttempt.deleteMany({ where: { order: { userId: { in: users } } } });
    // Payment alerts cascade from their order, but an alert raised for an order
    // id that was never stored has no parent row to cascade from. The suite runs
    // one file at a time against a dedicated test database, so clearing the
    // orphaned ones here cannot touch another test's data.
    await tx.paymentAlert.deleteMany({ where: { orderId: null } });
    await tx.order.deleteMany({ where: { userId: { in: users } } });
    await tx.submission.updateMany({ where: { userId: { in: users } }, data: { templateId: null } });
    await tx.submission.deleteMany({ where: { userId: { in: users } } });
    await tx.asset.deleteMany({ where: { userId: { in: users } } });
    await tx.user.deleteMany({ where: { id: { in: users } } });
  });
  users.length = 0;
  paymentEvents.length = 0;
  fixtureEmails.length = 0;
  rateLimitKeys.length = 0;
}
