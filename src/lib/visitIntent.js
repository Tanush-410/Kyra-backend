/**
 * Turns what the visitor picked in onboarding (?category=..., and the voice text in router state) into the
 * backend's session request: { style, gender }. The backend designs outfits for `style` (at most 120
 * characters). The spoken words never go in the address: browsers keep addresses in their history.
 *
 * category: a piece id from the picks screens ("tops-male", "one-pieces-female", ...), or
 *           "somethingspecific", or nothing ("null" when an earlier screen had none).
 * q:        what the visitor said on the Listening screen.
 */
export const DEFAULT_STYLE = "Surprise me: an everyday outfit";
const MAX_STYLE = 120;

const PIECES = {
  tops: "a top",
  bottoms: "bottoms",
  footwear: "footwear",
  footware: "footwear", // the female picks screen spells it this way
  accessories: "accessories",
  "one-pieces": "a one-piece, such as a dress or jumpsuit",
};

function clean(value) {
  const text = String(value ?? "").trim();
  return text === "null" || text === "undefined" ? "" : text;
}

export function visitIntent({ category, q } = {}) {
  const id = clean(category).toLowerCase();
  const said = clean(q).replace(/\s+/g, " ");
  const gender = id.endsWith("-female") ? "female" : id.endsWith("-male") ? "male" : null;
  const piece = PIECES[id.replace(/-(male|female)$/, "")] || null;

  let style = said || DEFAULT_STYLE;
  if (piece) style = `${style}, built around ${piece}`;
  if (style.length > MAX_STYLE) style = `${style.slice(0, MAX_STYLE - 1).trimEnd()}…`;

  return { style, gender, piece };
}

/** The category and voice text from a screen's location (router state first; an old ?q= link still works). */
export function intentFromLocation(location, params) {
  return {
    category: location?.state?.id ?? params.get("category"),
    q: location?.state?.text ?? params.get("q"),
  };
}

/** Query string that carries the category to the next screen (the voice text goes in router state). */
export function intentQuery({ category }) {
  const query = new URLSearchParams();
  if (clean(category)) query.set("category", clean(category));
  const text = query.toString();
  return text ? `?${text}` : "";
}
