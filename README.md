# ToneLayer API Server

Handles all Claude API calls for ToneLayer and Clarity apps.
Users never need their own API key — the server handles everything.

## Deploy to Railway (recommended, free to start)

1. Go to railway.app and create an account
2. Click "New Project" → "Deploy from GitHub repo"
3. Connect this repo
4. Add environment variables:
   - `CLAUDE_API_KEY` = your Anthropic key
   - `APP_TOKEN` = a long random secret (use a password generator)
5. Railway gives you a URL like `https://tonelayer-api-production.up.railway.app`
6. Paste that URL into the iOS and Android app constants

## Deploy to Render (also free to start)

1. Go to render.com → New → Web Service
2. Connect this repo
3. Build command: `npm install`
4. Start command: `npm start`
5. Add same environment variables

## Test locally

```bash
cp .env.example .env
# Edit .env with your real keys
npm install
npm start
```

Test it:
```bash
curl http://localhost:3000/health
```

## Endpoints

### POST /rewrite
Handles ToneLayer (ND→NT) and Clarity (NT→ND) rewrites.

Headers: `x-app-token: your-app-token`

Body:
```json
{
  "text": "message to rewrite",
  "profile": "ADHD",
  "level": "Medium",
  "mode": "tonelayer",
  "style": "Rewrite"
}
```

### POST /narc
Narcissist Screen analysis.

Headers: `x-app-token: your-app-token`

Body:
```json
{
  "text": "message to analyze"
}
```
# tonelayer-server
