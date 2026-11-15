import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { designFontReady, FONT_MANIFEST, registerDesignFont, requiredDesignFonts } from "@/lib/editor/design-fonts";
import type { EditorElement } from "@/lib/editor/schema";

export function loadServerDesignFonts(elements: EditorElement[]) {
  for (const id of requiredDesignFonts(elements)) {
    if (designFontReady(id)) continue;
    const buffers = FONT_MANIFEST[id].map(asset => {
      const bytes = readFileSync(path.join(process.cwd(), "public", asset.file));
      if (createHash("sha256").update(bytes).digest("hex") !== asset.sha256) throw new Error(`Font integrity check failed: ${id}`);
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    });
    registerDesignFont(id, buffers);
  }
}
