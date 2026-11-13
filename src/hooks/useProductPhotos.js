import { useEffect, useState } from "react";
import { kyraApi, productPhotoUrl } from "../api/kyraClient.js";
import { useKyraSession } from "../context/KyraSessionContext.jsx";

/**
 * Product photos for one outfit's pieces (backend: POST .../product-photos). Asks once per outfit; the
 * backend makes the missing ones and announces each with a 'product.photo' event (state.photos).
 *
 * Returns photoFor(index) -> url or null (null: not made yet, failed, or photos are off: show the tile).
 */
export function useProductPhotos(option) {
  const { state } = useKyraSession();
  const sessionId = state.session?.id;
  const [keys, setKeys] = useState({}); // "round.option" -> [{ key, ready }]
  const id = option ? `${option.round}.${option.option}` : null;

  useEffect(() => {
    if (!sessionId || !option || keys[id]) return undefined;
    let live = true;
    kyraApi
      .productPhotos(sessionId, option.round, option.option)
      .then((answer) => live && setKeys((known) => ({ ...known, [id]: answer.photos || [] })))
      .catch(() => live && setKeys((known) => ({ ...known, [id]: [] })));
    return () => {
      live = false;
    };
  }, [sessionId, id]); // eslint-disable-line react-hooks/exhaustive-deps

  return (index) => {
    const photo = id ? keys[id]?.[index] : null;
    if (!photo) return null;
    return photo.ready || state.photos[photo.key] === "ready" ? productPhotoUrl(photo.key) : null;
  };
}
