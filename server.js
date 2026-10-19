const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '2mb' }));

// --- Anahtarlar: Railway'de GROQ1, GROQ2 ... GROQ6 ---
const KEYS = Object.keys(process.env)
  .filter(k => /^GROQ(_API_KEY|\d+)$/.test(k)).sort()
  .map(k => ({ name: k, v: process.env[k], u: {} })).filter(k => k.v);
let rr = 0;
const pickKey = m => {
  const now = Date.now();
  for (let i = 0; i < KEYS.length; i++) {
    const k = KEYS[(rr + i) % KEYS.length];
    if (!(k.u[m] > now)) { rr = (rr + i + 1) % KEYS.length; return k; }
  }
  return null;
};

// --- Modeller (Railway'de MODEL_FAST / MODEL_MAIN / MODEL_DEEP ile değiştirilebilir) ---
const MD = {
  fast: process.env.MODEL_FAST || 'llama-3.1-8b-instant',
  main: process.env.MODEL_MAIN || 'llama-3.3-70b-versatile',
  deep: process.env.MODEL_DEEP || 'openai/gpt-oss-120b',
};

// --- Skill dosyaları: skills/*.md ---
const SK = { names: [], text: '' };
try {
  const dir = path.join(__dirname, 'skills');
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.md'))) {
    SK.names.push(f.replace(/\.md$/, ''));
    SK.text += `\n### ${f}\n` + fs.readFileSync(path.join(dir, f), 'utf8').slice(0, 5000);
  }
  SK.text = SK.text.slice(0, 15000);
} catch (e) {}

const SYS = (files) => `Sen Kübi'sin: sıcak, sade, Türkçe konuşan bir yapay zekâ asistanısın.
DOSYA KURALLARI:
Yeni dosya ya da tam yeniden yazım için:
<file name="index.html">
...tam içerik...
</file>
Mevcut dosyada küçük değişiklik için dosyayı baştan yazma, şunu kullan (birden fazla olabilir):
<edit name="index.html"><old>dosyada birebir ve tek geçen metin</old><new>yeni metin</new></edit>
Etiketlerin dışında kullanıcıya en fazla 1-3 cümlelik kısa açıklama yaz. Dosyaları \`\`\` bloğuna koyma.
${files.length ? '\nMEVCUT DOSYALAR:\n' + files.map(f => `--- ${f.name} ---\n${String(f.content).slice(0, 24000)}`).join('\n') : ''}
${SK.text ? '\nBECERİLER (skill):' + SK.text : ''}`;

// --- Basit hız sınırı: IP başına dakikada 20 istek ---
const hits = new Map();
app.use('/api/', (q, s, n) => {
  const t = Date.now(), a = (hits.get(q.ip) || []).filter(x => t - x < 60000);
  if (a.length >= 20) return s.status(429).json({ error: 'Çok hızlı' });
  a.push(t); hits.set(q.ip, a); n();
});

app.get('/health', (_q, r) => r.json({ ok: true }));
app.get('/api/status', (_q, r) => r.json({ keys: KEYS.length, models: MD, skills: SK.names }));

app.post('/api/chat', async (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  const send = o => res.write('data: ' + JSON.stringify(o) + '\n\n');
  const ac = new AbortController();
  res.on('close', () => ac.abort());
  try {
    if (!KEYS.length) throw new Error('Sunucuda GROQ1...GROQ6 değişkenleri bulunamadı');
    const { messages = [], mode = 1, files = [] } = req.body || {};
    send({ k: 'stage', id: 'think', label: 'Anlıyor', detail: 'İsteği çözümlüyor' });
    if (SK.names.length) {
      send({ k: 'stage', id: 'skill', label: 'Becerileri okuyor', detail: SK.names.join(', ') });
      send({ k: 'done_stage', id: 'skill', label: 'Beceriler hazır' });
    }
    const first = [MD.fast, MD.main, MD.deep][mode] || MD.main;
    const models = [first, ...[MD.main, MD.deep, MD.fast].filter((m, i, a) => m !== first && a.indexOf(m) === i)];
    const sys = SYS(files);
    let r = null, used = '', sw = 0;
    outer: for (const m of models) {
      for (let t = 0; t < KEYS.length; t++) {
        const k = pickKey(m); if (!k) break;
        try {
          const x = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST', signal: ac.signal,
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + k.v },
            body: JSON.stringify({ model: m, stream: true, temperature: 0.6, messages: [{ role: 'system', content: sys }, ...messages.slice(-12)] }),
          });
          if (x.ok) { r = x; used = m; break outer; }
          if (x.status === 429) {
            k.u[m] = Date.now() + (parseFloat(x.headers.get('retry-after')) || 30) * 1000;
            send({ k: 'stage', id: 'swap' + sw, label: 'Limit doldu, yedeğe geçiliyor' });
            send({ k: 'done_stage', id: 'swap' + sw++, label: 'Yedek seçildi' }); continue;
          }
          if (x.status === 401 || x.status === 403) { k.u[m] = Date.now() + 3600e3; continue; }
          if (x.status >= 500) { k.u[m] = Date.now() + 5000; continue; }
          break; // 400/404: model sorunu, sıradaki modele geç
        } catch (e) { if (ac.signal.aborted) return; k.u[m] = Date.now() + 5000; }
      }
    }
    if (!r) throw new Error('Tüm anahtarlar ve modeller şu an meşgul, birazdan tekrar dene');
    send({ k: 'done_stage', id: 'think', label: 'Düşündü' });
    send({ k: 'model', m: used });
    const rd = r.body.getReader(), dc = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await rd.read(); if (done) break;
      buf += dc.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const ln = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!ln.startsWith('data:') || ln.includes('[DONE]')) continue;
        try { const d = JSON.parse(ln.slice(5)).choices?.[0]?.delta?.content; if (d) send({ k: 'text', d }); } catch (e) {}
      }
    }
  } catch (e) { if (!ac.signal.aborted) send({ k: 'error', m: e.message }); }
  res.end();
});

app.use(express.static(path.join(__dirname, 'public')));
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Kübi hazır, port ${PORT}, ${KEYS.length} anahtar`));
