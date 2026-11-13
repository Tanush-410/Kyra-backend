import { formatPrice } from "../data/shopPlaceholders.js";
import "./FigmaProductCard.css";

const icon = (name) => `${import.meta.env.BASE_URL}assets/icons/${name}`;
const PAIR_ICON = { top: "tops.png", onepiece: "tops.png", outerwear: "tops.png", bottom: "bottoms.png", shoes: "shoes.png", accessory: "glasses.png" };
const LABEL = { top: "Top", bottom: "Bottoms", onepiece: "One-piece", outerwear: "Layer", shoes: "Footwear", accessory: "Accessory" };
const cap = (text) => (text ? String(text)[0].toUpperCase() + String(text).slice(1) : "");

/**
 * The product card from Figma "Suggestion to buy" and "Cart" (Component 71; design/export-2/frames
 * buy-card.png and cart-card.png). 850px wide; positions inside it are the frame's, measured from the
 * card's top (the photo's top): brand at 740, name (53px, two lines), price pill 237 x 98 at the right,
 * the "why" quote at 921, tag chips from 1065, "Pairs with" at 1210, Quantity and Size at the right
 * (1076, 1176), a rule at 1330.
 *
 * product: { brand, name, price, colorName, hex, material, fit, category, photoUrl?, quote?, pairs? }
 * The prices, brands, sizes and stock are the shop demo's placeholders (data/shopPlaceholders.js).
 */
export default function FigmaProductCard({ product, qty = 1, size, onQty, onSize, onPhoto, photoRef }) {
  const tags = [
    product.colorName && `Color : ${product.colorName}`,
    product.material && `Material : ${cap(product.material)}`,
    product.fit && `Fit : ${cap(product.fit)}`,
    `Category : ${LABEL[product.category] || cap(product.category)}`,
  ].filter(Boolean);
  const light = isLight(product.hex);
  return (
    <article className="fpc">
      <button type="button" ref={photoRef} className="fpc__photo" onClick={onPhoto} aria-label={`${product.name}: options`} data-pinch-drag="">
        {product.photoUrl ? (
          <img src={product.photoUrl} alt="" />
        ) : (
          <span className={`fpc__tile${light ? " fpc__tile--light" : ""}`} style={{ background: product.hex || "#777" }}>
            <img src={icon(PAIR_ICON[product.category] || "tops.png")} alt="" />
          </span>
        )}
      </button>
      <span className="fpc__brand">{product.brand}</span>
      <h2 className="fpc__name">{product.name}</h2>
      <span className="fpc__price">{formatPrice(product.price)}</span>
      {product.quote && <p className="fpc__quote">“{product.quote}”</p>}
      <ul className="fpc__tags">
        {tags.map((tag) => (
          <li key={tag}>{tag}</li>
        ))}
      </ul>
      {product.pairs?.length > 0 && (
        <div className="fpc__pairs">
          <span>Pairs with</span>
          <ul>
            {product.pairs.slice(0, 6).map((pair, i) => (
              <li key={`${pair.category}-${i}`} title={pair.name}>
                <img src={icon(PAIR_ICON[pair.category] || "tops.png")} alt={pair.name} />
              </li>
            ))}
          </ul>
        </div>
      )}
      <button type="button" className="fpc__select fpc__select--qty" onClick={onQty} disabled={!onQty}>
        Quantity : {qty} <span aria-hidden="true">⌃⌄</span>
      </button>
      <button type="button" className="fpc__select fpc__select--size" onClick={onSize} disabled={!onSize}>
        Size: {size || "Select"} <span aria-hidden="true">⌄</span>
      </button>
      <hr className="fpc__rule" />
    </article>
  );
}

/** Relative luminance above 0.55: a light colour (the icon on it turns dark). */
function isLight(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
  if (!m) return false;
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(m[1].slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.55;
}

/** The extra fields the card shows, from the outfit the piece belongs to: its "why" and the other pieces. */
export function withLook(product, option, photoUrl) {
  const others = (option?.items || []).filter((item) => !(item.category === product.category && item.name === product.name));
  return {
    ...product,
    photoUrl: photoUrl || product.photoUrl || null,
    quote: product.quote || shortQuote(option?.reasoning),
    pairs: others.map((item) => ({ category: item.category, name: item.name })),
  };
}

const shortQuote = (text) => {
  const line = String(text || "").trim();
  return line.length > 110 ? `${line.slice(0, 107).trimEnd()}…` : line;
};
