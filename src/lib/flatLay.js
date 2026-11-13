/**
 * Where each piece of an outfit sits in the Suggestions flat lay. Figma: Suggestion (2043:8151, design/
 * export-2/frames/outfit-card.png). Boxes are the frame's, in px from the screen's top left:
 *   top 181-733 x 731-1172, bracelet 657-849 x 1078-1176, bag 575-905 x 1295-1665,
 *   trousers 125-720 x 1190-2635, boots 565-905 x 2205-2620.
 * A one-piece takes the top and the trousers' space. A layer (outerwear) and up to two accessories take the
 * bag's and the bracelet's places; anything more isn't drawn (the card in the cart still lists it).
 * Pure: tested in lib.test.js.
 */
export const SLOTS = {
  top: { left: 181, top: 731, width: 552, height: 441 },
  onepiece: { left: 150, top: 731, width: 600, height: 1880 },
  bottom: { left: 125, top: 1190, width: 595, height: 1445 },
  shoes: { left: 565, top: 2205, width: 340, height: 415 },
  sideBig: { left: 575, top: 1295, width: 330, height: 370 }, // the bag's place
  sideSmall: { left: 657, top: 1040, width: 192, height: 170 }, // the bracelet's place
};

/** [{ item, index, slot }] for the pieces that get a place, in drawing order (bottoms first, top last). */
export function flatLay(items = []) {
  const placed = [];
  const taken = new Set();
  const put = (item, index, name) => {
    if (taken.has(name)) return false;
    taken.add(name);
    placed.push({ item, index, slot: name, box: SLOTS[name] });
    return true;
  };
  const sides = ["sideBig", "sideSmall"];
  items.forEach((item, index) => {
    const category = item.category;
    if (category === "onepiece") put(item, index, "onepiece") && taken.add("top").add("bottom");
    else if (category === "top" || category === "bottom" || category === "shoes") put(item, index, category);
  });
  // Layers before accessories, so a coat gets the bigger place.
  for (const category of ["outerwear", "accessory"]) {
    items.forEach((item, index) => {
      if (item.category === category) {
        const free = sides.find((name) => !taken.has(name));
        if (free) put(item, index, free);
      }
    });
  }
  const order = ["onepiece", "bottom", "shoes", "sideBig", "top", "sideSmall"];
  return placed.sort((a, b) => order.indexOf(a.slot) - order.indexOf(b.slot));
}
