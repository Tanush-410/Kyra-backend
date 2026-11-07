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
      const output = text.includes('Design') ? DESIGN : { usable: true, personCount: 1, singleProminentPerson: true, fullBodyVisible: true, faceVisible: true, samePerson: true, score: 0.9 };
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

    send(res, 404, { error: { message: `mock does not handle ${req.url}` } });
  })
  .listen(port, '127.0.0.1', () => console.log(`Mock OpenAI on http://127.0.0.1:${port}/v1 (image delay ${imageDelayMs} ms)`));
