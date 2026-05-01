import { PAGE_LABELS, type PageLabel } from "@/lib/constants";
import {
  createEmptyEditorScene,
  editorSceneSchema,
  stringifyEditorScene,
  type EditorScene,
} from "./schema";

export interface EmptySubmissionPageSeed {
  pageLabel: PageLabel;
  order: number;
  scene: EditorScene;
  sceneJson: string;
}

export function createEmptySubmissionPageSeeds(): EmptySubmissionPageSeed[] {
  return PAGE_LABELS.map((pageLabel, order) => {
    const scene = createEmptyEditorScene();
    return {
      pageLabel,
      order,
      scene,
      sceneJson: stringifyEditorScene(scene),
    };
  });
}

export function validateEditorScene(scene: unknown): EditorScene {
  return editorSceneSchema.parse(scene);
}

export function isKnownPageLabel(value: string): value is PageLabel {
  return PAGE_LABELS.includes(value as PageLabel);
}
