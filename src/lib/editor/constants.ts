import { SubmissionMode } from "@/lib/constants";

export const EDITOR_SCENE_VERSION = 1;
export const EDITOR_PAGE_WIDTH_PX = 700;
export const EDITOR_PAGE_HEIGHT_PX = 1000;
export const EDITOR_DEFAULT_BACKGROUND_COLOR = "#ffffff";
export const EDITOR_SAFE_MARGIN_PX = 12;
export const EDITOR_MAX_ELEMENTS_PER_PAGE = 100;

export const EDITOR_SUBMISSION_MODE = SubmissionMode.EDITOR;

// Permanent branding text printed on the BACK_COVER panel of every Titchybooks.
// The back cover panel is intentionally shorter than the other panels to reserve
// a strip at the bottom of the printed cover for this branding.
export const BACK_COVER_BRAND_TEXT = "www.titchybooks.com";
// Height (in editor scene pixels) of the reserved branding band at the bottom
// of the back cover. Approximately matches the ~6.7mm gap between the back
// cover panel and its taller neighbours on the printed sheet.
export const BACK_COVER_BRAND_BAND_PX = 60;

