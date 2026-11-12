// After the photo (Figma "Anaysis", then the looks):
//   Skin Tone Analysis -> Know my fit -> Fit Analysis -> Suggestions (the round's outfits) -> the look
//   (virtual try-on). The first look renders in the background meanwhile, and both analysis screens
//   have a way to skip straight to it.
export const SKIN_TONE_PATH = "/welcome/looking-for-today/surpriseme/analysis/holdstill/analysisres";
export const FIT_PATH = `${SKIN_TONE_PATH}/fit`;
export const SUGGESTIONS_PATH = `${SKIN_TONE_PATH}/suggestions`;
export const LOOK_PATH = `${SKIN_TONE_PATH}/look`;
// Where the shop (and "Exit" in it) returns to: the look.
export const RESULTS_PATH = LOOK_PATH;
export const SHOP_PATH = "/shop";
export const CART_PATH = "/shop/cart";
export const CHECKOUT_PATH = "/shop/checkout";
export const FILTER_PATH = "/shop/filter";
export const ACCOUNT_PATH = "/account";
export const EDIT_PATH = "/edit";
