import { withLook } from "../components/FigmaProductCard.jsx";
import { editsForLook } from "../state/sessionReducer.js";

/**
 * An outfit dropped on the cart (pinch and drag, on Suggestions and the virtual try-on): each piece goes in as
 * a product with its price, size and stock, one of each, with its product photo when it has one. Pieces the
 * visitor swapped in the shop's edit flow go in as the swapped product. Out-of-stock pieces are left out.
 * Prices, brands and stock are placeholders (data/shopPlaceholders.js) until a real product feed exists.
 *
 * Returns how many pieces were added.
 */
export async function addLookToCart({ option, shop, addToCart, photoFor = () => null }) {
  if (!option) return 0;
  const { firstAvailableSize, productsForLook } = await import("../data/shopPlaceholders.js");
  const key = `${option.round}.${option.option}`;
  let added = 0;
  for (const product of productsForLook(option, key, editsForLook(shop, key))) {
    if (!product.stock) continue;
    const at = product.replacesProductId ? -1 : Number(String(product.id).split(":").pop());
    addToCart(withLook(product, option, at >= 0 ? photoFor(at) : null), { size: firstAvailableSize(product), qty: 1 });
    added += 1;
  }
  return added;
}
