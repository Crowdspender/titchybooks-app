import { parse, type Font } from "opentype.js";
import manifest from "./design-font-manifest.json";
import type { EditorElement } from "./schema";

export type DesignText = Extract<EditorElement, { type: "text" }>;
export const FONT_MANIFEST: Record<string, Array<{ file: string; sha256: string }>> = manifest;
const fonts = new Map<string, Font[]>();
const loading = new Map<string, Promise<void>>();
export function faceId(element: Pick<DesignText, "fontFamily" | "fontWeight" | "italic">): string {
  const slug = ({ Lora: "lora", "Source Sans 3": "source-sans-3", Nunito: "nunito" } as Record<string, string>)[element.fontFamily];
  if (!slug) throw new Error(`Unqualified font: ${element.fontFamily}`);
  return `${slug}-${element.fontWeight >= 600 ? 700 : 400}-${element.italic ? "italic" : "normal"}`;
}
export function registerDesignFont(id: string, buffers: ArrayBuffer[]) {
  if (!FONT_MANIFEST[id] || buffers.length !== FONT_MANIFEST[id].length) throw new Error(`Invalid font assets: ${id}`);
  fonts.set(id, buffers.map(buffer => {
    const font = parse(buffer);
    // These qualified faces are Latin. DFLT may exist without the Latin kern
    // feature, so pin the script instead of relying on OpenType's default.
    const position = (font as Font & { position: { getKerningTables(script: string): unknown[] | undefined; defaultKerningTables?: unknown[] } }).position;
    const latin = position.getKerningTables('latn');
    if (latin?.length) position.defaultKerningTables = latin;
    return font;
  }));
}
export function getDesignFont(id: string): Font[] {
  const font = fonts.get(id);
  if (!font) throw new Error(`Font is not loaded: ${id}`);
  return font;
}
export function designFontReady(id: string) { return fonts.has(id); }
export function loadBrowserDesignFont(id: string): Promise<void> {
  if (fonts.has(id)) return Promise.resolve();
  if (!FONT_MANIFEST[id]) return Promise.reject(new Error(`Unknown font ${id}`));
  let pending = loading.get(id);
  if (!pending) {
    pending = Promise.all(FONT_MANIFEST[id].map(async asset => {
      const response = await fetch(asset.file);
      if (!response.ok) throw new Error(`Could not load ${id}. Retry when connected.`);
      const bytes = await response.arrayBuffer();
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), byte => byte.toString(16).padStart(2, "0")).join("");
      if (hash !== asset.sha256) throw new Error(`Font integrity check failed: ${id}`);
      return bytes;
    })).then(buffers => registerDesignFont(id, buffers)).finally(() => loading.delete(id));
    loading.set(id, pending);
  }
  return pending;
}
export function requiredDesignFonts(elements: EditorElement[]): string[] {
  return [...new Set(elements.flatMap(el => el.type === "text" && el.typographyVersion ? [faceId(el)] : []))].sort();
}
