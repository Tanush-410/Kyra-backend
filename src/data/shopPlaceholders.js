/**
 * PLACEHOLDER product data for the shop screens.
 *
 * The backend's look payload has no price, size, SKU, stock or per-piece image yet, so every value
 * below is derived deterministically from the look item. Replace this module with the real store
 * feed (or a new API response) when it lands; screens only depend on the exported helpers.
 */

export const PLACEHOLDER_CATALOGUE = true;
export const CURRENCY = "INR";
export const UK_SIZES = ["UK 4", "UK 6", "UK 8", "UK 10", "UK 12", "UK 14"];

const BRANDS = [
  "Aarav & Co.",
  "Indigo House",
  "Kala Studio",
  "Loom & Co.",
  "Mirage",
  "North Star",
  "Prana",
  "Rasa",
  "Suta",
  "The Edit",
  "Terra",
  "Veda",
];

const CATEGORY_LABEL = {
  top: "Tops",
  bottom: "Bottoms",
  onepiece: "Dresses",
  outerwear: "Outerwear",
  shoes: "Shoes",
  accessory: "Accessories",
};

const CATEGORY_ICON = {
  top: "tops",
  bottom: "bottoms",
  onepiece: "dress-women",
  outerwear: "tops",
  shoes: "shoes",
  accessory: "bag-women",
};

const CATEGORY_VARIANTS = {
  top: [
    { name: "Relaxed linen shirt", material: "Linen", fit: "Relaxed" },
    { name: "Ribbed knit top", material: "Cotton blend", fit: "Slim" },
    { name: "Boxy cotton tee", material: "Cotton", fit: "Boxy" },
    { name: "Satin camisole", material: "Satin", fit: "Straight" },
  ],
  bottom: [
    { name: "Wide-leg trousers", material: "Crepe", fit: "Wide leg" },
    { name: "Straight jeans", material: "Denim", fit: "Straight" },
    { name: "Pleated midi skirt", material: "Georgette", fit: "A-line" },
    { name: "Tailored shorts", material: "Cotton twill", fit: "Tailored" },
  ],
  onepiece: [
    { name: "Column maxi dress", material: "Viscose", fit: "Column" },
    { name: "Wrap midi dress", material: "Crepe", fit: "Wrap" },
    { name: "Shirt dress", material: "Cotton poplin", fit: "Relaxed" },
    { name: "A-line mini dress", material: "Linen", fit: "A-line" },
  ],
  outerwear: [
    { name: "Longline blazer", material: "Wool blend", fit: "Tailored" },
    { name: "Utility jacket", material: "Cotton twill", fit: "Relaxed" },
    { name: "Cropped cardigan", material: "Merino", fit: "Slim" },
    { name: "Trench coat", material: "Gabardine", fit: "Straight" },
  ],
  shoes: [
    { name: "Leather loafers", material: "Leather", fit: "Regular" },
    { name: "Block-heel sandals", material: "Leather", fit: "Regular" },
    { name: "Canvas sneakers", material: "Canvas", fit: "Regular" },
    { name: "Pointed flats", material: "Suede", fit: "Regular" },
  ],
  accessory: [
    { name: "Structured tote", material: "Vegan leather", fit: "Regular" },
    { name: "Silk scarf", material: "Silk", fit: "Regular" },
    { name: "Hoop earrings", material: "Brass", fit: "Regular" },
    { name: "Woven belt", material: "Leather", fit: "Regular" },
  ],
};

function hash(text) {
  let value = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    value ^= text.charCodeAt(index);
    value = Math.imul(value, 16777619);
  }
  return value >>> 0;
}

function slug(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

export function formatPrice(value) {
  return `₹${Math.round(Number(value) || 0).toLocaleString("en-IN")}`;
}

export function categoryLabel(category) {
  return CATEGORY_LABEL[category] || "Pieces";
}

export function categoryIcon(category) {
  return CATEGORY_ICON[category] || "tops";
}

export function productFromItem(item, { lookKey = "look", index = 0 } = {}) {
  const category = item?.category || "top";
  const seed = hash(`${lookKey}|${category}|${item?.name || index}`);
  const price = 1299 + (seed % 45) * 100;
  const stock = seed % 9 === 0 ? 0 : 1 + (seed % 3);
  const outOfStockSizes = UK_SIZES.filter((_, sizeIndex) => (seed + sizeIndex) % 7 === 0);
  const fallbackVariant = CATEGORY_VARIANTS[category]?.[seed % CATEGORY_VARIANTS[category].length] || {
    material: "Cotton",
    fit: "Regular",
  };
  const name = item?.name || fallbackVariant.name;
  const material = item?.material || fallbackVariant.material;
  const fit = item?.fit || fallbackVariant.fit;
  const colorName = item?.colorName || "Neutral";
  return {
    id: `look:${lookKey}:${category}:${index}`,
    lookKey,
    category,
    name,
    brand: BRANDS[seed % BRANDS.length],
    price,
    currency: CURRENCY,
    colorName,
    hex: item?.hex || null,
    material,
    fit,
    description: `${colorName} ${material.toLowerCase()} · ${fit.toLowerCase()} fit. A placeholder pick from the ${categoryLabel(category).toLowerCase()} rail.`,
    tags: [material, fit, colorName].filter(Boolean),
    sizes: UK_SIZES,
    outOfStockSizes,
    stock,
    iconKey: categoryIcon(category),
    placeholder: PLACEHOLDER_CATALOGUE,
  };
}

export function productsFromOption(option, lookKey = "look") {
  if (!option?.items?.length) return [];
  return option.items.map((item, index) => productFromItem(item, { lookKey, index }));
}

export function applyFilters(products, filters) {
  const rawFrom = Number(filters?.from ?? 0);
  const rawTo = Number(filters?.to ?? Number.POSITIVE_INFINITY);
  const from = Math.min(rawFrom, rawTo);
  const to = Math.max(rawFrom, rawTo);
  return (products || []).filter((product) => product.price >= from && product.price <= to);
}

export function firstAvailableSize(product) {
  const sizes = product?.sizes || UK_SIZES;
  const unavailable = new Set(product?.outOfStockSizes || []);
  return sizes.find((size) => !unavailable.has(size)) || sizes[0] || "";
}

export function replacementProduct(baseProduct, variant = 0, request = "") {
  const base = baseProduct || productFromItem({ category: "top", name: "Piece" }, { lookKey: "edit" });
  const variants = CATEGORY_VARIANTS[base.category] || CATEGORY_VARIANTS.top;
  const seed = hash(`${base.id}|${variant}`);
  const option = variants[(base.id.length + variant) % variants.length];
  const price = Math.max(499, Math.min(9599, (Number(base.price) || 1999) + ((seed % 5) - 2) * 200));
  const outOfStockSizes = UK_SIZES.filter((_, sizeIndex) => (seed + sizeIndex + variant) % 8 === 0);
  return {
    ...base,
    id: `replacement:${base.category}:${slug(base.id)}:${variant}`,
    brand: BRANDS[(seed + variant) % BRANDS.length],
    name: option.name,
    material: option.material,
    fit: option.fit,
    colorName: base.colorName || "Neutral",
    description: `${base.colorName || "Neutral"} ${option.material.toLowerCase()} · ${option.fit.toLowerCase()} fit. Placeholder replacement for ${base.name}.`,
    tags: [option.material, option.fit, base.colorName].filter(Boolean),
    price,
    stock: Math.max(1, 1 + (seed % 3)),
    outOfStockSizes,
    sizes: base.sizes || UK_SIZES,
    replacesProductId: base.id,
    placeholder: PLACEHOLDER_CATALOGUE,
    request: request || "",
  };
}

/** The look's products with the pieces picked on the Edit screen taking their category's place. */
export function productsForLook(option, lookKey, edits) {
  return productsFromOption(option, lookKey).map((product) =>
    edits?.[product.category] ? { ...edits[product.category], category: product.category } : product,
  );
}
