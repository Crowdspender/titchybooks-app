import type { Prisma } from '@prisma/client';
import { editorElementSchema, editorSceneSchema } from '@/lib/editor/schema';
import { parseAiTemplateManifest, parsePinnedTemplate } from '@/lib/ai/template-contract';

export class AssetReferenceError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

/** One transaction-scoped fence for removal and reference writers, without a registry. */
export async function lockAssetReferences(tx: Prisma.TransactionClient) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(741001, 1)`;
}

export async function assertActiveAssetIds(tx: Prisma.TransactionClient, ids: string[]) {
  await lockAssetReferences(tx);
  const unique = [...new Set(ids)];
  const assets = await tx.asset.findMany({ where: { id: { in: unique }, deletedAt: null } });
  if (assets.length !== unique.length) throw new AssetReferenceError(400, 'An image is missing or removed. Replace it before saving.');
  return assets;
}

function uncertain(): never {
  throw new AssetReferenceError(409, 'Saved source references could not be verified. Nothing was removed.');
}
function json(value: string): unknown {
  try { return JSON.parse(value); } catch { return uncertain(); }
}
function pin(value: unknown) {
  const parsed = parsePinnedTemplate(value);
  if (!parsed) return uncertain();
  return parsed;
}
function contains(value: unknown, id: string, key: string): boolean {
  if (typeof value === 'string') return value === id || value === key;
  if (Array.isArray(value)) return value.some(item => contains(item, id, key));
  if (value && typeof value === 'object') return Object.values(value).some(item => contains(item, id, key));
  return false;
}
function object(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return uncertain();
  return value as Record<string, unknown>;
}
function scene(value: unknown) {
  const parsed = editorSceneSchema.safeParse(value);
  if (!parsed.success) return uncertain();
  return parsed.data;
}
/** The image sources a validated pin retains, in its pages and manifest. */
function pinAssetIds(value: unknown): string[] {
  const parsed = pin(value);
  return [
    ...parsed.pages.flatMap(page => page.elements.flatMap(element => element.type === 'image' ? [element.assetId] : [])),
    ...parsed.manifest.pages.flatMap(page => page.images.map(image => image.assetId)),
  ];
}

/** Validate any newly persisted AI pin, including pins captured before this transaction. */
export async function validatePinnedAssetReferences(tx: Prisma.TransactionClient, output: unknown) {
  await lockAssetReferences(tx);
  if (output === null || output === undefined) return;
  const record = object(output);
  if (record.pinnedTemplate !== null && record.pinnedTemplate !== undefined) {
    await assertActiveAssetIds(tx, pinAssetIds(record.pinnedTemplate));
  }
}

export async function removeAssetFromLibrary(tx: Prisma.TransactionClient, id: string, userId: string) {
  await lockAssetReferences(tx);
  const asset = await tx.asset.findUnique({ where: { id } });
  if (!asset) throw new AssetReferenceError(404, 'Asset not found');
  if (asset.userId !== userId) throw new AssetReferenceError(403, 'Forbidden');
  if (asset.deletedAt) return;
  const used = (): never => {
    throw new AssetReferenceError(409, 'This image is used by saved content or a retained generation. Remove its uses before removing it from the library.');
  };
  // Recognized payloads match only their source-reference fields, so saved
  // text that happens to equal an asset ID is not treated as an image use.
  const match = (value: string) => { if (value === asset.id || value === asset.s3Key) used(); };
  // Opaque retained-key manifests keep whole-payload matching: any retained
  // source string counts, and their shape cannot be enumerated.
  const referenced = (value: unknown) => { if (contains(value, asset.id, asset.s3Key)) used(); };
  // Scan retained records, not only active jobs or the caller's current draft.
  const [pages, elements, submissions, renders, aiJobs, images] = await Promise.all([
    tx.submissionPage.findMany({ select: { sceneJson: true } }),
    tx.templateElement.findMany({ select: { elementJson: true } }),
    tx.submission.findMany({ select: { pinnedTemplate: true, aiManifest: true, artifactManifest: true } }),
    tx.renderJob.findMany({ select: { inputSnapshot: true, artifactManifest: true } }),
    tx.aiBookJob.findMany({ select: { stageOutput: true } }),
    tx.submissionImage.findMany({ select: { s3Key: true } }),
  ]);
  for (const page of pages) {
    for (const element of scene(json(page.sceneJson)).elements) {
      if (element.type === 'image') match(element.assetId);
    }
  }
  for (const element of elements) {
    const parsed = editorElementSchema.safeParse(json(element.elementJson));
    if (!parsed.success) uncertain();
    if (parsed.data.type === 'image') match(parsed.data.assetId);
  }
  for (const submission of submissions) {
    if (submission.pinnedTemplate !== null) for (const id of pinAssetIds(submission.pinnedTemplate)) match(id);
    if (submission.aiManifest !== null) referenced(object(submission.aiManifest));
    if (submission.artifactManifest !== null) referenced(object(submission.artifactManifest));
  }
  // Lazy import avoids a module-initialization cycle with snapshot capture.
  // The retained shape deliberately omits qualification policy (font hashes,
  // print profile) so policy evolution never blocks unrelated removals, and
  // historical jobs without a snapshot stay removable.
  const retainedSchema = renders.length ? (await import('@/lib/pdf/snapshot')).retainedRenderSnapshotSchema : null;
  for (const render of renders) {
    if (render.inputSnapshot !== null) {
      const parsed = retainedSchema!.safeParse(render.inputSnapshot);
      if (!parsed.success) uncertain();
      for (const page of parsed.data.pages) {
        for (const element of page.scene.elements) if (element.type === 'image') match(element.assetId);
      }
      for (const descriptor of parsed.data.assets) { match(descriptor.id); match(descriptor.s3Key); }
      for (const image of parsed.data.images) match(image.s3Key);
    }
    if (render.artifactManifest !== null) referenced(object(render.artifactManifest));
  }
  for (const job of aiJobs) {
    if (job.stageOutput === null) continue;
    const output = object(job.stageOutput);
    if (output.pinnedTemplate !== null && output.pinnedTemplate !== undefined) {
      for (const id of pinAssetIds(output.pinnedTemplate)) match(id);
    }
    // The manifest mirrors the pin's artwork; plans and reports are text.
    if (output.manifest !== null && output.manifest !== undefined) {
      const manifest = parseAiTemplateManifest(output.manifest);
      if (!manifest) uncertain();
      for (const page of manifest.pages) for (const image of page.images) match(image.assetId);
    }
  }
  for (const image of images) match(image.s3Key);
  // Source bytes and the original Asset ID remain available to authorized readers.
  await tx.asset.update({ where: { id }, data: { deletedAt: new Date() } });
}

/** Both template deletion routes enforce the same relationships under the fence. */
export async function requireNoTemplateDependents(tx: Prisma.TransactionClient, templateId: string) {
  await lockAssetReferences(tx);
  const [instances, aiJobs] = await Promise.all([
    tx.submission.count({ where: { templateId } }),
    tx.aiBookJob.count({ where: { templateId } }),
  ]);
  if (instances || aiJobs) throw new AssetReferenceError(409, 'Templates with linked books or AI jobs cannot be deleted');
}
