/**
 * Every outfit designed in this visit, oldest set first: each edit or "More like this" adds a set of
 * three, and the earlier ones stay reachable in Suggestions. Pure: tested in lib.test.js.
 */
export function allOutfits(session) {
  const rounds = Object.keys(session?.rounds || {})
    .map(Number)
    .filter((n) => session.rounds[n]?.length)
    .sort((a, b) => a - b);
  return rounds.flatMap((round) => session.rounds[round].map((option) => ({ ...option, round })));
}

/** Where a set starts in allOutfits (the first outfit of that round), or 0. */
export function setStart(outfits, round) {
  const at = outfits.findIndex((o) => o.round === round);
  return at < 0 ? 0 : at;
}

/** "2 of 3", or "Set 2 of 2 · 1 of 3" once there is more than one set. */
export function outfitCount(outfits, index) {
  const outfit = outfits[index];
  if (!outfit) return "";
  const sets = [...new Set(outfits.map((o) => o.round))];
  const inSet = outfits.filter((o) => o.round === outfit.round);
  const position = `${inSet.indexOf(outfit) + 1} of ${inSet.length}`;
  return sets.length > 1 ? `Set ${sets.indexOf(outfit.round) + 1} of ${sets.length} · ${position}` : position;
}
