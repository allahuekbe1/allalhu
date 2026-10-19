const express = require('express');
const path = require('path');

const app = express();
app.use(express.json());

app.get('/health', (_req, res) => res.json({ ok: true }));
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Kübi hazır, port ' + PORT));
