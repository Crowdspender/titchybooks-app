import { z } from 'zod';
import type { Submission } from '@prisma/client';
import { PAGE_LABELS } from '@/lib/constants';
import { editorSceneSchema } from '@/lib/editor/schema';
import { mergedPages, validateSceneAssets, SubmissionError, type Transaction, type Actor } from '@/lib/editor/submission-store';
import { checkSubmissionResolution, type DpiWarning } from '@/lib/editor/validation';
import { DEFAULT_PRINT_PROFILE, isCurrentPrintProfile } from './print-profile';

const assetSchema = z.object({
  id: z.string().min(1), s3Key: z.string().min(1), mimeType: z.string(),
  width: z.number().nullable(), height: z.number().nullable(),
});
const pageSchema = z.array(z.object({ pageLabel: z.enum(PAGE_LABELS), scene: editorSceneSchema }));
const imageSchema = z.array(z.object({ pageLabel: z.enum(PAGE_LABELS), s3Key: z.string().min(1) }));

/**
 * Version 1 snapshots predate the qualified dual-output profile. They stay
 * parseable forever so existing jobs keep rendering; they are never
 * re-qualified as new AI output.
 */
export const renderSnapshotV1Schema = z.object({
  version: z.literal(1),
  userId: z.string().min(1), submissionId: z.string().min(1),
  renderer: z.enum(['raster', 'vector']),
  mode: z.enum(['EDITOR', 'LEGACY_UPLOAD']),
  pages: pageSchema,
  assets: z.array(assetSchema),
  images: imageSchema,
}).superRefine((value, ctx) => {
  const panels = value.mode === 'EDITOR' ? value.pages : value.images;
  if (panels.length !== 8 || new Set(panels.map(p => p.pageLabel)).size !== 8) {
    ctx.addIssue({ code: 'custom', message: 'Eight unique render panels required' });
  }
  if (value.mode === 'LEGACY_UPLOAD' && value.renderer !== 'raster') ctx.addIssue({ code: 'custom', message: 'Legacy must use raster' });
  const ids = new Set(value.assets.map(asset => asset.id));
  if (value.pages.some(page => page.scene.elements.some(el => el.type === 'image' && !ids.has(el.assetId)))) {
    ctx.addIssue({ code: 'custom', message: 'Missing source asset descriptor' });
  }
});

/**
 * Version 2 snapshots name the print profile, the exact source revision and the
 * complete expected output set, so QA can prove the artifacts it inspects came
 * from this submission revision and nothing else.
 */
export const renderSnapshotV2Schema = z.object({
  version: z.literal(2),
  userId: z.string().min(1), submissionId: z.string().min(1),
  /** Submission revision captured into this snapshot. */
  submissionRevision: z.number().int().nonnegative(),
  /** Template identity/revision, when the book was composed from one. */
  templateId: z.string().nullable(),
  templateVersion: z.number().int().nullable(),
  /** Document title used for PDF metadata and download filenames. */
  title: z.string().nullable(),
  printProfile: z.string().min(1),
  /** The qualified AI path is raster only. */
  renderer: z.literal('raster'),
  mode: z.enum(['EDITOR', 'LEGACY_UPLOAD']),
  outputs: z.tuple([z.literal('print-sheet'), z.literal('reading-pdf')]),
  pages: pageSchema,
  assets: z.array(assetSchema),
  images: imageSchema,
}).superRefine((value, ctx) => {
  const panels = value.mode === 'EDITOR' ? value.pages : value.images;
  if (panels.length !== 8 || new Set(panels.map(p => p.pageLabel)).size !== 8) {
    ctx.addIssue({ code: 'custom', message: 'Eight unique render panels required' });
  }
  if (value.mode === 'EDITOR' && value.pages.length !== 8) {
    ctx.addIssue({ code: 'custom', message: 'Editor snapshots require eight page scenes' });
  }
  if (!isCurrentPrintProfile(value.printProfile)) {
    ctx.addIssue({ code: 'custom', message: `Unsupported print profile "${value.printProfile}"` });
  }
  const ids = new Set(value.assets.map(asset => asset.id));
  if (value.pages.some(page => page.scene.elements.some(el => el.type === 'image' && !ids.has(el.assetId)))) {
    ctx.addIssue({ code: 'custom', message: 'Missing source asset descriptor' });
  }
});

export const renderSnapshotSchema = z.discriminatedUnion('version', [
  renderSnapshotV2Schema,
  renderSnapshotV1Schema,
]);

export type RenderSnapshot = z.infer<typeof renderSnapshotSchema>;
export type RenderSnapshotV2 = z.infer<typeof renderSnapshotV2Schema>;
export class InvalidRenderInput extends Error {}

export function parseRenderSnapshot(value: unknown): RenderSnapshot {
  const result = renderSnapshotSchema.safeParse(value);
  if (!result.success) throw new InvalidRenderInput('Invalid frozen render input');
  return result.data;
}

/** True when a snapshot requires (and promises) the qualified dual output. */
export function requiresDualOutput(snapshot: RenderSnapshot): snapshot is RenderSnapshotV2 {
  return snapshot.version === 2;
}

export async function captureSnapshot(tx: Transaction, submission: Submission, actor: Actor, force = false) {
  let warnings: DpiWarning[] = [];
  const base = {
    version: 2 as const,
    submissionId: submission.id,
    userId: submission.userId,
    submissionRevision: submission.revision,
    templateId: submission.templateId ?? null,
    templateVersion: submission.templateVersion ?? null,
    title: submission.title ?? null,
    printProfile: DEFAULT_PRINT_PROFILE.id,
    outputs: ['print-sheet', 'reading-pdf'] as const,
  };
  let input: RenderSnapshot;
  if (submission.mode === 'LEGACY_UPLOAD') {
    const images = await tx.submissionImage.findMany({ where: { submissionId: submission.id } });
    if (images.some(img => !img.s3Key.startsWith(`uploads/${submission.userId}/`))) {
      throw new SubmissionError(403, 'An uploaded image belongs to another account');
    }
    input = renderSnapshotSchema.parse({ ...base, mode: 'LEGACY_UPLOAD', renderer: 'raster', images, pages: [], assets: [] });
  } else {
    const pages = await mergedPages(tx, submission);
    const assets = await validateSceneAssets(tx, pages.map(p => p.scene), actor);
    const dimensions = new Map(assets.filter(a => a.width && a.height).map(a => [a.id, { width: a.width!, height: a.height! }]));
    warnings = checkSubmissionResolution(pages, dimensions);
    if (!force && warnings.some(w => w.severity === 'error')) {
      throw new SubmissionError(422, 'Some images have very low resolution and may print poorly.', { canForce: true, dpiWarnings: warnings });
    }
    input = renderSnapshotSchema.parse({ ...base, mode: 'EDITOR', renderer: 'raster', pages, assets, images: [] });
  }
  return { input, warnings };
}
