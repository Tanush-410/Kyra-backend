import { randomUUID } from 'node:crypto';

// A style session keeps the visitor's photo and measured profile in memory so "show me another"
// does not need a new capture. Sessions expire `ttlMs` after their last use.
export function createSessionStore({ ttlMs }) {
  const sessions = new Map();

  return {
    create(fields) {
      const now = Date.now();
      const session = { ...fields, sessionId: randomUUID(), createdAt: now, lastUsedAt: now, outfits: [], jobIds: [], files: [] };
      sessions.set(session.sessionId, session);
      return session;
    },

    get(sessionId) {
      const session = sessions.get(sessionId);
      if (!session) {
        return null;
      }
      session.lastUsedAt = Date.now();
      return session;
    },

    delete(sessionId) {
      const session = sessions.get(sessionId);
      sessions.delete(sessionId);
      return session || null;
    },

    sweep(now = Date.now()) {
      const expired = [];
      for (const [sessionId, session] of sessions) {
        if (now - session.lastUsedAt > ttlMs) {
          sessions.delete(sessionId);
          expired.push(session);
        }
      }
      return expired;
    },

    size() {
      return sessions.size;
    }
  };
}
