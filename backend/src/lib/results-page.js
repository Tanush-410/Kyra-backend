// "Your results" page (GET /results/:token): what the visit found, for the visitor's phone. Data only,
// escaped; the only pictures are looks the visitor chose to take home (served from /looks/:token.png).
const escapeHtml = (text) => String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const HEX = /^#[0-9a-f]{6}$/i;
const capitalise = (text) => (text ? text[0].toUpperCase() + text.slice(1) : '');

const UNDERTONE_LINES = {
  warm: 'Golden, earthy shades bring out your glow.',
  cool: 'Jewel tones and crisp, cool shades flatter you most.',
  neutral: 'Both warm and cool shades suit you.'
};

export function resultsPage(results) {
  const undertone = results.undertone
    ? `<p class="big">${escapeHtml(results.olive ? 'Olive' : capitalise(results.undertone))} undertone${results.depth ? `, ${escapeHtml(results.depth)} depth` : ''}</p><p>${escapeHtml(UNDERTONE_LINES[results.undertone] || '')}</p>`
    : '<p>The mirror couldn’t read your undertone clearly, so these colours suit everyone.</p>';
  const palette = (results.palette || [])
    .filter((c) => HEX.test(c.hex))
    .map((c) => `<li><i style="background:${c.hex}"></i>${escapeHtml(c.name)}</li>`)
    .join('');
  const fit = (results.fitLines || []).map((line) => `<li>${escapeHtml(line)}</li>`).join('');
  const looks = (results.looks || [])
    .filter((l) => /^[0-9a-f]{32}$/.test(l.token))
    .map((l) => `<figure><img src="/looks/${l.token}.png" alt="${escapeHtml(l.title || 'Your look')}"><figcaption>${escapeHtml(l.title)}</figcaption></figure>`)
    .join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Your KYRA results</title>
<style>body{margin:0 auto;max-width:640px;padding:24px 20px 48px;background:#2a2a2a;color:#f2f2f2;font:17px/1.55 system-ui,sans-serif}
h1{font-size:26px;margin:0 0 16px}h2{font-size:18px;margin:28px 0 8px}.big{font-size:20px;font-weight:600;margin:0}
ul{padding:0;list-style:none}.palette{display:flex;flex-wrap:wrap;gap:12px 18px}.palette li{display:flex;align-items:center;gap:8px}
.palette i{width:28px;height:28px;border-radius:50%;border:2px solid rgba(255,255,255,.5)}.fit li{margin:0 0 8px}
img{display:block;width:100%;border-radius:12px}figure{margin:0 0 16px}figcaption{color:#bbb;padding-top:6px}small{color:#aaa}</style></head>
<body><h1>Your KYRA results</h1>
<h2>Your colours</h2>${undertone}${palette ? `<ul class="palette">${palette}</ul>` : ''}
${fit ? `<h2>Your fit</h2><ul class="fit">${fit}</ul>` : ''}
${looks ? `<h2>Looks you took home</h2>${looks}` : ''}
<p><small>This page is deleted on ${escapeHtml(new Date(results.expiresAt).toUTCString())}. It holds no photo of you except a look you chose to take home.</small></p>
</body></html>`;
}
