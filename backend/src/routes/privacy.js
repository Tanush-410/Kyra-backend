import QRCode from 'qrcode';

// The consent screen's "Scan to know more about how your information is used".
//
// GET /privacy             public page (phones open it from the QR code): what the mirror does with a
//                          visitor's photo, in plain words. Facts only, taken from this backend's behaviour;
//                          a venue with its own privacy notice sets PRIVACY_URL instead.
// GET /api/v2/privacy      for the kiosk: { url, qrDataUrl }, or { url: null } when phones have no way to
//                          reach a page (no PRIVACY_URL and no PUBLIC_BASE_URL), so the screen shows no QR.

const webUrl = (value) => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : '';
  } catch {
    return '';
  }
};

const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function privacyTarget(config) {
  const own = webUrl(config.privacyUrl);
  if (own) return own;
  const base = webUrl(config.publicBaseUrl);
  return base ? new URL('/privacy', base).href : null;
}

export function privacyPage(config) {
  const hours = Number(config.keepHours) || 0;
  const seconds = Math.round((Number(config.absentAfterMs) || 30_000) / 1000);
  const away = seconds >= 120 && seconds % 60 === 0 ? `${seconds / 60} minutes` : `${seconds} seconds`;
  const keep =
    hours > 0
      ? `If you choose <b>Take it home</b>, that one picture of your look is saved behind a private link (the QR code you scan) and deleted after ${escapeHtml(hours)} hour${hours === 1 ? '' : 's'}.`
      : 'Looks cannot be taken home on this mirror, so nothing about you is saved.';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>How the KYRA mirror uses your photo</title>
<style>body{margin:0 auto;max-width:640px;padding:24px 20px 48px;background:#2a2a2a;color:#f2f2f2;font:17px/1.55 system-ui,sans-serif}
h1{font-size:26px;line-height:1.25;margin:0 0 20px}h2{font-size:18px;margin:28px 0 6px}p,li{margin:0 0 10px}ul{padding-left:20px}</style></head>
<body><h1>How the KYRA mirror uses your photo</h1>
<h2>Before you agree</h2>
<p>The camera is on while the mirror runs, so it can guide you and notice when you arrive. Until you agree on its screen, nothing it sees is saved or sent anywhere, and it is dropped when you leave.</p>
<h2>What the photo is for</h2>
<p>The mirror reads your skin tone and build from the camera, then sends your photo to OpenAI, our AI partner, to create your looks: pictures of you wearing the outfits it suggests.</p>
<p>If you use voice search, your words are turned into text by your browser's speech service (Google, in Chrome); the mirror sends the text to OpenAI to design your looks, and keeps it only for this visit.</p>
<h2>How long it is kept</h2>
<ul><li>During your visit your photo and results are held in the mirror's memory only.</li>
<li>When you finish, or about ${escapeHtml(away)} after you step away from the mirror, they are forgotten.</li>
<li>${keep}</li></ul>
<h2>What the mirror learns</h2>
<p>When you like or dislike a look, or correct your skin tone, the mirror notes the colours and the undertone, to suggest better colours to future visitors. These notes contain no photo, name or anything that identifies you.</p>
<h2>Questions</h2>
<p>Please ask a member of staff.</p>
</body></html>`;
}

export default async function privacyRoutes(app, { config }) {
  const target = privacyTarget(config);
  let qr = null;

  app.get('/privacy', async (request, reply) => reply.type('text/html; charset=utf-8').header('cache-control', 'public, max-age=300').send(privacyPage(config)));

  app.get('/api/v2/privacy', async () => {
    if (!target) return { url: null };
    qr ||= await QRCode.toDataURL(target, { margin: 1, width: 320 });
    return { url: target, qrDataUrl: qr };
  });
}
