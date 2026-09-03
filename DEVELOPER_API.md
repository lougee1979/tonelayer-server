# Building a tool for ToneLayer

ToneLayer's AI orchestrator can hand off to tools built and hosted by other
developers. **Your tool runs entirely on your own server.** No code of
yours ever runs inside the ToneLayer app or on ToneLayer's server — the
orchestrator just sends your endpoint a small, filtered slice of context
and shows the user what you send back. This is deliberate: it's the
model that keeps ToneLayer's core privacy promise intact, and it's the
model most likely to survive App Store review, since the app never
downloads or executes third-party code.

## What your server must implement

Two endpoints, both plain JSON over HTTPS:

### `POST /can-handle`

Called first, with a short (3 second) timeout, to ask whether your tool
is relevant to the user's current context.

Request body:
```json
{ "context": { "clipboardText": "..." } }
```

The `context` object contains **only** the fields you declared wanting at
registration (see below) — never more, even if the app itself has other
context available. If you didn't ask for `clipboardText`, you will never
receive it here, full stop.

Response body:
```json
{ "canHandle": true, "confidence": 0.9, "summary": "Optional one-line description" }
```

`canHandle: false` (or a non-2xx response, or a timeout) simply excludes
you from that round's results — no error is surfaced to the user for one
tool declining or failing.

### `POST /handle`

Called only if the user actually selects your tool, with a longer
(15 second) timeout. Same request shape as `/can-handle`. Response body
is whatever JSON your tool wants to return — it's relayed to the app
as-is, so document your own response shape for your own tool's UI.

## Registering your tool

```
POST https://tonelayer-server-production.up.railway.app/developer/tools/register
Content-Type: application/json

{
  "name": "Checklist Maker",
  "description": "Turns clipboard text into a checklist",
  "developerEmail": "you@example.com",
  "endpointBaseURL": "https://your-server.example.com/tonelayer-tool",
  "dataAccessed": ["clipboardText"],
  "dataRetention": "Not stored; processed in-memory only and discarded after the response is sent."
}
```

`endpointBaseURL` must be `https://` (an `http://localhost` URL is
accepted for local testing only — it will be rejected once you're ready
to register for real).

`dataAccessed` must be a subset of the fields ToneLayer's orchestrator
can ever provide:

| Field | What it is |
| --- | --- |
| `foregroundApp` | Name of the app the user was in when they invoked the orchestrator |
| `clipboardText` | Whatever's on the user's clipboard — the most sensitive field; expect closer review if you request it |
| `ndProfile` | The user's declared handling preferences (e.g. "ADHD + Autism") — a preference, not a diagnosis; treat it that way in your own copy too |
| `tier` | The user's ToneLayer membership tier |
| `detectedState` | ToneLayer's best guess at the user's current state (`inFlow`, `spiraling`, `celebrating`, `neutral`) |

Requesting a field outside this list is rejected at registration, not
silently dropped later — you'll get a clear 400 telling you which field
isn't recognized.

`dataRetention` is a plain-language statement of what you store and for
how long. Be accurate — this may be shown to users deciding whether to
grant your tool access.

**Response:**

```json
{
  "tool": { "id": "...", "status": "pending", ... },
  "apiKey": "a263dab5...",
  "notice": "Save this API key now — it will not be shown again."
}
```

Save the `apiKey` immediately. It's shown exactly once and cannot be
retrieved again — only rotated (see below).

## Review

New tools start in `status: "pending"` and are **not routed to any user**
until approved. Requesting a high-sensitivity field (`clipboardText` or
`ndProfile`) flags your tool for closer review — this isn't a rejection,
just a signal that a human looks at it before it goes live. There's no
self-serve approval; ping the ToneLayer team after registering.

## Managing your tool

All of these require your API key in an `x-tool-api-key` header.

- `GET /developer/tools/me` — check your tool's current status.
- `PATCH /developer/tools/me` with `{ "enabled": false }` — pause your
  tool without losing your registration (no re-review needed). Changing
  your endpoint URL or requested data isn't supported via this route yet
  — register a new tool for that, since it needs review either way.
- `POST /developer/tools/me/rotate-key` — get a new API key if yours
  leaks. The old one stops working immediately.

## What ToneLayer will never do

- Send you a field you didn't request, regardless of what the app has
  available — this is enforced on ToneLayer's server, not left to your
  tool to ignore.
- Send your tool the user's actual message text, contact names, or
  anything else beyond the five fields above — there is no "everything"
  context object.
- Route to your tool if it's unapproved, disabled, or if `/can-handle`
  fails or times out.

## What's not built yet

- No in-app UI for browsing/discovering tools, or for users to grant/
  revoke a specific tool's access to a specific field — that consent
  surface is the next piece, not shipped with this API.
- No self-serve re-review flow for changing an endpoint or requested
  fields after initial registration.
- No rate limiting or usage dashboards yet.
- `/can-handle` results are ranked by each tool's own reported
  `confidence` only — there's no cross-tool re-ranking pass yet.
