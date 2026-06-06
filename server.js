// Copyright (c) 2026 Alden Lougee. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification,
// distribution, reverse-engineering, or derivative use is prohibited.
// ToneLayer and ToneLayer Clarity are protected by copyright law.

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

app.get('/terms', (_, res) => {
  res.json({
    title: 'ToneLayer & ToneLayer Clarity Beta Testing Agreement',
    lastUpdated: 'June 2026',
    sections: [
      {
        number: 1,
        heading: 'INTELLECTUAL PROPERTY — THE SOFTWARE',
        body: 'ToneLayer and ToneLayer Clarity, including all software, server code, AI prompts, system instructions, design, branding, and associated content, are the exclusive intellectual property of Alden Lougee and are protected by copyright law. You may not copy, reproduce, modify, distribute, reverse-engineer, decompile, scrape, or create derivative works from ToneLayer, ToneLayer Clarity, or any of their components — including but not limited to the API, prompts, or server logic — without explicit written permission from the developer. Unauthorized use constitutes copyright infringement and may result in legal action.'
      },
      {
        number: 2,
        heading: 'YOU OWN WHAT YOU PROCESS',
        body: 'You confirm that you have the right to share and process any text you submit to this API. Do not submit text that belongs to someone else or that you do not have explicit permission to use. The developer is not responsible for any copyright or intellectual-property claims arising from text you submit.'
      },
      {
        number: 3,
        heading: 'BETA SOFTWARE — NO WARRANTIES',
        body: 'This API is beta software. Features may change, crash, or produce unexpected results at any time without notice. Outputs are provided as-is and accuracy is not guaranteed. The developer is not liable for any direct or indirect loss, harm, or misunderstanding resulting from use during the beta period.'
      },
      {
        number: 4,
        heading: 'NOT A SUBSTITUTE FOR PROFESSIONAL HELP',
        body: 'ToneLayer and ToneLayer Clarity are communication aids. They are not medical devices, therapy tools, diagnostic services, or sources of legal advice. They do not provide clinical, psychological, or legal guidance. If you need professional support, please speak with a qualified professional.'
      },
      {
        number: 5,
        heading: 'DATA PROCESSING',
        body: 'Text submitted to this API is sent to Anthropic for AI processing. Text is not permanently stored on this server. Do not submit sensitive personal information such as passwords, financial data, or private medical details.'
      },
      {
        number: 6,
        heading: 'AUTHORIZED USE ONLY',
        body: 'This API is for use exclusively within the ToneLayer and ToneLayer Clarity apps. Use of this API outside of those authorized apps, or any attempt to access, probe, or exploit this service without authorization, is strictly prohibited.'
      }
    ],
    copyright: 'Copyright (c) 2026 Alden Lougee. All rights reserved.'
  });
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
      translation:        raw.translation ?? '',
      patterns:           raw.patterns ?? raw.flags ?? [],
      baseline:           raw.baseline ?? raw.baseline_note ?? '',
      tentative:          raw.tentative ?? !raw.is_definitive ?? false,
      communication_style: raw.communication_style ?? '',
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
