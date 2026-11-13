import { KYRA_TAG_PATH } from "./nfcRoutes.js";
import { ACCOUNT_PATH, BYE_PATH, EDIT_PATH, SHOP_PATH, SKIN_TONE_PATH } from "./shopRoutes.js";

/** A pinch on empty screen (no button near it) goes back one screen: HandTrackingContext fires this event. */
export const PINCH_EMPTY_EVENT = "kyra:pinch-empty";

/**
 * A click (mouse or touch) on something in here does its own thing, so it isn't "back": buttons and links,
 * form fields, whatever is marked pinchable, the open Rate card's tap-to-close area, and elements that act on
 * a click themselves (the start screen, the Welcome logo, Build your profile).
 */
export const OWN_CLICK = 'button, a[href], [role="button"], [data-pinch], [data-pinch-tap], input, select, textarea, label, .splash';

// Screens that never go back: the start (nothing before it), and the end of a visit.
const NO_BACK = new Set(["/", BYE_PATH, KYRA_TAG_PATH]);
// From the photo onwards: going back stays among these, never into consent, hold still or onboarding.
const AFTER_PHOTO = [SKIN_TONE_PATH, SHOP_PATH, EDIT_PATH, ACCOUNT_PATH];
const afterPhoto = (path) => AFTER_PHOTO.some((p) => path === p || path.startsWith(`${p}/`));

/** Where "back" would land, or null when it shouldn't go back from here. Pure (unit-tested). */
export function pinchBackTarget({ stack, sessionActive, modalOpen }) {
  if (modalOpen || stack.length < 2) return null;
  const here = stack[stack.length - 1];
  const target = stack[stack.length - 2];
  if (NO_BACK.has(here) || target === BYE_PATH || target === KYRA_TAG_PATH) return null;
  // A visit has started (the consent screen starts it): no way back into the screens before the photo.
  if (sessionActive && !afterPhoto(target)) return null;
  return target;
}
