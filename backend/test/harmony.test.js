import assert from 'node:assert/strict';
import test from 'node:test';
import { deltaE00Lab } from '../src/lib/colors.js';
import { enforceDesign } from '../src/lib/outfit-design.js';
import { describeColour, harmonise, harmony } from '../src/lib/harmony.js';

const C = {
  Navy: '#1B2A4A', Denim: '#4A6A8E', Camel: '#C19A6B', White: '#F7F7F7', Black: '#141414', Chocolate: '#5A3A24',
  Rust: '#A8471E', Teal: '#1E7A73', Emerald: '#1B7F5B', Mustard: '#C9A227', Fuchsia: '#C2186B', Rose: '#C27A86',
  'Dusty blue': '#6A88A8', Coral: '#F0806A', 'Golden yellow': '#E8B83A', Lavender: '#B8A6D9'
};
const outfit = (...pieces) => pieces.map(([category, colorName]) => ({ category, colorName, hex: C[colorName], name: `${colorName} ${category}` }));
const palette = Object.entries(C).map(([name, hex]) => ({ name, hex }));

test('CIEDE2000 matches the Sharma et al. reference pairs', () => {
  const pairs = [
    [[50, 2.6772, -79.7751], [50, 0, -82.7485], 2.0425],
    [[50, 2.5, 0], [73, 25, -18], 27.1492],
    [[60.2574, -34.0099, 36.2677], [60.4626, -34.1751, 39.4387], 1.2644],
    [[90.8027, -2.0831, 1.441], [91.1528, -1.6435, 0.0447], 1.4441]
  ];
  for (const [[L1, a1, b1], [L2, a2, b2], expected] of pairs) {
    assert.ok(Math.abs(deltaE00Lab({ L: L1, a: a1, b: b1 }, { L: L2, a: a2, b: b2 }) - expected) < 1e-3);
  }
});

test('fashion neutrals are not counted as colours', () => {
  for (const name of ['Navy', 'Denim', 'Camel', 'White', 'Black', 'Chocolate']) {
    assert.equal(describeColour(C[name]).neutral, true, name);
  }
  for (const name of ['Rust', 'Teal', 'Fuchsia', 'Mustard']) {
    assert.equal(describeColour(C[name]).neutral, false, name);
  }
});

test('classic pairings pass: neutrals, complementary accent, analogous, rose with dusty blue', () => {
  const good = [
    outfit(['outerwear', 'Navy'], ['top', 'White'], ['bottom', 'Camel'], ['shoes', 'Chocolate']),
    outfit(['top', 'Teal'], ['bottom', 'Navy'], ['shoes', 'Black'], ['accessory', 'Rust']),
    outfit(['top', 'Coral'], ['bottom', 'Golden yellow'], ['shoes', 'White']),
    outfit(['top', 'Rose'], ['bottom', 'Dusty blue'], ['shoes', 'White'])
  ];
  for (const items of good) {
    const result = harmony(items);
    assert.ok(result.score >= 0.75, `${items.map((i) => i.colorName).join(' + ')}: ${result.issues.join('; ')}`);
  }
});

test('busy or loose outfits are flagged: three loud accents, shoes that do not tie in', () => {
  const busy = harmony(outfit(['top', 'Emerald'], ['bottom', 'Mustard'], ['shoes', 'Fuchsia']));
  assert.ok(busy.score < 0.75 && busy.issues.some((i) => i.includes('shoes')));
  const three = harmony(outfit(['top', 'Coral'], ['bottom', 'Golden yellow'], ['shoes', 'Lavender']));
  assert.ok(three.score < 0.75);
});

test('a clashing outfit is fixed by recolouring the smallest piece first, inside the palette', () => {
  const fixed = harmonise({ items: outfit(['top', 'Emerald'], ['bottom', 'Mustard'], ['shoes', 'Fuchsia']) }, palette);
  assert.ok(fixed.harmony.score >= 0.75);
  const changed = fixed.items.filter((item) => item.harmonised);
  assert.deepEqual(changed.map((item) => item.category), ['shoes'], 'top and bottom kept as designed');
  assert.ok(palette.some((colour) => colour.hex === changed[0].hex));
});

test('the designer output is harmonised and item names stop contradicting their colour', () => {
  const [option] = enforceDesign([{
    title: 'Cobalt Tux', summary: '', reasoning: '',
    items: [
      { category: 'outerwear', name: 'Cobalt tux jacket', colorName: 'Cobalt', hex: '#1E4FC2', fit: 'slim', material: 'wool' },
      { category: 'top', name: 'Bright white dress shirt', colorName: 'White', hex: '#FFFFFF', fit: 'slim', material: 'cotton' },
      { category: 'bottom', name: 'Mustard chinos', colorName: 'Mustard', hex: '#C9A227', fit: 'slim', material: 'cotton' },
      { category: 'shoes', name: 'Fuchsia loafers', colorName: 'Fuchsia', hex: '#C2186B', fit: 'regular', material: 'suede' },
      { category: 'accessory', name: 'Ruby silk tie', colorName: 'Ruby', hex: '#9B111E', fit: 'regular', material: 'silk' }
    ]
  }], [
    { name: 'Denim', hex: '#4A6A8E' }, { name: 'White', hex: '#F7F7F7' }, { name: 'Mustard', hex: '#C9A227' },
    { name: 'Fuchsia', hex: '#C2186B' }, { name: 'Rose', hex: '#C27A86' }, { name: 'Black', hex: '#141414' }, { name: 'Chocolate', hex: '#5A3A24' }
  ]);
  assert.ok(option.harmony.score >= 0.75, option.harmony.issues.join('; '));
  const jacket = option.items.find((item) => item.category === 'outerwear');
  assert.equal(jacket.colorName, 'Denim');
  assert.equal(jacket.name, 'Tux jacket', '"Cobalt" no longer contradicts Denim');
  for (const item of option.items) {
    const colourWord = item.name.split(' ')[0].toLowerCase();
    assert.ok(!['cobalt', 'ruby', 'fuchsia', 'mustard'].includes(colourWord) || item.colorName.toLowerCase() === colourWord, `${item.name} / ${item.colorName}`);
  }
});
