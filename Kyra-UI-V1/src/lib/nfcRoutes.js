// KYRA AI NFC Tags. "I'm done" at the end of a visit comes here first: "Would you like a Kyra Tag?"
// (screens/nfc/KyraTagScreen.jsx), then Bye. When the mirror has no tag writer, or it's offline, the screen
// goes straight on to Bye, so nothing changes for mirrors without one. Exit and the bin still go straight to
// Bye: those say the photo and looks will be forgotten.
export const KYRA_TAG_PATH = "/kyra-tag";
