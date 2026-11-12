/**
 * The edit flow (Figma "Edit": "What would you like to edit?", "What's on your mind?", voice) turned
 * into feedback for POST /api/v2/sessions/:id/redesign.
 *
 * The backend can't swap one piece: each edit designs a new round of three outfits and renders the
 * first. So the feedback says what to keep (the rest of this outfit, by name, so the model knows what
 * "the rest" is) and what to change, in at most 200 characters (the backend's limit), using only the
 * characters its prompt cleaner keeps (letters, digits, spaces and . , ' & ( ) / % + -; normalize.js
 * promptText). Pure: tested in lib.test.js.
 */
export const MAX_FEEDBACK = 200;

const icon = (name) => `assets/icons/${name}`;

// The categories, as on the onboarding picks screens. The design's icons for women; neutral ones otherwise.
export function editPieces(gender) {
  if (gender === "female") {
    return [
      { key: "top", label: "Tops", icon: icon("tops-women.png"), iconWidth: 200 },
      { key: "bottom", label: "Bottoms", icon: icon("bottom-women.png"), iconWidth: 253 },
      { key: "shoes", label: "Footwear", icon: icon("shoes-women.png"), iconWidth: 200 },
      { key: "accessory", label: "Accessories", icon: icon("bag-women.png"), iconWidth: 200 },
      { key: "onepiece", label: "One-Pieces", icon: icon("dress-women.png"), iconWidth: 200 },
    ];
  }
  return [
    { key: "top", label: "Tops", icon: icon("tops.png"), iconWidth: 200 },
    { key: "bottom", label: "Bottoms", icon: icon("bottoms.png"), iconWidth: 200 },
    { key: "shoes", label: "Footwear", icon: icon("shoes.png"), iconWidth: 200 },
    { key: "accessory", label: "Accessories", icon: icon("glasses.png"), iconWidth: 244 },
  ];
}

/** Figma "What's on your mind?". words: the visitor says what they want (voice). */
export const INTENTS = [
  { key: "similar", label: "Something similar", words: false },
  { key: "different", label: "Something different", words: false },
  { key: "suggest", label: "Suggest changes", words: true },
  { key: "know", label: "I know what I want", words: true },
];

const PIECE_WORDS = {
  top: "the top",
  bottom: "the bottoms",
  shoes: "the shoes",
  accessory: "the accessories",
  onepiece: "the one-piece",
};
// Backend categories that count as this piece (outfit-design.js CATEGORIES).
const MATCHES = { top: ["top", "outerwear"], bottom: ["bottom"], shoes: ["shoes"], accessory: ["accessory"], onepiece: ["onepiece"] };

// What the backend's promptText keeps; anything else becomes a space there, so leave it out here.
const KEEP = /[^\p{L}\p{M}\p{N} .,'&()/%+-]/gu;
const clean = (text) => String(text ?? "").replace(KEEP, " ").replace(/\s+/g, " ").trim();
const cut = (text, max) => (text.length <= max ? text : `${text.slice(0, Math.max(0, max - 3)).trimEnd()}...`);

/**
 * option: the outfit being edited ({ title, items }); piece: an editPieces key; intent: an INTENTS key;
 * words: what the visitor said (for "suggest" / "know").
 * -> e.g. "Keep the rest of the outfit 'Olive weekend' (Crew tee, Loafers). Change the bottoms (something different)."
 */
export function editFeedback({ option, piece, intent, words = "" }) {
  const target = PIECE_WORDS[piece] || "one piece";
  const matches = MATCHES[piece] || [];
  const items = option?.items || [];
  const has = items.some((item) => matches.includes(item.category));
  const rest = items.filter((item) => !matches.includes(item.category)).map((item) => clean(item.name)).filter(Boolean);
  const said = clean(words);
  const change =
    intent === "similar" ? "something similar" : intent === "different" ? "something different" : said || "something different";
  const title = cut(clean(option?.title) || "this outfit", 40);
  const verb = `${has ? "Change" : "Add"} ${target}`;

  // Fit 200: the instruction and the visitor's words first, then as many of the kept pieces as fit.
  const head = (names) => `Keep the rest of the outfit '${title}'${names ? ` (${names})` : ""}. `;
  const tail = `${verb} (${change}).`;
  let names = rest.join(", ");
  while (names && head(names).length + tail.length > MAX_FEEDBACK) {
    rest.pop();
    names = rest.length ? `${rest.join(", ")}, ...` : "";
  }
  const text = head(names) + tail;
  return text.length <= MAX_FEEDBACK ? text : `${head("")}${verb} (${cut(change, MAX_FEEDBACK - head("").length - verb.length - 3)}).`;
}

/** "More like this": a new set around this outfit's style and colours (same rules as an edit). */
export function moreLikeFeedback(option) {
  const title = cut(clean(option?.title) || "this outfit", 40);
  const summary = clean(option?.summary);
  const text = `More like the outfit '${title}'${summary ? ` (${summary})` : ""}. Keep its style and colours, with different pieces.`;
  return text.length <= MAX_FEEDBACK ? text : `More like the outfit '${title}'. Keep its style and colours, with different pieces.`;
}
