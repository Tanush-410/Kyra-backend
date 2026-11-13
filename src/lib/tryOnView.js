import { activeOption, activeRender } from "../state/sessionReducer.js";

/**
 * What the virtual try-on screen (Figma "Virtual try on" 2043:13475) shows for the look on screen:
 *   ready:   the picture of the visitor wearing it
 *   loading: the Kyra star while it is designed, queued or rendered (caption says which)
 *   failed:  the picture couldn't be made: the outfit as cards, "Please try again" (Figma "Error")
 *   text:    pictures are unavailable for now (text-only mode): the outfit as cards and the reason
 * A finished picture is shown even in text-only mode (it was made before). Pure: tested in lib.test.js.
 */
export function tryOnState(session) {
  const option = activeOption(session);
  const render = activeRender(session);
  if (!option) return { kind: "loading", caption: "Kyra is designing your looks…", option: null, render };
  if (render?.status === "done" && render.imageDataUrl) return { kind: "ready", option, render };
  if (session?.degraded) {
    return { kind: "text", option, render, message: session.degraded.message || "Pictures are unavailable right now, so here is your look in words." };
  }
  if (render?.status === "failed") return { kind: "failed", option, render, message: render.error || "I couldn’t create this picture." };
  const caption = render?.status === "queued" ? "Your look is next in line…" : "Creating your look…";
  return { kind: "loading", caption, option, render };
}

/** The round's next outfit after the one on screen (wrapping), or null when there is no other. */
export function nextOptionOf(session) {
  const round = session?.active?.round ?? session?.currentRound;
  const options = session?.rounds?.[round] || [];
  if (options.length < 2) return null;
  const current = activeOption(session)?.option ?? options[0].option;
  const at = options.findIndex((o) => o.option === current);
  return { round, option: options[(at + 1) % options.length].option };
}
