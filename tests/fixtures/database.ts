import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { testEnvironment } from '../../scripts/test-environment.mts';
import { createEmptySubmissionPageSeeds } from '@/lib/editor/validation';
import { textElement } from './scenes';

// Explicit datasource prevents this fixture from ever using the application database.
const env = testEnvironment();
export const db = new PrismaClient({ datasources: { db: { url: env.DATABASE_URL } } });
const users: string[] = [];
export async function createUser(role = 'USER', passwordHash = 'not-a-login-password') {
  const user = await db.user.create({ data: {
    email: `sprint-${randomUUID()}@example.invalid`, passwordHash, name: 'Sprint Test', role,
    audience: 'business', businessName: 'Test Only', businessType: 'other', companySize: '1-10',
  } });
  users.push(user.id);
  return user;
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
export async function cleanupFixtures() {
  if (!users.length) return;
  testEnvironment();
  await db.$transaction(async tx => {
    await tx.aiBookJob.deleteMany({ where: { userId: { in: users } } });
    await tx.renderJob.deleteMany({ where: { submission: { userId: { in: users } } } });
    await tx.submission.updateMany({ where: { userId: { in: users } }, data: { templateId: null } });
    await tx.submission.deleteMany({ where: { userId: { in: users } } });
    await tx.asset.deleteMany({ where: { userId: { in: users } } });
    await tx.user.deleteMany({ where: { id: { in: users } } });
  });
  users.length = 0;
}
