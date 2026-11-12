import React, { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef } from "react";
import { kyraApi, openEvents } from "../api/kyraClient.js";
import { activeOption, initialState, sessionReducer } from "../state/sessionReducer.js";

const KyraSessionContext = createContext(null);
const RECONNECT_MS = 3000;

/**
 * The visitor's session with the KYRA backend, shared by every screen.
 *
 * One event stream for the app. Before a session it carries camera guidance only; once a session
 * starts it is reopened for that session, so it also carries the visitor's images (the backend keeps
 * them off streams that aren't scoped to the session).
 *
 * value: { state, start, next, showAnother, like, keep, confirmProfile, correctUndertone, end, clear,
 *          addToCart, removeFromCart, setCartQty, setCartSize, saveOutfit, setFilters, clearFilters,
 *          editPiece, clearShop }
 *
 * The shop actions are frontend-only (no API calls): they live in the visit's state and are dropped
 * by sessionReducer when the visit starts, ends, or is cleared.
 */
export function KyraSessionProvider({ children }) {
  const [state, dispatch] = useReducer(sessionReducer, initialState);
  const sessionId = state.session?.id || null;
  const sessionRef = useRef(state.session);
  sessionRef.current = state.session;

  const backfill = useCallback(async (id) => {
    try {
      dispatch({ type: "session/snapshot", snapshot: await kyraApi.getSession(id) });
    } catch {
      // ended or unreachable: the stream says which
    }
  }, []);

  useEffect(() => {
    let disposed = false;
    let retry = 0;
    let close = () => {};
    const connect = () => {
      close = openEvents({
        sessionId,
        onOpen: () => dispatch({ type: "connection", status: "open" }),
        onEvent: (event) => {
          dispatch({ type: "event", event, now: Date.now() });
          // Anything missed while (re)connecting, or an image this stream didn't carry.
          const missingImage = event.type === "session.render.done" && event.sessionId === sessionId && !event.imageDataUrl;
          if (sessionId && (event.type === "hello" || missingImage)) backfill(sessionId);
        },
        onError: async ({ closed }) => {
          if (disposed) return;
          dispatch({ type: "connection", status: "reconnecting" });
          // A refused stream looks like a dropped one: ask the API which it is.
          if (!(await kyraApi.tokenAccepted())) {
            close();
            if (!disposed) dispatch({ type: "connection", status: "unauthorized" });
            return;
          }
          if (closed && !disposed) {
            close();
            retry = setTimeout(connect, RECONNECT_MS);
          }
        },
      });
    };
    connect();
    return () => {
      disposed = true;
      clearTimeout(retry);
      close();
    };
  }, [sessionId, backfill]);

  // Closing the page ends the visit, so the backend frees the camera and forgets the photo now.
  useEffect(() => {
    const onHide = () => {
      const session = sessionRef.current;
      if (session && !session.ended) kyraApi.endSession(session.id, { keepalive: true }).catch(() => {});
    };
    window.addEventListener("pagehide", onHide);
    return () => window.removeEventListener("pagehide", onHide);
  }, []);

  const act = useCallback(async (fn) => {
    const session = sessionRef.current;
    if (!session || session.ended) return null;
    dispatch({ type: "session/actionCleared" });
    try {
      return await fn(session);
    } catch (error) {
      dispatch({ type: "session/actionFailed", message: error.message });
      return null;
    }
  }, []);

  const actions = useMemo(
    () => ({
      /**
       * Starts a visit. intent: { style, gender }. imageDataUrl: only when this browser took the photo
       * (VITE_CAMERA_SOURCE=browser); otherwise the backend camera captures when the visitor holds still.
       * Only call after the visitor agreed (the consent screen). Throws KyraApiError.
       */
      start: async ({ style, gender }, { imageDataUrl } = {}) => {
        const previous = sessionRef.current;
        if (previous && !previous.ended) kyraApi.endSession(previous.id).catch(() => {});
        const created = await kyraApi.startSession({
          style,
          ...(gender ? { gender } : {}),
          ...(imageDataUrl ? { imageDataUrl } : {}),
          consent: true,
        });
        dispatch({ type: "session/started", sessionId: created.sessionId, status: created.status, gender: gender || null });
        return created;
      },
      next: () => act((s) => kyraApi.next(s.id)),
      /** Puts this option on the visitor (renders it unless it already is, or is being, rendered). */
      // The backend reuses a look already rendered or rendering (no new picture), so this always asks it.
      tryOn: (round, option) =>
        act(async (s) => {
          dispatch({ type: "session/activeSet", round, option });
          return kyraApi.render(s.id, round, option);
        }),
      /** New looks from the visitor's words: a new round of options, and its first look rendered. */
      redesign: (feedback) => act((s) => kyraApi.redesign(s.id, { feedback })),
      /** "More like this": a new round built around this option's style and colours. */
      moreLike: (option) =>
        act((s) =>
          kyraApi.redesign(s.id, {
            feedback: `More like "${option.title}" (${option.summary}): keep its style and colours, with different pieces.`.slice(0, 200),
          })
        ),
      /** "Not for me": counts as a thumbs-down (it teaches the mirror), then shows the next look. */
      showAnother: () =>
        act(async (s) => {
          const option = activeOption(s);
          if (s.active && option) await kyraApi.rate(s.id, { ...s.active, rating: "down" });
          return kyraApi.next(s.id);
        }),
      like: () => act((s) => s.active && kyraApi.rate(s.id, { ...s.active, rating: "up" })),
      keep: () =>
        act(async (s) => {
          if (!s.active) return null;
          const kept = await kyraApi.keep(s.id, s.active);
          dispatch({ type: "event", event: { type: "session.kept", sessionId: s.id, ...s.active, ...kept } });
          return kept;
        }),
      confirmProfile: () => act((s) => kyraApi.confirmProfile(s.id)),
      /** The visitor says their undertone is different: the backend redesigns for it. */
      correctUndertone: (skinUndertone) => act((s) => kyraApi.correctProfile(s.id, { skinUndertone })),
      end: async () => {
        const session = sessionRef.current;
        dispatch({ type: "session/cleared" });
        if (session && !session.ended) await kyraApi.endSession(session.id).catch(() => {});
      },
      clear: () => dispatch({ type: "session/cleared" }),
      addToCart: (product, { size, qty } = {}) => dispatch({ type: "shop/cartAdded", product, size, qty }),
      removeFromCart: (id) => dispatch({ type: "shop/cartRemoved", id }),
      setCartQty: (id, qty) => dispatch({ type: "shop/cartQty", id, qty }),
      setCartSize: (id, size) => dispatch({ type: "shop/cartSize", id, size }),
      saveOutfit: (outfit) => dispatch({ type: "shop/outfitSaved", ...outfit }),
      setFilters: ({ from, to }) => dispatch({ type: "shop/filtersSet", from, to }),
      clearFilters: () => dispatch({ type: "shop/filtersCleared" }),
      editPiece: ({ key, category, product }) => dispatch({ type: "shop/pieceEdited", key, category, product }),
      clearShop: () => dispatch({ type: "shop/cleared" }),
    }),
    [act]
  );

  const value = useMemo(() => ({ state, ...actions }), [state, actions]);
  return <KyraSessionContext.Provider value={value}>{children}</KyraSessionContext.Provider>;
}

export function useKyraSession() {
  const ctx = useContext(KyraSessionContext);
  if (!ctx) throw new Error("useKyraSession must be used inside <KyraSessionProvider>");
  return ctx;
}
