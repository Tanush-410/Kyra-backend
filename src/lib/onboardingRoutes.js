// The onboarding paths (Figma "Onboarding", 2043:8290, and its note: "I'M JUST BROWSING -> what are you
// looking for -> if OUTFIT -> analysis else PICK A PIECE (male / female)").
//   Welcome -> How can I help you today?
//     I'm just browsing -> What are you looking for? -> Outfit -> Build your profile -> analysis
//                                                    -> Pick a piece -> menswear / womenswear picks -> ...
//     I know what I'm looking for -> What would you like to try? (voice, or a piece) -> ...
//   Every path reaches the analysis intro through "Build your profile". Choices travel in the query
//   (?category=) and router state; spoken words only in router state, never in the address.
export const HOW_CAN_I_HELP = "/welcome/how-can-i-help";
export const WHAT_ARE_YOU_LOOKING_FOR = "/welcome/how-can-i-help/browse";
export const SPECIFIC_SCREEN = "/welcome/looking-for-today/specificscreen";
export const SHOPFOR = "/welcome/looking-for-today/surpriseme/shopfor";
export const BUILD_PROFILE = "/welcome/looking-for-today/surpriseme/buildprofile";
export const ANALYSIS = "/welcome/looking-for-today/surpriseme/analysis";
