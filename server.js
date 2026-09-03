// Copyright (c) 2026 Alden Lougee. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification,
// distribution, reverse-engineering, or derivative use is prohibited.
// ToneLayer and ToneLayer Clarity are protected by copyright law.

import 'dotenv/config';
import express from 'express';
import fs from 'fs';
import path from 'path';
import OpenAI from 'openai';
import { WebSocketServer, WebSocket as WSClient } from 'ws';
import { buildToneLayerSystem, buildClaritySystem, buildNarcSystem, buildDecodeSystem, buildRefineSystem, buildCoachSystem, buildRelationshipAnalysisSystem } from './prompts.js';
import * as toolRegistry from './toolRegistry.js';

const app  = express();
app.use(express.json({ limit: '10mb' }));

// Public transparency log (build-hash log + warrant canary). Served from
// committed, version-controlled files — the git history is the audit trail,
// not the live server state. GET /transparency/canary.json, /transparency/release-hashes.json
app.use('/transparency', express.static(path.join(process.cwd(), 'transparency')));

const CLAUDE_API_KEY   = process.env.CLAUDE_API_KEY;
const APP_TOKEN        = process.env.APP_TOKEN;
const ADMIN_TOKEN      = process.env.ADMIN_TOKEN;
const HUME_API_KEY     = process.env.HUME_API_KEY;
const HUME_SECRET_KEY  = process.env.HUME_SECRET_KEY;
// This specific EVI config is tuned with longer pauses before EVI assumes
// the user is done talking, and a higher bar before EVI yields to an
// interruption — so it doesn't cut the user off mid-thought.
const HUME_CONFIG_ID   = process.env.HUME_CONFIG_ID || 'b65c1f98-4dc7-404f-a6de-30ca963ced1d';
const OPENAI_API_KEY   = process.env.OPENAI_API_KEY;
const PORT             = process.env.PORT || 3000;

if (!CLAUDE_API_KEY) { console.error('CLAUDE_API_KEY not set'); process.exit(1); }
if (!APP_TOKEN)      { console.error('APP_TOKEN not set');      process.exit(1); }
if (!ADMIN_TOKEN)    { console.warn('ADMIN_TOKEN not set — /analytics/summary will be unavailable'); }
if (!HUME_API_KEY || !HUME_SECRET_KEY) { console.warn('HUME_API_KEY/HUME_SECRET_KEY not set — /hume/session will be unavailable'); }
if (!OPENAI_API_KEY) { console.warn('OPENAI_API_KEY not set — /relationship-analysis will be unavailable'); }

const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

// ─── Auth middleware ──────────────────────────────────────────────────────────

function auth(req, res, next) {
  const token = req.headers['x-app-token'];
  if (!token || token !== APP_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

function adminAuth(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (!ADMIN_TOKEN || !token || token !== ADMIN_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ─── Analytics storage (anonymized usage events, JSON file on disk) ──────────

const DATA_DIR = process.env.DATA_DIR || process.cwd();
const ANALYTICS_FILE = path.join(DATA_DIR, 'analytics_events.json');
const MAX_ANALYTICS_EVENTS = 50000;

function loadAnalyticsEvents() {
  try {
    return JSON.parse(fs.readFileSync(ANALYTICS_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function appendAnalyticsEvent(ev) {
  const events = loadAnalyticsEvents();
  events.push(ev);
  const trimmed = events.length > MAX_ANALYTICS_EVENTS
    ? events.slice(events.length - MAX_ANALYTICS_EVENTS)
    : events;
  fs.writeFileSync(ANALYTICS_FILE, JSON.stringify(trimmed));
}

// ─── Waitlist storage (public landing-page signups, JSON file on disk) ───────

const WAITLIST_FILE = path.join(DATA_DIR, 'waitlist.json');

function loadWaitlist() {
  try {
    return JSON.parse(fs.readFileSync(WAITLIST_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function appendWaitlistEntry(entry) {
  const entries = loadWaitlist();
  entries.push(entry);
  fs.writeFileSync(WAITLIST_FILE, JSON.stringify(entries));
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
    lastUpdated: 'July 2026',
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
        body: 'Before text ever leaves your device, the app automatically strips names, phone numbers, addresses, dates, bank account numbers, crypto wallet addresses/private keys/seed phrases, API keys, and any business or trade-secret terms you’ve added yourself — replacing each with a placeholder. Only the placeholder-substituted text is sent to this server, which forwards it to Anthropic for AI processing; the real values are restored on your device once a response returns and are never transmitted or stored. Text is not permanently stored on this server. This redaction is automatic and does not require any action on your part, but it is not a guarantee against every possible leak — stay careful with what you share and who you share it with.'
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

// Refine — targeted correction on an existing rewrite, not a fresh full rewrite
app.post('/refine', auth, async (req, res) => {
  const {
    previousRewrite,
    instruction,
    profile = 'Auto',
    level   = 'Medium',
    mode    = 'tonelayer',
    tone    = ''
  } = req.body;

  if (!previousRewrite?.trim() || !instruction?.trim()) {
    return res.status(400).json({ error: 'previousRewrite and instruction are required' });
  }

  try {
    const system = buildRefineSystem(mode, profile, level, tone);
    const combined = `CURRENT REWRITE:\n${previousRewrite}\n\nINSTRUCTION:\n${instruction}`;
    const result = await callClaude(system, combined, 8192);
    res.json(result);
  } catch (err) {
    console.error('[/refine]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Coach (formerly "Companion") — a single continuous conversational entity
// that both refines rewrites and coaches on prioritization/decisions in the
// same thread, instead of the isolated one-shot request/response every
// other route here uses. Unlike /refine, the client sends the *whole*
// conversation so far (not just one instruction), and the reply is plain
// conversational text, not structured JSON — this is a chat, not a rewrite
// tool. Registered under both /coach (current) and /companion (kept as an
// alias so app installs still on the old client build don't 404 mid-rollout
// — safe to drop once the client's AppConfig.companionURL is fully retired).
app.post(['/coach', '/companion'], auth, async (req, res) => {
  const {
    messages = [],
    rewriteContext = '',
    profile = 'Auto',
    tone = '',
    // Which abilities the client has turned on (Settings' coachCanRewrite/
    // coachCanDecode/coachCanScreenManipulation) — omitted or absent means
    // all on, so older clients that don't send this yet keep working.
    enabledTools = null,
    // Aggregate pattern summary built client-side from LogStore — counts
    // and named patterns only, never raw message text (see CoachView's
    // buildMemoryContext). Optional so older clients keep working.
    memoryContext = '',
    // Already-known name, if the client has one saved from a prior
    // save_user_info call — lets Coach skip re-asking and address the user
    // directly instead of starting the onboarding question every session.
    userName = ''
  } = req.body;

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array is required' });
  }
  for (const m of messages) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string') {
      return res.status(400).json({ error: 'each message needs a role of "user" or "assistant" and string content' });
    }
  }

  try {
    const system = buildCoachSystem(profile, rewriteContext, tone, memoryContext, userName);
    const filtered = Array.isArray(enabledTools)
      ? COACH_TOOLS.filter(t => enabledTools.includes(t.name))
      : COACH_TOOLS;
    // save_user_info is always available, independent of the toggleable
    // abilities — it's onboarding/identity, not a feature the user turns off.
    const tools = [...filtered, SAVE_USER_INFO_TOOL];
    const { text, toolCalls } = await callClaudeConversation(system, messages, 2048, tools, executeCoachTool, 'claude-sonnet-5');
    const savedInfo = toolCalls.find(c => c.name === 'save_user_info')?.input ?? null;
    res.json({ reply: text, userInfo: savedInfo });
  } catch (err) {
    console.error('[/coach]', err.message);
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
    const result = await callClaude(buildNarcSystem(), text, 4096, 'claude-sonnet-5');
    res.json(result);
  } catch (err) {
    console.error('[/narc]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Fetches a short-lived Hume access token via the same OAuth2
// client-credentials exchange the old /hume/session REST endpoint used to
// do directly for clients — now used only internally by the relay below,
// so no Hume credential (not even a short-lived token) ever reaches a
// device at all.
async function fetchHumeAccessToken() {
  const credentials = Buffer.from(`${HUME_API_KEY}:${HUME_SECRET_KEY}`).toString('base64');
  const tokenResp = await fetch('https://api.hume.ai/oauth2-cc/token', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials'
  });
  if (!tokenResp.ok) {
    const errText = await tokenResp.text();
    throw new Error(`Hume token fetch failed (${tokenResp.status}): ${errText}`);
  }
  const tokenJson = await tokenResp.json();
  if (!tokenJson.access_token) throw new Error('No access token returned by Hume');
  return tokenJson.access_token;
}

// ─── Claude API call ─────────────────────────────────────────────────────────

async function callClaude(system, text, maxTokens = 8192, model = 'claude-haiku-4-5-20251001') {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method:  'POST',
    headers: {
      'x-api-key':         CLAUDE_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type':      'application/json'
    },
    body: JSON.stringify({
      model,
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

// Same Claude call, but for a real multi-turn conversation: takes the full
// message history and returns plain conversational text instead of forcing
// every reply into the fixed JSON shape the rewrite/refine/narc/decode
// routes need. Optional `tools`/`executeTool` let the caller (Coach) reach
// into the app's other features as tool calls instead of the user having
// to navigate to a separate tab — see COACH_TOOLS below.
// Returns { text, toolCalls } rather than a bare string — toolCalls records
// every tool invoked during the loop (name + input) so the caller can react
// to ones that carry client-relevant data (e.g. save_user_info) instead of
// only ever seeing Coach's synthesized final reply.
async function callClaudeConversation(system, messages, maxTokens = 2048, tools = null, executeTool = null, model = 'claude-haiku-4-5-20251001') {
  let convo = messages;
  const toolCalls = [];

  for (let iteration = 0; iteration < 5; iteration++) {
    const body = { model, max_tokens: maxTokens, system, messages: convo };
    if (tools) body.tools = tools;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      headers: {
        'x-api-key':         CLAUDE_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type':      'application/json'
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.error?.message || `Claude API error ${response.status}`);
    }

    const data = await response.json();

    if (data.stop_reason !== 'tool_use' || !executeTool) {
      const text = data.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
      return { text, toolCalls };
    }

    // Execute every tool_use block from this turn, then feed all results
    // back in a single user message (parallel tool calls must be answered
    // together — splitting them across messages breaks the API contract).
    const toolUses = data.content.filter(b => b.type === 'tool_use');
    const toolResults = [];
    for (const call of toolUses) {
      toolCalls.push({ name: call.name, input: call.input });
      let output;
      try {
        output = await executeTool(call.name, call.input);
      } catch (err) {
        toolResults.push({ type: 'tool_result', tool_use_id: call.id, content: err.message, is_error: true });
        continue;
      }
      toolResults.push({ type: 'tool_result', tool_use_id: call.id, content: output });
    }

    convo = [...convo, { role: 'assistant', content: data.content }, { role: 'user', content: toolResults }];
  }

  throw new Error('Coach tool loop did not resolve after 5 iterations');
}

// ─── Coach tools ────────────────────────────────────────────────────────────
// Each tool wraps an existing route's own builder + callClaude — same
// prompts, same behavior, just reachable from conversation instead of a
// separate tab. Keep this list scoped; add a tool only once the underlying
// feature already works standalone.

const COACH_TOOLS = [
  {
    name: 'rewrite_message',
    description: 'Rewrite a message so it reads clearly to its recipient. Use when the user shares something they wrote (or want to write) and asks for it to be rewritten, cleaned up, or made to land better for the person reading it.',
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The exact message text to rewrite.' },
        direction: { type: 'string', enum: ['to_nt', 'to_nd'], description: "'to_nt' (default): rewrite the user's own message for an unfamiliar/NT reader. 'to_nd': rewrite a message someone else sent the user so it lands more clearly for an ND reader." },
        level: { type: 'string', enum: ['Light', 'Medium', 'Strong'], description: 'How much to restructure. Default Medium if the user does not say.' }
      },
      required: ['text']
    }
  },
  {
    name: 'decode_message',
    description: "Decode a message the user received from someone else — what it actually means, what communication patterns are present, and how it's written. Use when the user shares a message someone sent them and wants to understand it.",
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The exact message text the user received.' },
        contact: { type: 'string', description: 'Who sent it, only if the user says.' },
        sensitivity: { type: 'string', enum: ['Low', 'Medium', 'High'], description: 'How much to flag. Default Low if the user does not say.' }
      },
      required: ['text']
    }
  },
  {
    name: 'screen_for_manipulation',
    description: 'Deep-dive analysis of a received message specifically for manipulation tactics (gaslighting, DARVO, guilt-tripping, love-bombing, etc.), with direct validation and a short boundary script. Use when the user wants a more thorough read than decode_message on a message that feels off, or explicitly asks to check for manipulation.',
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The exact message text to screen.' }
      },
      required: ['text']
    }
  },
  {
    name: 'check_agreement',
    description: 'Check a contract, subscription terms, checkout page, or similar agreement text for hidden fees, auto-renewal, or other mismatches between what the user expects and what it actually says. Use when the user pastes agreement/contract/subscription/terms text, or asks whether a deal or bill looks right. This calls an external tool (Agree2What) — not built into ToneLayer itself.',
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The exact agreement/contract/subscription text to check.' }
      },
      required: ['text']
    }
  }
];

// Always available, independent of the toggleable abilities above — see the
// /coach route. Calling it doesn't do anything server-side; the point is
// getting the name/preference into the response so the client can persist
// it (see server.js's savedInfo extraction and CoachView's handling).
const SAVE_USER_INFO_TOOL = {
  name: 'save_user_info',
  description: "Call this the moment the user tells you their name, or states a preference for typing vs. speaking — even in passing, not just in direct answer to being asked. Don't wait for a dedicated onboarding moment; if they mention it, save it.",
  input_schema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: "The user's name, exactly as they gave it." },
      prefersVoice: { type: 'boolean', description: 'True if they said they prefer speaking/voice, false if they said they prefer typing. Omit if they did not say.' }
    },
    required: ['name']
  }
};

async function executeCoachTool(name, input) {
  if (name === 'rewrite_message') {
    const system = input.direction === 'to_nd'
      ? buildClaritySystem('General ND', input.level || 'Medium', 'Rewrite', '')
      : buildToneLayerSystem('Auto', input.level || 'Medium', '');
    const result = await callClaude(system, input.text, 8192);
    return JSON.stringify({ paragraphs: result.paragraphs, explanation: result.explanation });
  }
  if (name === 'decode_message') {
    const system = buildDecodeSystem(input.contact || '', input.sensitivity || 'Low', null, '');
    const result = await callClaude(system, input.text, 1024, 'claude-sonnet-5');
    return JSON.stringify(result);
  }
  if (name === 'screen_for_manipulation') {
    const result = await callClaude(buildNarcSystem(), input.text, 4096, 'claude-sonnet-5');
    return JSON.stringify(result);
  }
  if (name === 'save_user_info') {
    // No server-side action — the /coach route pulls this call's input
    // straight out of toolCalls and returns it to the client to persist.
    // This ack is just what goes back to Claude to continue the turn.
    return JSON.stringify({ saved: true });
  }
  if (name === 'check_agreement') {
    // Looked up by name against the same registry the standalone
    // orchestrator (/tools/route, /tools/:id/invoke) uses — Coach isn't a
    // separate integration path, it's another caller of the same external-
    // tool system, so a tool suspended or disabled there is unavailable
    // here too, automatically, with no separate toggle to keep in sync.
    const tool = toolRegistry
      .listTools({ status: 'approved' })
      .find(t => t.enabled && t.name.toLowerCase() === 'agree2what');
    if (!tool) {
      return JSON.stringify({ error: 'Agreement checking is not available right now.' });
    }
    try {
      const data = await invokeTool(tool, { clipboardText: input.text });
      return JSON.stringify(data);
    } catch (err) {
      return JSON.stringify({ error: 'Could not check this agreement right now.' });
    }
  }
  throw new Error(`Unknown tool: ${name}`);
}

// OpenAI call for cross-conversation relationship analysis — deliberately a
// separate provider from callClaude/callClaudeConversation above, per
// project decision (see project memory: user specifically wants this
// feature on OpenAI, not Claude). Conversations are expected to already be
// PII-redacted client-side before they ever reach this server, same as
// every other AI-calling route here.
async function callOpenAI(system, conversations) {
  if (!openai) throw new Error('OpenAI is not configured on this server');

  const transcript = conversations
    .map(c => `--- Conversation on ${c.date} ---\n${c.transcript}`)
    .join('\n\n');

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: `${transcript}\n\nReply with ONLY valid JSON.` }
    ]
  });

  return parseJSON(completion.choices[0].message.content);
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
  const { text, contact = '', sensitivity = 'Low', baseline = null, senderProfile = '', tone = '' } = req.body;
  if (!text?.trim()) return res.status(400).json({ error: 'text is required' });
  try {
    const raw = await callClaude(buildDecodeSystem(contact, sensitivity, baseline, senderProfile, tone), text, 1024, 'claude-sonnet-5');
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

// Cross-conversation relationship analysis (OpenAI, not Claude — see the
// callOpenAI comment above). Expects several already-redacted conversations
// between the same two people, each with a date, so patterns can be
// analyzed across time rather than within a single message or thread.
app.post('/relationship-analysis', auth, async (req, res) => {
  const { conversations } = req.body;
  if (!Array.isArray(conversations) || conversations.length === 0) {
    return res.status(400).json({ error: 'conversations (non-empty array) is required' });
  }
  if (conversations.some(c => !c?.date || !c?.transcript?.trim())) {
    return res.status(400).json({ error: 'each conversation needs a date and a non-empty transcript' });
  }
  try {
    const raw = await callOpenAI(buildRelationshipAnalysisSystem(), conversations);
    res.json({
      summary:         raw.summary ?? '',
      patterns:        raw.patterns ?? [],
      notable_shifts:  raw.notable_shifts ?? [],
      confidence:      raw.confidence ?? 'low',
      caveats:         raw.caveats ?? '',
    });
  } catch (err) {
    console.error('[/relationship-analysis]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Anonymous usage analytics ───────────────────────────────────────────────
// Receives fully anonymized counts/scores from opted-in installs (random
// per-install ID, no message text or anything identifying). Used to
// demonstrate aggregate impact for funders/insurers via /analytics/summary.

app.post('/analytics', auth, (req, res) => {
  const {
    installId, event,
    inputLength, outputLength, distortionCount,
    correctionScore, feedbackLabel, clarity, overwhelm,
  } = req.body || {};

  if (!installId || !event) {
    return res.status(400).json({ error: 'installId and event are required' });
  }

  appendAnalyticsEvent({
    installId:        String(installId).slice(0, 64),
    event:            String(event).slice(0, 64),
    inputLength:      Number.isFinite(inputLength) ? inputLength : 0,
    outputLength:     Number.isFinite(outputLength) ? outputLength : 0,
    distortionCount:  Number.isFinite(distortionCount) ? distortionCount : 0,
    correctionScore:  Number.isFinite(correctionScore) ? correctionScore : null,
    feedbackLabel:    typeof feedbackLabel === 'string' ? feedbackLabel.slice(0, 32) : null,
    clarity:          Number.isFinite(clarity) ? clarity : null,
    overwhelm:        Number.isFinite(overwhelm) ? overwhelm : null,
    timestamp:        new Date().toISOString(),
  });

  res.json({ ok: true });
});

// Aggregate totals for funder/insurer reporting. Protected by a separate
// admin token so the raw per-install analytics aren't publicly readable.
app.get('/analytics/summary', adminAuth, (_, res) => {
  const events = loadAnalyticsEvents();

  const eventCounts = {};
  for (const e of events) {
    eventCounts[e.event] = (eventCounts[e.event] || 0) + 1;
  }

  const feedbackCounts = {};
  for (const e of events) {
    if (e.event === 'feedback_submitted' && e.feedbackLabel) {
      feedbackCounts[e.feedbackLabel] = (feedbackCounts[e.feedbackLabel] || 0) + 1;
    }
  }
  const totalFeedback = Object.values(feedbackCounts).reduce((a, b) => a + b, 0);
  const positiveFeedback = (feedbackCounts['helpful'] || 0) + (feedbackCounts['positive'] || 0);
  const percentPositiveFeedback = totalFeedback > 0
    ? Math.round((positiveFeedback / totalFeedback) * 100)
    : null;

  const correctionScores = events.map(e => e.correctionScore).filter(s => typeof s === 'number');
  const avgCorrectionScore = correctionScores.length
    ? Math.round(correctionScores.reduce((a, b) => a + b, 0) / correctionScores.length)
    : null;

  res.json({
    totalEvents: events.length,
    uniqueInstalls: new Set(events.map(e => e.installId)).size,
    eventCounts,
    feedbackCounts,
    percentPositiveFeedback,
    avgCorrectionScore,
    generatedAt: new Date().toISOString(),
  });
});

// Public landing-page waitlist signup — called directly from the browser at
// www.tonelayer.app, so it needs CORS (unlike every other route here, which
// is only ever called from the native apps) and must NOT require the app
// token, since anything shipped in public page JS is visible to anyone.
app.post('/waitlist', (req, res) => {
  res.set('Access-Control-Allow-Origin', 'https://www.tonelayer.app');
  const name  = String(req.body?.name  || '').trim();
  const email = String(req.body?.email || '').trim();

  if (!email || !EMAIL_RE.test(email)) {
    return res.status(400).json({ error: 'A valid email is required.' });
  }

  appendWaitlistEntry({ name, email, timestamp: new Date().toISOString() });
  res.json({ ok: true });
});

app.options('/waitlist', (_, res) => {
  res.set('Access-Control-Allow-Origin', 'https://www.tonelayer.app');
  res.set('Access-Control-Allow-Methods', 'POST');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  res.status(204).end();
});

// View collected signups — admin-token gated, same pattern as
// /analytics/summary, so the raw list (names/emails) isn't publicly readable.
app.get('/waitlist', adminAuth, (_, res) => {
  res.json({ entries: loadWaitlist() });
});

// ─── External developer tools (registry + orchestration) ────────────────────
//
// Extensibility model: a third-party developer runs their own tool on their
// own server. This server never executes third-party code — it only proxies
// a filtered slice of context to a tool's endpoint and relays the response
// back to the app. See toolRegistry.js for the privacy boundary this relies
// on: a tool only ever receives the context fields it explicitly declared
// wanting at registration, enforced here server-side, not left to policy.
// Full contract for developers: DEVELOPER_API.md.

const TOOL_CAN_HANDLE_TIMEOUT_MS = 3000;
const TOOL_INVOKE_TIMEOUT_MS     = 15000;

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Self-serve registration. Public — no app token, since these are outside
// developers, not the ToneLayer app itself. The API key is returned exactly
// once; the developer must save it immediately, same principle as every
// other secret in this codebase.
app.post('/developer/tools/register', (req, res) => {
  try {
    const { tool, apiKey } = toolRegistry.registerTool(req.body ?? {});
    res.status(201).json({
      tool,
      apiKey,
      notice: 'Save this API key now — it will not be shown again. Your tool is pending review and will not be routed to any user until approved.',
    });
  } catch (err) {
    if (err instanceof toolRegistry.ValidationError) {
      return res.status(400).json({ error: err.message });
    }
    console.error('tool registration failed:', err);
    res.status(500).json({ error: 'Registration failed.' });
  }
});

function toolKeyAuth(req, res, next) {
  const key = req.headers['x-tool-api-key'];
  if (!key) return res.status(401).json({ error: 'Missing x-tool-api-key header' });
  const tool = toolRegistry.findByApiKey(String(key));
  if (!tool) return res.status(401).json({ error: 'Invalid API key' });
  req.tool = tool;
  next();
}

// A developer checking on their own tool's review status.
app.get('/developer/tools/me', toolKeyAuth, (req, res) => {
  res.json({ tool: toolRegistry.getTool(req.tool.id) });
});

// Self-serve pause/resume only. Changing the endpoint or requested data
// needs re-review, so that isn't exposed here yet — register a new tool
// for that until a proper resubmission flow exists.
app.patch('/developer/tools/me', toolKeyAuth, (req, res) => {
  if (typeof req.body?.enabled !== 'boolean') {
    return res.status(400).json({
      error: 'Only { enabled: boolean } can be changed here. To change your endpoint or requested data, register a new tool — that needs re-review either way.',
    });
  }
  const tool = toolRegistry.setEnabled(req.tool.id, req.body.enabled);
  res.json({ tool });
});

app.post('/developer/tools/me/rotate-key', toolKeyAuth, (req, res) => {
  const { tool, apiKey } = toolRegistry.rotateApiKey(req.tool.id);
  res.json({
    tool,
    apiKey,
    notice: 'Save this new key now — the old one stopped working immediately and this one will not be shown again.',
  });
});

// ─── Admin: tool review queue ─────────────────────────────────────────────────

app.get('/admin/tools', adminAuth, (req, res) => {
  res.json({ tools: toolRegistry.listTools({ status: req.query.status }) });
});

app.post('/admin/tools/:id/approve', adminAuth, (req, res) => {
  const tool = toolRegistry.setStatus(req.params.id, 'approved');
  if (!tool) return res.status(404).json({ error: 'Tool not found' });
  res.json({ tool });
});

app.post('/admin/tools/:id/reject', adminAuth, (req, res) => {
  const tool = toolRegistry.setStatus(req.params.id, 'rejected');
  if (!tool) return res.status(404).json({ error: 'Tool not found' });
  res.json({ tool });
});

app.post('/admin/tools/:id/suspend', adminAuth, (req, res) => {
  const tool = toolRegistry.setStatus(req.params.id, 'suspended');
  if (!tool) return res.status(404).json({ error: 'Tool not found' });
  res.json({ tool });
});

// ─── Orchestration: called by the ToneLayer app only (app-token gated) ───────

// Fans out to every approved+enabled tool's /can-handle with a short
// timeout and only that tool's own declared slice of context. A broken or
// slow third-party tool is dropped from the results, not surfaced as an
// error — one bad external tool must never degrade the orchestrator for
// every user.
app.post('/tools/route', auth, async (req, res) => {
  const context = req.body?.context ?? {};
  const candidates = toolRegistry.routableTools();

  const results = await Promise.all(candidates.map(async (tool) => {
    try {
      const filtered = toolRegistry.filterContextForTool(tool, context);
      const response = await fetchWithTimeout(`${tool.endpointBaseURL}/can-handle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ context: filtered }),
      }, TOOL_CAN_HANDLE_TIMEOUT_MS);
      if (!response.ok) return null;
      const data = await response.json();
      if (!data?.canHandle) return null;
      const confidence = typeof data.confidence === 'number' ? Math.max(0, Math.min(1, data.confidence)) : 0.5;
      return {
        toolId: tool.id,
        name: tool.name,
        confidence,
        summary: typeof data.summary === 'string' ? data.summary : undefined,
      };
    } catch (err) {
      console.error(`tool ${tool.id} (${tool.name}) can-handle failed:`, err.message);
      return null;
    }
  }));

  const ranked = results.filter(Boolean).sort((a, b) => b.confidence - a.confidence);
  res.json({ candidates: ranked });
});

// Shared by the HTTP proxy route below and by Coach's own direct tool-call
// path (COACH_TOOLS' check_agreement) — one place that actually calls out
// to a third-party tool's /handle endpoint, so the context-filtering
// privacy boundary can't be bypassed by either caller.
async function invokeTool(tool, context) {
  const filtered = toolRegistry.filterContextForTool(tool, context ?? {});
  const response = await fetchWithTimeout(`${tool.endpointBaseURL}/handle`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ context: filtered }),
  }, TOOL_INVOKE_TIMEOUT_MS);
  if (!response.ok) {
    throw new Error('Tool did not respond successfully.');
  }
  return response.json();
}

// Proxies to one specific tool's /handle endpoint. The app never talks to a
// third-party server directly — every external-tool call goes through here
// so it can be logged, rate-limited, and revoked in one place without an
// app update.
app.post('/tools/:id/invoke', auth, async (req, res) => {
  const tool = toolRegistry.getTool(req.params.id);
  if (!tool || tool.status !== 'approved' || !tool.enabled) {
    return res.status(404).json({ error: 'Tool not available' });
  }
  try {
    const data = await invokeTool(tool, req.body?.context ?? {});
    res.json(data);
  } catch (err) {
    console.error(`tool ${tool.id} (${tool.name}) invoke failed:`, err.message);
    res.status(502).json({ error: 'Tool did not respond in time.' });
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
    <div class="updated">Last updated: July 2026</div>
    <div class="card">
      <p>
        This policy covers <strong>ToneLayer</strong> and <strong>ToneLayer Clarity</strong>
        (the "apps") and the services at <strong>tonelayer.app</strong>. It explains what
        information is processed when you use the apps and the ToneLayer keyboard extensions,
        and how that information is handled.
      </p>

      <h2>1. Text You Submit for Rewriting or Decoding</h2>
      <p>
        Before any text leaves your device, the app automatically detects and replaces
        personally identifying and financially sensitive details with placeholder tokens:
        names, phone numbers, addresses, dates, bank account numbers, crypto wallet
        addresses, crypto private keys, seed phrases, and API keys/tokens. Only the
        placeholder-substituted text is sent, over an encrypted (HTTPS) connection, to the
        ToneLayer server, which forwards it to Anthropic's Claude API to generate a response.
        Once a response returns, the real values are swapped back in <strong>on your device</strong> —
        the original values are never transmitted or stored anywhere.
      </p>
      <ul>
        <li>Your text is <strong>not stored permanently</strong> on the ToneLayer server, and what
          the server and Anthropic ever see is the redacted version, not your original text.</li>
        <li>For the categories above that carry the highest risk if leaked (bank accounts,
          crypto keys/addresses, seed phrases, API keys), the app tells you when something
          was caught and redacted.</li>
        <li>This protection is automatic and on by default — you don't need to do anything to
          enable it — but it is not a guarantee against every possible leak. Stay careful with
          what you share and who you share it with.</li>
      </ul>

      <h2>2. Business &amp; Trade-Secret Terms You Add Yourself</h2>
      <p>
        Client names, project codenames, and other business-confidential terms aren't
        detectable the way a phone number or address is — there's no pattern to recognize,
        only whatever you tell the app to always protect. You can add your own list of these
        terms (in the app, or at first launch), and anything on that list is redacted from
        every message the same way as the categories in Section 1, before it ever leaves your
        device. This list is stored only on your device (and synced to your keyboard extension
        via your device's local app-group storage) — it is never sent to our servers.
      </p>

      <h2>3. Voice &amp; Microphone (TonalInsight&trade; feature)</h2>
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

      <h2>4. Information Stored on Your Device</h2>
      <p>
        The apps and their keyboard extensions share a small amount of data on your device
        (an "App Group" container) so the keyboard can remember things like whether you've
        accepted the Beta Testing Agreement, your communication profile and settings, and the
        most recent teaching note. This information stays on your device and is not sent to
        our servers.
      </p>

      <h2>5. No Accounts, No Ads, No Tracking</h2>
      <p>
        The apps do not require you to create an account or sign in. We do not use
        third-party advertising or analytics SDKs, and we do not sell or share your
        information with advertisers or data brokers.
      </p>

      <h2>6. Optional Anonymous Usage Analytics</h2>
      <p>
        Settings includes a separate, off-by-default toggle called "Share anonymous
        usage data." If you turn this on, the app sends anonymous counts — such as
        how many rewrites you do, whether you marked a result helpful, and average
        correction scores — to our server so we can demonstrate the app's impact to
        funders and insurers.
      </p>
      <ul>
        <li>This never includes your message text, contacts, or anything else
          identifying.</li>
        <li>Each install is tagged with a random ID generated on your device. It is
          not linked to your identity, account, or device in any other way.</li>
        <li>This toggle is independent of, and off by default like, the
          Personalization &amp; Outcomes setting described above.</li>
      </ul>

      <h2>7. Data Security &amp; Transparency</h2>
      <p>
        All communication with the ToneLayer server is encrypted in transit (HTTPS), and
        access to the API requires an authorization token bundled with the apps.
      </p>
      <p>
        We also publish a public build-hash log and a warrant canary at
        <a href="/transparency/canary.json">/transparency/canary.json</a> and
        <a href="/transparency/release-hashes.json">/transparency/release-hashes.json</a>.
        These are updated on a regular schedule and committed to public version-control
        history, so that if we were ever compelled to distribute a secretly modified build,
        or legally barred from disclosing that a request for data occurred, the resulting
        silence or gap would itself be independently observable rather than resting on trust
        alone.
      </p>

      <h2>8. Children's Privacy</h2>
      <p>
        The apps are not directed to children under 13, and we do not knowingly collect
        information from children under 13.
      </p>

      <h2>9. Changes to This Policy</h2>
      <p>
        We may update this policy from time to time. Material changes will be reflected by
        updating the "Last updated" date above.
      </p>

      <h2>10. Contact</h2>
      <p>
        Questions about this policy can be sent through the feedback option in the app or to
        the support email listed on the App Store listing.
      </p>
    </div>
    <footer>Copyright (c) 2026 Alden Lougee. All rights reserved.</footer>
  </div>
</body>
</html>`;

// ─── Hume voice relay (WebSocket) ──────────────────────────────────────────
// Devices never talk to Hume directly at all — they connect here, and this
// relays to Hume's real WebSocket behind the scenes, so no Hume credential
// (not even a short-lived token) ever reaches a device. Auth happens via the
// connection's *first message*, not a URL param (so a token never lands in
// access/proxy logs) — this also works uniformly for iOS
// (URLSessionWebSocketTask, which can set headers on connect) and the
// Chrome extension (plain WebSocket, which can't set custom headers at
// all). Past that first message, this is a dumb bidirectional byte relay —
// it doesn't parse or understand Hume's protocol, just forwards frames
// (preserving binary vs. text) in both directions.
const humeRelayWSS = new WebSocketServer({ noServer: true });

humeRelayWSS.on('connection', (clientWS) => {
  let humeWS = null;
  let authed = false;
  const pending = []; // [data, isBinary] pairs queued until Hume's socket opens

  const closeBoth = (code, reason) => {
    if (clientWS.readyState === WSClient.OPEN) clientWS.close(code, reason);
    if (humeWS && humeWS.readyState === WSClient.OPEN) humeWS.close(code, reason);
  };

  clientWS.on('message', async (data, isBinary) => {
    if (!authed) {
      if (isBinary) return closeBoth(1008, 'First message must be auth');
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return closeBoth(1008, 'Invalid auth message'); }
      if (msg.type !== 'auth' || msg.token !== APP_TOKEN) return closeBoth(1008, 'Unauthorized');
      authed = true;

      if (!HUME_API_KEY || !HUME_SECRET_KEY) {
        return closeBoth(1011, 'Hume voice is not configured on this server');
      }
      try {
        const accessToken = await fetchHumeAccessToken();
        const params = new URLSearchParams({ access_token: accessToken, config_id: HUME_CONFIG_ID });
        // Lets a client resume an existing Hume chat group (conversation
        // continuity) by naming it in the auth message — same mechanism the
        // extension previously passed straight through to Hume itself.
        if (typeof msg.resumedChatGroupId === 'string' && msg.resumedChatGroupId) {
          params.set('resumed_chat_group_id', msg.resumedChatGroupId);
        }
        humeWS = new WSClient(`wss://api.hume.ai/v0/evi/chat?${params.toString()}`);

        humeWS.on('open', () => {
          for (const [buf, bin] of pending) humeWS.send(buf, { binary: bin });
          pending.length = 0;
        });
        humeWS.on('message', (humeData, humeBinary) => {
          if (clientWS.readyState === WSClient.OPEN) clientWS.send(humeData, { binary: humeBinary });
        });
        humeWS.on('close', (code, reason) => closeBoth(code, reason));
        humeWS.on('error', (err) => {
          console.error('[hume relay] hume socket error', err.message);
          closeBoth(1011, 'Hume connection error');
        });
      } catch (err) {
        console.error('[hume relay] auth/connect failed', err.message);
        closeBoth(1011, 'Could not connect to Hume');
      }
      return;
    }

    if (humeWS && humeWS.readyState === WSClient.OPEN) {
      humeWS.send(data, { binary: isBinary });
    } else {
      pending.push([data, isBinary]);
    }
  });

  clientWS.on('close', () => { if (humeWS) humeWS.close(); });
  clientWS.on('error', () => { if (humeWS) humeWS.close(); });
});

// ─── Start ────────────────────────────────────────────────────────────────────

const server = app.listen(PORT, () => {
  console.log(`✅  ToneLayer API running on port ${PORT}`);
  console.log(`    Endpoints: GET /health  POST /rewrite  POST /refine  POST /coach (alias: /companion)  POST /narc  POST /decode  WS /hume/relay  POST /relationship-analysis  POST /analytics  GET /analytics/summary  POST /waitlist  GET /waitlist  GET /privacy  GET /terms  POST /developer/tools/register  GET /developer/tools/me  PATCH /developer/tools/me  POST /developer/tools/me/rotate-key  GET /admin/tools  POST /admin/tools/:id/approve  POST /admin/tools/:id/reject  POST /admin/tools/:id/suspend  POST /tools/route  POST /tools/:id/invoke`);
});

server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url, `http://${req.headers.host}`);
  if (pathname === '/hume/relay') {
    humeRelayWSS.handleUpgrade(req, socket, head, (ws) => {
      humeRelayWSS.emit('connection', ws, req);
    });
  } else {
    socket.destroy();
  }
});
