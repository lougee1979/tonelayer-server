// Copyright (c) 2026 Alden Lougee. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification,
// distribution, reverse-engineering, or derivative use is prohibited.
//
// Registry for third-party "external tools" — the extensibility model is
// deliberately API-only: a developer runs their own tool on their own
// server, and ToneLayer's orchestrator sends it context and displays the
// response. No third-party code ever runs inside the ToneLayer app or on
// this server. This keeps the trust boundary at the network edge, where it
// can be audited, rate-limited, and revoked per-tool without touching the
// app binary or App Store review.

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const DATA_DIR = process.env.DATA_DIR || process.cwd();
const REGISTRY_FILE = path.join(DATA_DIR, 'tool_registry.json');

// The ONLY fields an external tool may ever request, and the only fields
// the orchestrator will ever forward. A tool declaring anything outside
// this list is rejected at registration, not silently ignored later —
// fail loud, not quiet. Matches the `ToolContext` fields already named in
// the platform spec (foreground app, clipboard text, ND profile, tier,
// detected state); session memory is deliberately excluded from v1 since
// it's the least scoped/most sensitive field.
export const ALLOWED_CONTEXT_FIELDS = Object.freeze([
  'foregroundApp',
  'clipboardText',
  'ndProfile',
  'tier',
  'detectedState',
]);

// Fields a tool developer should expect real friction to get approved for,
// because they carry the most sensitive user data. Not a hard block —
// legitimate tools (e.g. a rewrite assistant) genuinely need clipboardText
// — but every registration requesting one of these is flagged for the
// admin review queue rather than fast-tracked, and the eventual in-app
// consent screen must ask per-tool, per-field, not bundle it into a single
// "allow this tool" toggle.
export const HIGH_SENSITIVITY_FIELDS = Object.freeze(['clipboardText', 'ndProfile']);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const STATUSES = Object.freeze(['pending', 'approved', 'rejected', 'suspended']);

function load() {
  try {
    return JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function persist(tools) {
  fs.writeFileSync(REGISTRY_FILE, JSON.stringify(tools, null, 2));
}

function hashKey(rawKey) {
  return crypto.createHash('sha256').update(rawKey).digest('hex');
}

function generateApiKey() {
  return crypto.randomBytes(32).toString('hex');
}

/** Strips anything a developer or admin request must never see back: the key hash. */
function toPublic(tool) {
  const { apiKeyHash, ...rest } = tool;
  return rest;
}

export class ValidationError extends Error {}

function validateRegistration(body) {
  const { name, description, developerEmail, endpointBaseURL, dataAccessed, dataRetention } = body;
  if (!name || typeof name !== 'string' || name.trim().length < 2) {
    throw new ValidationError('name is required (min 2 characters)');
  }
  if (!description || typeof description !== 'string' || description.trim().length < 10) {
    throw new ValidationError('description is required (min 10 characters) — say what the tool actually does');
  }
  if (!developerEmail || !EMAIL_RE.test(developerEmail)) {
    throw new ValidationError('developerEmail must be a valid email address');
  }
  // https:// required in general; http://localhost (or 127.0.0.1) is the
  // standard local-dev exception so a developer can test against their own
  // machine before deploying anywhere real — same convention OAuth
  // providers use for redirect URIs.
  const isSecure = /^https:\/\//.test(endpointBaseURL || '');
  const isLocalDev = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(endpointBaseURL || '');
  if (!endpointBaseURL || (!isSecure && !isLocalDev)) {
    throw new ValidationError('endpointBaseURL must be an https:// URL (http://localhost is allowed for local testing only)');
  }
  if (!Array.isArray(dataAccessed)) {
    throw new ValidationError('dataAccessed must be an array of context field names, even if empty');
  }
  const unknown = dataAccessed.filter((f) => !ALLOWED_CONTEXT_FIELDS.includes(f));
  if (unknown.length > 0) {
    throw new ValidationError(
      `dataAccessed contains fields this platform doesn't provide: ${unknown.join(', ')}. Allowed: ${ALLOWED_CONTEXT_FIELDS.join(', ')}`
    );
  }
  if (!dataRetention || typeof dataRetention !== 'string' || dataRetention.trim().length < 5) {
    throw new ValidationError('dataRetention is required — a plain-language statement of what you store and for how long (e.g. "Not stored; processed in-memory only.")');
  }
}

export function registerTool(body) {
  validateRegistration(body);
  const tools = load();
  const rawKey = generateApiKey();
  const now = new Date().toISOString();
  const tool = {
    id: crypto.randomUUID(),
    name: body.name.trim(),
    description: body.description.trim(),
    developerEmail: body.developerEmail.trim(),
    endpointBaseURL: body.endpointBaseURL.trim().replace(/\/+$/, ''),
    dataAccessed: body.dataAccessed,
    dataRetention: body.dataRetention.trim(),
    apiKeyHash: hashKey(rawKey),
    status: 'pending',
    enabled: true,
    flaggedForReview: body.dataAccessed.some((f) => HIGH_SENSITIVITY_FIELDS.includes(f)),
    createdAt: now,
    updatedAt: now,
  };
  tools.push(tool);
  persist(tools);
  // rawKey is returned exactly once, here — it is never stored or
  // retrievable again, same principle as every password in this codebase.
  return { tool: toPublic(tool), apiKey: rawKey };
}

export function findByApiKey(rawKey) {
  const hash = hashKey(rawKey);
  return load().find((t) => t.apiKeyHash === hash) ?? null;
}

export function getTool(id) {
  const tool = load().find((t) => t.id === id);
  return tool ? toPublic(tool) : null;
}

export function getToolWithSecret(id) {
  return load().find((t) => t.id === id) ?? null;
}

export function listTools({ status } = {}) {
  const tools = load().map(toPublic);
  return status ? tools.filter((t) => t.status === status) : tools;
}

export function setEnabled(id, enabled) {
  const tools = load();
  const tool = tools.find((t) => t.id === id);
  if (!tool) return null;
  tool.enabled = !!enabled;
  tool.updatedAt = new Date().toISOString();
  persist(tools);
  return toPublic(tool);
}

export function rotateApiKey(id) {
  const tools = load();
  const tool = tools.find((t) => t.id === id);
  if (!tool) return null;
  const rawKey = generateApiKey();
  tool.apiKeyHash = hashKey(rawKey);
  tool.updatedAt = new Date().toISOString();
  persist(tools);
  return { tool: toPublic(tool), apiKey: rawKey };
}

export function setStatus(id, status) {
  if (!STATUSES.includes(status)) throw new ValidationError(`status must be one of: ${STATUSES.join(', ')}`);
  const tools = load();
  const tool = tools.find((t) => t.id === id);
  if (!tool) return null;
  tool.status = status;
  tool.updatedAt = new Date().toISOString();
  persist(tools);
  return toPublic(tool);
}

/** The hard privacy boundary: only the fields this specific tool declared
 * ever leave this server headed to that tool's endpoint, regardless of
 * what the app happened to include in the request. */
export function filterContextForTool(tool, context) {
  const filtered = {};
  for (const field of tool.dataAccessed) {
    if (Object.prototype.hasOwnProperty.call(context ?? {}, field)) {
      filtered[field] = context[field];
    }
  }
  return filtered;
}

export function routableTools() {
  return load().filter((t) => t.status === 'approved' && t.enabled);
}
