// Copyright (c) 2026 Alden Lougee. All rights reserved.
// Proprietary and confidential.

import 'dotenv/config';
import express from 'express';
import { buildToneLayerSystem, buildClaritySystem, buildNarcSystem, buildDecodeSystem } from './prompts.js';

const app  = express();
app.use(express.json({ limit: '10mb' }));

const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
const APP_TOKEN      = process.env.APP_TOKEN;
const PORT           = process.env.PORT || 3000;

if (!CLAUDE_API_KEY) { console.error('CLAUDE_API_KEY not set'); process.exit(1); }
if (!APP_TOKEN)      { console.error('APP_TOKEN not set');      process.exit(1); }

// ─── Auth middleware ──────────────────────────────────────────────────────────

function auth(req, res, next) {
  const token = req.headers['x-app-token'];
  if (!token || token !== APP_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ─── Routes ───────────────────────────────────────────────────────────────────

app.get('/health', (_, res) => {
  res.json({ status: 'ok', service: 'ToneLayer API', version: '1.0.0' });
});

// ToneLayer (ND→NT) + Clarity (NT→ND) rewrite
app.post('/rewrite', auth, async (req, res) => {
  const {
    text,
    profile = 'Auto',
    level   = 'Medium',
    mode    = 'tonelayer',   // 'tonelayer' | 'clarity'
    style   = 'Rewrite'     // Clarity styles: Rewrite / Shorter / Warmer / Direct
  } = req.body;

  if (!text?.trim()) {
    return res.status(400).json({ error: 'text is required' });
  }

  try {
    const system = mode === 'clarity'
      ? buildClaritySystem(profile, level, style)
      : buildToneLayerSystem(profile, level);

    const result = await callClaude(system, text, 8192);
    res.json(result);
  } catch (err) {
    console.error('[/rewrite]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Narcissist Screen
app.post('/narc', auth, async (req, res) => {
  const { text } = req.body;

  if (!text?.trim()) {
    return res.status(400).json({ error: 'text is required' });
  }

  try {
    const result = await callClaude(buildNarcSystem(), text, 4096);
    res.json(result);
  } catch (err) {
    console.error('[/narc]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Claude API call ─────────────────────────────────────────────────────────

async function callClaude(system, text, maxTokens = 8192) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method:  'POST',
    headers: {
      'x-api-key':         CLAUDE_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type':      'application/json'
    },
    body: JSON.stringify({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: maxTokens,
      system,
      messages: [{
        role:    'user',
        content: `Text:\n${text}\n\nReply with ONLY valid JSON.`
      }]
    })
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error?.message || `Claude API error ${response.status}`);
  }

  const data    = await response.json();
  const content = data.content[0].text;
  return parseJSON(content);
}

function parseJSON(raw) {
  let s = raw.trim();
  if (s.startsWith('```')) {
    const nl = s.indexOf('\n');
    if (nl > -1) s = s.slice(nl + 1);
    if (s.endsWith('```')) s = s.slice(0, -3).trim();
  }
  const start = s.indexOf('{');
  const end   = s.lastIndexOf('}');
  if (start >= 0 && end > start) s = s.slice(start, end + 1);
  return JSON.parse(s);
}

// Decode (incoming message — translate + baseline-aware flags)
app.post('/decode', auth, async (req, res) => {
  const { text, contact = '', sensitivity = 'Low', baseline = null } = req.body;
  if (!text?.trim()) return res.status(400).json({ error: 'text is required' });
  try {
    const raw = await callClaude(buildDecodeSystem(contact, sensitivity, baseline), text, 1024);
    res.json({
      translation: raw.translation ?? '',
      patterns:    raw.patterns ?? raw.flags ?? [],
      baseline:    raw.baseline ?? raw.baseline_note ?? '',
      tentative:   raw.tentative ?? !raw.is_definitive ?? false,
    });
  } catch (err) {
    console.error('[/decode]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`✅  ToneLayer API running on port ${PORT}`);
  console.log(`    Endpoints: GET /health  POST /rewrite  POST /narc  POST /decode`);
});
