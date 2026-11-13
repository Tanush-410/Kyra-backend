import assert from "node:assert/strict";
import { test } from "node:test";
import { pinchBackTarget } from "./pinchBack.js";

const SKIN = "/welcome/looking-for-today/surpriseme/analysis/holdstill/analysisres";
const FIT = `${SKIN}/fit`;
const CONSENT = "/welcome/looking-for-today/surpriseme/analysis/consent";
const back = (stack, opts = {}) => pinchBackTarget({ stack, sessionActive: false, modalOpen: false, ...opts });

test("a pinch on empty screen goes back one screen in onboarding, home screens included", () => {
  assert.equal(back(["/", "/welcome"]), "/");
  assert.equal(back(["/", "/welcome", "/welcome/how-can-i-help"]), "/welcome");
});

test("nothing before the start screen, and no going back from Bye or the Kyra Tag screen", () => {
  assert.equal(back(["/"]), null);
  assert.equal(back(["/welcome", "/"]), null);
  assert.equal(back([FIT, "/bye"]), null);
  assert.equal(back([FIT, "/kyra-tag"], { sessionActive: true }), null);
  assert.equal(back(["/kyra-tag", "/account"]), null, "nor back into them");
});

test("after the photo, back stays among the results and the shop, never into consent or hold still", () => {
  assert.equal(back([CONSENT, SKIN, FIT], { sessionActive: true }), SKIN);
  assert.equal(back([SKIN, "/shop/cart"], { sessionActive: true }), SKIN);
  assert.equal(back([CONSENT, SKIN], { sessionActive: true }), null, "the photo is already taken");
  assert.equal(back(["/welcome/how-can-i-help", CONSENT], { sessionActive: true }), null, "the visit has started");
});

test("an open dialog: a pinch outside it doesn't navigate the screen underneath", () => {
  assert.equal(back([SKIN, FIT], { sessionActive: true, modalOpen: true }), null);
});
