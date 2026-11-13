import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyFilters,
  firstAvailableSize,
  formatPrice,
  productFromItem,
  productsForLook,
  productsFromOption,
  replacementProduct,
  UK_SIZES,
} from "./shopPlaceholders.js";

const option = {
  option: 1,
  title: "Look 1",
  items: [
    { category: "top", name: "Crew tee", colorName: "Cream", hex: "#EFE3C6", material: "Cotton", fit: "Regular" },
    { category: "bottom", name: "Wide trousers", colorName: "Ink", hex: "#1F2A44" },
  ],
};

test("look items become placeholder products with rupees, UK sizes and stock", () => {
  const products = productsFromOption(option, "1.1");
  assert.equal(products.length, 2);
  const [top] = products;
  assert.equal(top.id, "look:1.1:top:0");
  assert.equal(top.brand.length > 0, true);
  assert.equal(top.placeholder, true);
  assert.match(formatPrice(top.price), /^₹[0-9,]+$/);
  assert.deepEqual(top.sizes, UK_SIZES);
  assert.equal(top.stock >= 0, true);
  assert.equal(top.iconKey, "tops");
  assert.equal(products[1].iconKey, "bottoms");
});

test("placeholder values are deterministic for the same look item", () => {
  const first = productsFromOption(option, "1.1");
  const second = productsFromOption(option, "1.1");
  assert.deepEqual(first, second);
  const otherLook = productsFromOption(option, "2.3");
  assert.notEqual(first[0].id, otherLook[0].id);
});

test("filters include both ends and survive a swapped range", () => {
  const products = [
    { price: 500 },
    { price: 1500 },
    { price: 2500 },
    { price: 3500 },
  ];
  assert.deepEqual(applyFilters(products, { from: 1500, to: 2500 }), [{ price: 1500 }, { price: 2500 }]);
  assert.deepEqual(applyFilters(products, { from: 2500, to: 1500 }), [{ price: 1500 }, { price: 2500 }]);
  assert.equal(applyFilters(products, { from: 4000, to: 5000 }).length, 0);
});

test("the first available size skips one the placeholder marks out of stock", () => {
  const product = { sizes: UK_SIZES, outOfStockSizes: ["UK 4", "UK 6"] };
  assert.equal(firstAvailableSize(product), "UK 8");
  assert.equal(firstAvailableSize({ sizes: ["UK 4"], outOfStockSizes: ["UK 4"] }), "UK 4");
});

test("a replacement differs from the piece it replaces but keeps category and price", () => {
  const base = productFromItem({ category: "top", name: "Crew tee", colorName: "Cream" }, { lookKey: "1.1" });
  const next = replacementProduct(base, 1, "more colour");
  assert.equal(next.category, base.category);
  assert.notEqual(next.id, base.id);
  assert.notEqual(next.name, base.name);
  assert.equal(next.replacesProductId, base.id);
  assert.equal(next.request, "more colour");
  assert.equal(next.stock >= 1, true);
  assert.equal(next.placeholder, true);
});

test("picked edit pieces replace their category in the product list", () => {
  const replacement = replacementProduct(
    productFromItem({ category: "top", name: "Crew tee", colorName: "Cream" }, { lookKey: "1.1" }),
    2,
  );
  const edited = productsForLook(option, "1.1", { top: replacement });
  assert.equal(edited[0].name, replacement.name);
  assert.equal(edited[0].price, replacement.price, "the picked price is kept, not regenerated");
  assert.equal(edited[0].category, "top");
  assert.equal(edited[1].name, "Wide trousers", "other pieces are untouched");
});
