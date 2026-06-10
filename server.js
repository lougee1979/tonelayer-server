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

app.get('/privacy', (_, res) => {
  res.type('html').send(privacyPolicyHTML);
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
    style   = 'Rewrite',    // Clarity styles: Rewrite / Shorter / Warmer / Direct
    tone    = ''            // optional vocal-tone summary from TonalInsight (e.g. "Anxiety 64%, Tension 51%")
  } = req.body;

  if (!text?.trim()) {
    return res.status(400).json({ error: 'text is required' });
  }

  try {
    const system = mode === 'clarity'
      ? buildClaritySystem(profile, level, style, tone)
      : buildToneLayerSystem(profile, level, tone);

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

// ─── Privacy policy page ──────────────────────────────────────────────────────

const privacyPolicyHTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Privacy Policy — ToneLayer</title>
<style>
  body {
    margin: 0;
    padding: 0;
    background: #f3f0fb;
    color: #1f1c2e;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    line-height: 1.6;
  }
  .wrap {
    max-width: 720px;
    margin: 0 auto;
    padding: 40px 24px 80px;
  }
  h1 {
    font-size: 28px;
    font-weight: 800;
    color: #5e1fc8;
    margin-bottom: 4px;
  }
  .updated {
    color: #6b6480;
    font-size: 14px;
    margin-bottom: 32px;
  }
  h2 {
    font-size: 17px;
    font-weight: 700;
    color: #3a2e6e;
    margin-top: 32px;
    margin-bottom: 8px;
  }
  p, li {
    font-size: 15px;
    color: #2a2640;
  }
  ul { padding-left: 22px; }
  a { color: #5e1fc8; }
  .card {
    background: #ffffff;
    border-radius: 18px;
    padding: 28px 32px;
    box-shadow: 0 1px 4px rgba(60, 30, 110, 0.08);
  }
  footer {
    margin-top: 32px;
    font-size: 13px;
    color: #8a8398;
    text-align: center;
  }
</style>
</head>
<body>
  <div class="wrap">
    <h1>ToneLayer Privacy Policy</h1>
    <div class="updated">Last updated: June 2026</div>
    <div class="card">
      <p>
        This policy covers <strong>ToneLayer</strong> and <strong>ToneLayer Clarity</strong>
        (the "apps") and the services at <strong>tonelayer.app</strong>. It explains what
        information is processed when you use the apps and the ToneLayer keyboard extensions,
        and how that information is handled.
      </p>

      <h2>1. Text You Submit for Rewriting or Decoding</h2>
      <p>
        When you use a rewrite, decode, or screening feature, the text you enter is sent over
        an encrypted (HTTPS) connection to the ToneLayer server, which forwards it to
        Anthropic's Claude API to generate a response. The result is sent back to your device.
      </p>
      <ul>
        <li>Your text is <strong>not stored permanently</strong> on the ToneLayer server.</li>
        <li>Please do not enter passwords, financial information, or sensitive medical or
          legal details into the apps or keyboards.</li>
      </ul>

      <h2>2. Voice &amp; Microphone (TonalInsight&trade; feature)</h2>
      <p>
        The optional TonalInsight&trade; feature uses your device's microphone to analyze the tone of
        your voice. When active, audio is streamed directly to Hume AI's Empathic Voice
        Interface (EVI) for vocal-tone (prosody) analysis.
      </p>
      <ul>
        <li>Audio is <strong>not recorded or stored</strong> by ToneLayer.</li>
        <li>Audio is not played back to you or anyone else.</li>
        <li>TonalInsight&trade; is entirely optional and only runs while you are actively using it.</li>
      </ul>

      <h2>3. Information Stored on Your Device</h2>
      <p>
        The apps and their keyboard extensions share a small amount of data on your device
        (an "App Group" container) so the keyboard can remember things like whether you've
        accepted the Beta Testing Agreement, your communication profile and settings, and the
        most recent teaching note. This information stays on your device and is not sent to
        our servers.
      </p>

      <h2>4. No Accounts, No Ads, No Tracking</h2>
      <p>
        The apps do not require you to create an account or sign in. We do not use
        third-party advertising or analytics SDKs, and we do not sell or share your
        information with advertisers or data brokers.
      </p>

      <h2>5. Data Security</h2>
      <p>
        All communication with the ToneLayer server is encrypted in transit (HTTPS), and
        access to the API requires an authorization token bundled with the apps.
      </p>

      <h2>6. Children's Privacy</h2>
      <p>
        The apps are not directed to children under 13, and we do not knowingly collect
        information from children under 13.
      </p>

      <h2>7. Changes to This Policy</h2>
      <p>
        We may update this policy from time to time. Material changes will be reflected by
        updating the "Last updated" date above.
      </p>

      <h2>8. Contact</h2>
      <p>
        Questions about this policy can be sent through the feedback option in the app or to
        the support email listed on the App Store listing.
      </p>
    </div>
    <footer>Copyright (c) 2026 Alden Lougee. All rights reserved.</footer>
  </div>
</body>
</html>`;

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`✅  ToneLayer API running on port ${PORT}`);
  console.log(`    Endpoints: GET /health  POST /rewrite  POST /narc  POST /decode  GET /privacy  GET /terms`);
});
