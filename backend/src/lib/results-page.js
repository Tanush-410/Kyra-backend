// "Your results" page (GET /results/:token): what the visit found, for the visitor's phone, styled as the
// Figma "Your colouring" card (a cream card: undertone, depth and clarity chips, five colours with their
// roles, then the fit notes and any looks taken home). Data only, escaped; the only pictures are looks the
// visitor chose to take home (served from /looks/:token.png). No web fonts: the page's policy allows none.
import { clarityOf, paletteRoles } from './colour-roles.js';

const escapeHtml = (text) => String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const HEX = /^#[0-9a-f]{6}$/i;
const capitalise = (text) => (text ? text[0].toUpperCase() + text.slice(1) : '');

const UNDERTONE_LINES = {
  warm: 'Golden, earthy shades bring out your glow.',
  cool: 'Jewel tones and crisp, cool shades flatter you most.',
  neutral: 'Both warm and cool shades suit you.'
};
const ROLE_LINES = {
  Core: 'A grounding shade to build your outfits around.',
  Supporting: 'Adds depth and harmony to your look.',
  Accent: 'Adds warmth and a touch of energy.'
};

export function resultsPage(results) {
  const colours = paletteRoles((results.palette || []).filter((c) => HEX.test(c.hex)));
  const clarity = clarityOf(colours);
  const accent = colours.find((c) => c.role === 'Accent');
  const chips = [
    results.undertone && { label: results.olive ? 'Olive' : capitalise(results.undertone), dot: '#c9b49e' },
    results.depth && { label: `${capitalise(results.depth)} depth`, dot: '#a89490' },
    clarity && { label: clarity, dot: accent?.hex || '#b7c1c6' }
  ].filter(Boolean);
  const chipHtml = chips.map((c) => `<li><i style="background:${HEX.test(c.dot) ? c.dot : '#ccc'}"></i>${escapeHtml(c.label)}</li>`).join('<li class="sep" aria-hidden="true"></li>');
  const swatches = colours
    .map(
      (c) => `<li><i style="background:${c.hex}"></i><b>${escapeHtml(c.name)}</b><span class="role role--${c.role.toLowerCase()}">${c.role}</span><small>${ROLE_LINES[c.role]}</small></li>`
    )
    .join('');
  const intro = results.undertone
    ? escapeHtml(UNDERTONE_LINES[results.undertone] || 'The colours that naturally complement you.')
    : 'The mirror couldn’t read your undertone clearly, so these colours suit everyone.';
  const fit = (results.fitLines || []).map((line) => `<li>${escapeHtml(line)}</li>`).join('');
  const looks = (results.looks || [])
    .filter((l) => /^[0-9a-f]{32}$/.test(l.token))
    .map((l) => `<figure><img src="/looks/${l.token}.png" alt="${escapeHtml(l.title || 'Your look')}"><figcaption>${escapeHtml(l.title)}</figcaption></figure>`)
    .join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Your colouring · KYRA</title>
<style>
*{box-sizing:border-box}
body{margin:0;min-height:100vh;padding:20px 14px 40px;background:#3a3a3a;font:15px/1.5 -apple-system,system-ui,sans-serif;color:#3b3532}
.card{max-width:620px;margin:0 auto 18px;padding:26px 22px 28px;border-radius:6px;background:linear-gradient(160deg,#f6f1ea,#efe7de);box-shadow:0 10px 30px rgba(0,0,0,.25)}
.eyebrow{margin:0;font-size:10px;letter-spacing:.32em;text-transform:uppercase;color:#9a8f86}
h1,h2{font-family:Georgia,'Times New Roman',serif;font-weight:400;color:#2f2925;margin:6px 0 4px}
h1{font-size:30px}h2{font-size:23px}
.lede{margin:0 0 16px;color:#857a71;font-size:14px}
.chips{display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin:0;padding:0 0 18px;list-style:none;border-bottom:1px solid #e0d6cb}
.chips li{display:flex;align-items:center;gap:8px;padding:6px 14px;border-radius:999px;background:#eae2d8;font-size:13px}
.chips li.sep{padding:0;width:1px;height:18px;background:#d6cbbf;border-radius:0}
.chips i,.palette i{display:block;border-radius:50%}
.chips i{width:12px;height:12px}
.section{padding-top:18px}
.palette{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:6px;margin:14px 0 0;padding:0;list-style:none;text-align:center}
.palette li{display:flex;flex-direction:column;align-items:center;gap:5px}
.palette i{width:min(54px,13vw);height:min(54px,13vw);box-shadow:inset 0 0 0 1px rgba(0,0,0,.06)}
.palette b{font-weight:500;font-size:12px;line-height:1.25}
.role{max-width:100%;padding:1px 6px;border-radius:999px;font-size:8px;letter-spacing:.06em;text-transform:uppercase;background:#e7dfd5;color:#7d7066}
.role--supporting{background:#dfe4e2;color:#5f6d69}.role--accent{background:#f2dcd6;color:#a2513f}
.palette small{font-size:10px;line-height:1.35;color:#8f847b;overflow-wrap:anywhere}
.note{display:flex;gap:12px;align-items:flex-start;margin:20px 0 18px;padding-top:16px;border-top:1px solid #e0d6cb;font-size:12.5px;color:#7d7268}
.note span{font-size:18px;color:#a39286}
.button{display:flex;justify-content:space-between;align-items:center;padding:13px 22px;border-radius:999px;background:#3b3734;color:#f4eee7;text-decoration:none;font-size:13px}
.fit{margin:10px 0 0;padding-left:18px}.fit li{margin:0 0 6px}
figure{margin:12px 0 0}img{display:block;width:100%;border-radius:6px;background:#222}figcaption{padding-top:6px;color:#857a71;font-size:13px}
.foot{max-width:620px;margin:0 auto;color:#bdb5ad;font-size:12px;text-align:center}
@media (max-width:340px){.palette{grid-template-columns:repeat(3,minmax(0,1fr));row-gap:16px}}
</style></head>
<body>
<main class="card">
<p class="eyebrow">Skin analysis</p>
<h1>Your colouring</h1>
<p class="lede">${intro}</p>
${chipHtml ? `<ul class="chips">${chipHtml}</ul>` : ''}
${swatches ? `<div class="section"><p class="eyebrow">Your recommended palette</p><h2>Colours that complement you</h2><ul class="palette">${swatches}</ul>
<p class="note"><span aria-hidden="true">✦</span>These shades complement your natural colouring and can help create a more balanced look.</p>` : ''}
${looks ? '<a class="button" href="#looks">Explore pieces in these colours <span aria-hidden="true">→</span></a>' : ''}
</main>
${fit ? `<section class="card"><p class="eyebrow">Fit analysis</p><h2>Your fit</h2><ul class="fit">${fit}</ul></section>` : ''}
${looks ? `<section class="card" id="looks"><p class="eyebrow">Your looks</p><h2>Looks you took home</h2>${looks}</section>` : ''}
<p class="foot">This page is deleted on ${escapeHtml(new Date(results.expiresAt).toUTCString())}. It holds no photo of you except a look you chose to take home.</p>
</body></html>`;
}
