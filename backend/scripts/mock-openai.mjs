// A stand-in for the OpenAI API so the whole mirror can be rehearsed without spending credit.
// Start it, then run the backend with OPENAI_BASE_URL=http://127.0.0.1:4010/v1.
// Text calls return three fixed outfits; image edits return the visitor tinted toward the first
// outfit colour after a realistic delay. Usage: node scripts/mock-openai.mjs [port=4010] [imageDelayMs=4000]
import http from 'node:http';
import sharp from 'sharp';

const port = Number(process.argv[2]) || 4010;
const imageDelayMs = Number(process.argv[3]) || 4000;

const DESIGN = {
  options: [
    ['Teal tailored', '#2A7F7A', 'Teal single-breasted blazer'],
    ['Navy classic', '#22304F', 'Navy wool overshirt'],
    ['Plum evening', '#7A4A6E', 'Plum knit polo']
  ].map(([title, hex, name]) => ({
    title,
    summary: `${name} with off-white trousers (mock design).`,
    reasoning: 'Mock response: colours come from the visitor palette.',
    items: [
      { category: 'top', name, colorName: title.split(' ')[0], hex, fit: 'regular', material: 'wool' },
      { category: 'bottom', name: 'Straight trousers', colorName: 'Off-white', hex: '#F2EFE8', fit: 'straight', material: 'cotton' },
      { category: 'shoes', name: 'Leather loafers', colorName: 'Navy', hex: '#22304F', fit: '', material: 'leather' }
    ]
  }))
};

// Rate and changes: a fixed rating with three changes (shoes, hair, jewellery).
const RATING = {
  score: 7,
  summary: 'Clean lines and a calm palette (mock rating).',
  changes: [
    { category: 'shoes', name: 'White Kitten Heels', hex: '#F2EFE8', why: 'Modern edge in off-white | Elevates the look with structure', tags: [{ label: 'Material', value: 'Natural PU' }, { label: 'Type', value: 'Slingback' }, { label: 'Fastening', value: 'Buckle' }], points: 1 },
    { category: 'hair', name: 'Soft Wave Lob', hex: '#3B2A20', why: 'Adds soft movement | Frames the neckline', tags: [{ label: 'Length', value: 'Collarbone' }, { label: 'Texture', value: 'Loose waves' }], points: 1 },
    { category: 'accessory', name: 'Lapis Link Necklace', hex: '#C9A227', why: 'Rich lapis tones in gold | Timeless sophistication', tags: [{ label: 'Material', value: 'Gold-tone brass' }, { label: 'Stone', value: 'Lapis lazuli' }, { label: 'Closure', value: 'Box clasp' }], points: 0.6 }
  ]
};

const send = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

http
  .createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks);

    if (req.url.endsWith('/responses')) {
      const text = JSON.parse(raw.toString()).input?.[0]?.content?.[0]?.text || '';
      const output = text.includes('Rate only the outfit') ? RATING : text.includes('Design') ? DESIGN : { usable: true, personCount: 1, singleProminentPerson: true, fullBodyVisible: true, faceVisible: true, samePerson: true, score: 0.9 };
      await new Promise((resolve) => setTimeout(resolve, 1500));
      return send(res, 200, { output_text: JSON.stringify(output) });
    }

    if (req.url.endsWith('/images/edits')) {
      const form = await new Request('http://mock', { method: 'POST', headers: req.headers, body: raw }).formData();
      const image = Buffer.from(await form.get('image[]').arrayBuffer());
      const hex = /#[0-9A-Fa-f]{6}/.exec(form.get('prompt') || '')?.[0] || '#2A7F7A';
      const delay = form.get('quality') === 'low' ? imageDelayMs / 3 : imageDelayMs;
      await new Promise((resolve) => setTimeout(resolve, delay));
      const tinted = await sharp(image).tint(hex).png().toBuffer();
      return send(res, 200, { data: [{ b64_json: tinted.toString('base64') }] });
    }

    // Product photos: a plain garment shape in the piece's colour on a transparent background.
    if (req.url.endsWith('/images/generations')) {
      const prompt = JSON.parse(raw.toString()).prompt || '';
      const hex = /#[0-9A-Fa-f]{6}/.exec(prompt)?.[0] || '#8A8A8A';
      const shape = /pair of shoes/.test(prompt)
        ? '<path d="M180 620 h300 l40 -90 h260 v160 H180 z"/>'
        : /bottoms/.test(prompt)
          ? '<path d="M330 180 h360 l60 700 h-170 l-70 -480 l-70 480 h-170 z"/>'
          : '<path d="M330 200 l120 -40 q62 60 124 0 l120 40 l140 160 l-100 80 l-60 -60 v480 H350 V380 l-60 60 l-100 -80 z"/>';
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><g fill="${hex}" stroke="#00000033" stroke-width="6">${shape}</g></svg>`;
      await new Promise((resolve) => setTimeout(resolve, imageDelayMs / 4));
      const png = await sharp(Buffer.from(svg)).png().toBuffer();
      return send(res, 200, { data: [{ b64_json: png.toString('base64') }] });
    }

    send(res, 404, { error: { message: `mock does not handle ${req.url}` } });
  })
  .listen(port, '127.0.0.1', () => console.log(`Mock OpenAI on http://127.0.0.1:${port}/v1 (image delay ${imageDelayMs} ms)`));
