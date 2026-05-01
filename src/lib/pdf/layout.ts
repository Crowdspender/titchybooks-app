export interface PanelDefinition {
  pageLabel: string;
  order: number;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
}

// Conversion: 1 mm = 72/25.4 points
export const MM_TO_POINTS = 72 / 25.4;

export const A4_LANDSCAPE_WIDTH_MM = 297;
export const A4_LANDSCAPE_HEIGHT_MM = 210;
export const TARGET_DPI = 300;

export function mmToPoints(mm: number): number {
  return mm * MM_TO_POINTS;
}

/**
 * All panel coordinates in mm, as specified in the layout spec.
 * Top-left origin coordinate system.
 *
 * Top row: upright (rotation 0)
 * Bottom row: rotated 180 degrees
 */
export const PANELS: PanelDefinition[] = [
  // Top row (left to right, upright)
  {
    pageLabel: "BACK_COVER",
    order: 1,
    x: 3.9,
    y: 3.6,
    width: 69.3,
    height: 98,
    rotation: 0,
  },
  {
    pageLabel: "FRONT_COVER",
    order: 0,
    x: 77.4,
    y: 3.6,
    width: 69.3,
    height: 98,
    rotation: 0,
  },
  {
    pageLabel: "PAGE_2",
    order: 2,
    x: 151.5,
    y: 3.6,
    width: 69.6,
    height: 98.2,
    rotation: 0,
  },
  {
    pageLabel: "PAGE_3",
    order: 3,
    x: 225.5,
    y: 3.7,
    width: 68.4,
    height: 98.2,
    rotation: 0,
  },
  // Bottom row (right to left, rotated 180°)
  {
    pageLabel: "PAGE_4",
    order: 4,
    x: 224.8,
    y: 108.5,
    width: 68.3,
    height: 98,
    rotation: 180,
  },
  {
    pageLabel: "PAGE_5",
    order: 5,
    x: 151.6,
    y: 108.5,
    width: 68.5,
    height: 98,
    rotation: 180,
  },
  {
    pageLabel: "PAGE_6",
    order: 6,
    x: 77.4,
    y: 108.5,
    width: 69,
    height: 97.9,
    rotation: 180,
  },
  {
    pageLabel: "PAGE_7",
    order: 7,
    x: 3.9,
    y: 108.5,
    width: 69,
    height: 97.9,
    rotation: 180,
  },
];
