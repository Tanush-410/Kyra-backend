// KYRA NFC TAGS (1 of 3, with nfc-jobs.js and routes/nfc.js): short session URLs.
//
// A finished visit gets one short link, https://<NFC_PUBLIC_BASE_URL>/s/<token>, that opens its personalised
// Canvas: the visit's "Your results" page (looks.keepResults). The token is cryptographically random
// (rejection-sampled, no modulo bias), alphanumeric without look-alike characters, NFC_TOKEN_LENGTH long
// (10 by default: 56^10 ≈ 3·10^17, unguessable). The mapping is stored like the rest of the mirror's data,
// one small JSON file per link (there is no database), and expires with the page it points to.
// An unguessable link is a bearer link: whoever has the tag or the URL can open that Canvas.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// No 0/O, 1/l/I: a link read aloud or typed from a printed card can't be mistaken.
export const LINK_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
const MIN_LENGTH = 8;
const MAX_LENGTH = 32;

export function newLinkToken(length = 10) {
  const n = Math.min(MAX_LENGTH, Math.max(MIN_LENGTH, Math.round(length)));
  const limit = 256 - (256 % LINK_ALPHABET.length); // bytes at or above this would bias the alphabet
  let token = '';
  while (token.length < n) {
    for (const byte of randomBytes(n * 2)) {
      if (byte < limit && token.length < n) token += LINK_ALPHABET[byte % LINK_ALPHABET.length];
    }
  }
  return token;
}

export function isLinkToken(token) {
  return typeof token === 'string' && token.length >= MIN_LENGTH && token.length <= MAX_LENGTH && [...token].every((c) => LINK_ALPHABET.includes(c));
}

export function createLinkStore({ dir, tokenLength = 10 }) {
  const fileFor = (token) => path.join(dir, `${token}.json`);
  const bySession = new Map(); // sessionId -> token (this process); files are the source of truth

  const read = (token) => {
    if (!isLinkToken(token) || !existsSync(fileFor(token))) return null;
    try {
      return JSON.parse(readFileSync(fileFor(token), 'utf8'));
    } catch {
      return null;
    }
  };
  const write = (link) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(fileFor(link.token), JSON.stringify(link));
  };

  return {
    /** The visit's link, made once: { token, sessionId, resultsToken, createdAt, expiresAt, revokedAt }. */
    forSession({ sessionId, resultsToken, expiresAt }) {
      const known = read(bySession.get(sessionId));
      if (known && !known.revokedAt && known.resultsToken === resultsToken) {
        if (Date.parse(expiresAt) > Date.parse(known.expiresAt)) write({ ...known, expiresAt });
        return read(known.token);
      }
      let token;
      do token = newLinkToken(tokenLength);
      while (existsSync(fileFor(token)));
      const link = { token, sessionId, resultsToken, createdAt: new Date().toISOString(), expiresAt, revokedAt: null };
      write(link);
      bySession.set(sessionId, token);
      return link;
    },

    /** { status: 'ok' | 'expired' | 'revoked' | 'unknown', link } for a token from a URL or a tag. */
    resolve(token) {
      const link = read(token);
      if (!link) return { status: 'unknown', link: null };
      if (link.revokedAt) return { status: 'revoked', link };
      if (Date.parse(link.expiresAt) < Date.now()) return { status: 'expired', link };
      return { status: 'ok', link };
    },

    extend(token, expiresAt) {
      const link = read(token);
      if (link && Date.parse(expiresAt) > Date.parse(link.expiresAt)) write({ ...link, expiresAt });
    },

    revoke(token) {
      const link = read(token);
      if (!link) return false;
      write({ ...link, revokedAt: new Date().toISOString() });
      return true;
    },

    /** Deletes links a week past their expiry (until then a scan says "expired" rather than "unknown"). */
    sweep() {
      if (!existsSync(dir)) return 0;
      let deleted = 0;
      for (const name of readdirSync(dir).filter((file) => file.endsWith('.json'))) {
        const link = read(name.slice(0, -5));
        if (!link || Date.parse(link.expiresAt) + 7 * 86_400_000 < Date.now()) {
          rmSync(path.join(dir, name), { force: true });
          deleted += 1;
        }
      }
      return deleted;
    }
  };
}
