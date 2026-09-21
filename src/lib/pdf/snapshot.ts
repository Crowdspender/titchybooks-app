import { z } from 'zod';
import type { Submission } from '@prisma/client';
import { PAGE_LABELS } from '@/lib/constants';
import { editorSceneSchema } from '@/lib/editor/schema';
import { mergedPages, validateSceneAssets, SubmissionError, type Transaction, type Actor } from '@/lib/editor/submission-store';
import { checkSubmissionResolution, type DpiWarning } from '@/lib/editor/validation';

const assetSchema = z.object({
  id: z.string().min(1), s3Key: z.string().min(1), mimeType: z.string(),
  width: z.number().nullable(), height: z.number().nullable(),
});
export const renderSnapshotSchema = z.object({
  version: z.literal(1),
  userId: z.string().min(1), submissionId: z.string().min(1),
  renderer: z.enum(['raster', 'vector']),
  mode: z.enum(['EDITOR', 'LEGACY_UPLOAD']),
  pages: z.array(z.object({ pageLabel: z.enum(PAGE_LABELS), scene: editorSceneSchema })),
  assets: z.array(assetSchema),
  images: z.array(z.object({ pageLabel: z.enum(PAGE_LABELS), s3Key: z.string().min(1) })),
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
export type RenderSnapshot = z.infer<typeof renderSnapshotSchema>;
export class InvalidRenderInput extends Error {}
export function parseRenderSnapshot(value: unknown) {
  const result = renderSnapshotSchema.safeParse(value);
  if (!result.success) throw new InvalidRenderInput('Invalid frozen render input');
  return result.data;
}

export async function captureSnapshot(tx: Transaction, submission: Submission, actor: Actor, force = false) {
  let warnings: DpiWarning[] = [];
  const base = { version: 1 as const, submissionId: submission.id, userId: submission.userId };
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
    input = renderSnapshotSchema.parse({ ...base, mode: 'EDITOR', renderer: process.env.VECTOR_RENDER === 'true' ? 'vector' : 'raster', pages, assets, images: [] });
  }
  return { input, warnings };
}
