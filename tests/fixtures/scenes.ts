import { createEmptyEditorScene, type EditorElement } from '@/lib/editor/schema';

/** Continuous prose for a full 19-line legacy story frame (580px wide, 28px Arial). */
export const FULL_INTERIOR_TEXT =
  'The lantern glows beside the window while the rain taps softly on the glass. ' +
  'Beyond the dunes the sea keeps its long, patient breathing, and the little house ' +
  'holds its warmth against the dark. A child counts the falling drops and wonders ' +
  'where the light goes when morning comes. Her grandmother opens a book and points ' +
  'to a drawing of the harbor. Together they follow the route that the fishing boats ' +
  'will take when the storm is over. They find the narrow channel between the rocks ' +
  'and the sheltered beach where the seabirds gather. The child traces each bend ' +
  'with a careful finger, then sketches a small lantern beside the harbor wall. ' +
  'Now every sailor in her picture has a light to guide the journey home. ' +
  'She closes the book, certain that even a small light can make a dark night less lonely.';

/** Distinct, editorially complete sections; natural wrapping, no fill padding. */
export const NATURAL_GUIDE_SECTIONS = [
  'Start a small garden by watching the place you hope to use. Notice where morning light falls, where rain collects, and whether the soil stays wet after a storm. A sunny corner beside the kitchen can be more useful than a larger patch you rarely visit. Choose a place that is easy to reach with a watering can and safe to walk around.\nBegin with a few plants you enjoy eating rather than a long shopping list. Read their labels, allow room for mature leaves, and keep one clear path through the bed. Draw a simple map before digging. Mark the tap, the gate, and any shade from nearby trees. That sketch will help you choose sensible positions and remember what changed as the season passed.',
  'Healthy soil gives roots air, water, and a steady supply of nutrients. Lift a handful from the bed and crumble it gently. If it forms a sticky lump, wait until it dries before working it; digging wet soil can squeeze out the spaces roots need. Remove sharp litter and persistent weeds, but leave useful worms and other small creatures undisturbed.\nSpread a thin layer of mature compost across the surface. There is no need to bury the bed beneath rich material or buy every product in the shop. Water a small test area and watch how quickly it drains. If water sits for hours, ask a local grower about containers or a raised bed. Good preparation is patient observation, not a race to plant everything at once.',
  'Choose seeds that suit your local season and the space available. A packet contains useful instructions about depth, spacing, and when to plant. Keep those instructions with your garden map. Some vegetables can be sown directly into the bed; others need a sheltered start where cold nights will not damage tender leaves.\nMake a shallow row, place the seeds carefully, and cover them without pressing the soil hard. Label the row immediately, then water with a gentle spray. Save unused seeds in a cool, dry place. Check the row each day, but avoid digging to see whether roots have appeared. When the seedlings emerge, compare them with the label and give crowded plants room to grow.',
  'Water according to the soil, not merely the date on a calendar. Push a finger a little below the surface before reaching for the hose. A dry crust may hide damp earth, while a container in warm wind can dry out faster than the garden bed. Young roots need reliable moisture, but standing water can harm them just as surely as neglect.\nAim water near the roots and let it soak in slowly. A morning visit makes it easier to notice changes before the heat of the day. Put a thin mulch around established plants, keeping it away from stems. After heavy rain, check drainage and empty any saucers beneath pots. Keep a short note of what you watered; the pattern will teach you more than guessing from one afternoon.',
  'Visit the garden regularly and look closely before treating a problem. A few holes in a leaf do not always mean a plant is in danger. Check the underside, the stem, and nearby soil. Notice whether useful insects are present and whether damage is spreading. Photograph an unfamiliar visitor and ask a reliable local source to identify it before using a spray.\nRemove dead leaves when they hide disease, and wash tools after working on an affected plant. Support climbing stems before they become heavy. Keep paths clear so every plant can be inspected safely. If one crop fails, record the weather and the symptoms. Careful notes turn a disappointing season into useful evidence for the next one.',
  'Harvest a little at a time when the crop is ready, using clean tools and a basket that will not crush tender leaves. Look up the signs of maturity for each vegetable rather than assuming the largest fruit is best. Pick regularly where that encourages new growth, and leave enough healthy foliage for the plant to keep feeding itself.\nShare surplus with a neighbor or prepare it promptly for the kitchen. At the end of the season, remove diseased material, clean empty containers, and keep a note of the varieties you would grow again. Compare your first sketch with the current bed. A small garden does not need to be perfect to provide good food, quiet work, and a reason to step outdoors tomorrow.',
];

const base = { x: 30, y: 40, width: 250, height: 90, rotation: 0, opacity: 1, locked: false, visible: true, zIndex: 0 };
export function textElement(id = 'text', text = id): EditorElement {
  return { ...base, type: 'text', id, text, fontFamily: 'Arial', fontSize: 32, fontWeight: 400,
    lineHeight: 1.2, letterSpacing: 0, color: '#123456', align: 'left' };
}
export function imageElement(assetId: string): EditorElement {
  return { ...base, id: `image-${assetId}`, type: 'image', assetId, crop: { x: 0, y: 0, scaleX: 1, scaleY: 1 } };
}
export function sceneWithText(text: string) {
  return { ...createEmptyEditorScene(), elements: [textElement(text)] };
}
