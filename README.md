# MrKrishna WhatsApp API

Personal notification API built with Node.js, Express, Baileys, and a TOTP-only admin panel. Includes a tiny HTML `/health` page and built-in endpoint documentation.

> **Important:** Baileys is an unofficial WhatsApp Web client, not a WhatsApp-approved business API. WhatsApp may restrict accounts using unofficial automation. Use only for low-volume, consent-based notifications. For production-critical business messaging, prefer the official WhatsApp Business Platform.

## Features

- `GET /health`: minimal HTML response, no database or WhatsApp check, `Cache-Control: no-store`.
- `POST /api/notify`: no API key; always targets `OWNER_NUMBER`; limit 10 requests per IP per minute.
- `POST /api/send`: requires `X-API-Key`; optional `to` falls back to `OWNER_NUMBER`; invalid provided number returns HTTP 400.
- TOTP-only admin login; no password; HttpOnly, SameSite=Strict session cookie and server-side session revocation.
- Pairing code flow (no QR), admin Retry, max three pairing-code requests per process.
- Reuses the socket across requests and disconnects after 60 seconds of send inactivity.
- API docs, Try API, recent in-memory logs, session export and format check in the admin UI.
- Fixed message header `MrKrishna NG` and footer `Powered by @mrkrishna.in`.

## Local setup

Requires Node.js 20+.

```bash
cp .env.example .env
npm install
npm run setup:totp
```

Copy the generated Base32 secret into `ADMIN_TOTP_SECRET` in `.env`. Add your own values for `OWNER_NUMBER`, `WHATSAPP_NUMBER`, and a long random `API_KEY`.

```bash
npm start
```

Open `http://localhost:3000/` for the admin panel and `http://localhost:3000/health` for the HTML health page.

## Render deployment

1. Push this folder to a new GitHub repository.
2. Create a Render Web Service from that repository (or use `render.yaml`).
3. Set these environment variables in Render:
   - `OWNER_NUMBER`: primary destination, digits with country code.
   - `WHATSAPP_NUMBER`: secondary WhatsApp number to pair, digits with country code.
   - `API_KEY`: long random API key used by `/api/send`.
   - `ADMIN_TOTP_SECRET`: Base32 secret from `npm run setup:totp`.
   - `WHATSAPP_SESSION`: leave blank for first pairing; after pairing, paste the session export from admin here.
4. Deploy. Open `/` and sign in with the six-digit authenticator code.
5. Go to **Pairing & session** → **Request pairing code**. On the WhatsApp account you want to link, open Linked Devices → Link a device → Link with phone number instead, then enter the code.
6. Once paired, export the session from the admin panel and copy it into Render's `WHATSAPP_SESSION`, then redeploy.
7. Open `/health` to check only whether the HTTP service responds.

### Session persistence caveat

The complete Baileys auth store (credentials and Signal-key files) changes over time. The export bundles every auth-store file so it can be restored consistently. A running Node process cannot permanently edit Render environment variables unless the Render API is separately configured. This project keeps the latest auth snapshot in memory and provides an authenticated export action; paste the latest export into `WHATSAPP_SESSION` in Render when you need to persist it across a restart. If you don't export newer keys, an older environment snapshot may stop reconnecting. Session JSON is a credential: never share it, email it, send it in WhatsApp, add it to Git, or expose it in logs.

## API examples

### `POST /api/notify`

```bash
curl -X POST https://YOUR-SERVICE.onrender.com/api/notify \
  -H 'Content-Type: application/json' \
  -d '{"title":"Payment Successful","subject":"Order #1024","message":"Payment received."}'
```

### `POST /api/send`

```bash
curl -X POST https://YOUR-SERVICE.onrender.com/api/send \
  -H 'Content-Type: application/json' \
  -H 'X-API-Key: YOUR_API_KEY' \
  -d '{"to":"91XXXXXXXXXX","title":"Tournament Update","subject":"Crown Arena","message":"Your match starts soon."}'
```

### JavaScript `fetch`

```js
await fetch('https://YOUR-SERVICE.onrender.com/api/send', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-API-Key': process.env.MRKRISHNA_API_KEY
  },
  body: JSON.stringify({
    to: '91XXXXXXXXXX',
    title: 'Payment Successful',
    subject: 'Order #1024',
    message: 'Payment received.'
  })
});
```

## Message format

```text
MrKrishna NG
Payment Successful
Subject: Order #1024

Payment received.

Powered by @mrkrishna.in
```

`title` and `message` are required. `subject` is optional. Maximum lengths: title 120, subject 180, message 3500 characters.

## Admin routes

- `POST /api/admin/login` — TOTP login, body `{ "code": "123456" }`.
- `POST /api/admin/logout` — revoke session.
- `GET /api/admin/state` — status and sanitized recent logs.
- `POST /api/admin/pairing/retry` — request pairing code.
- `GET /api/admin/session/export` — sensitive session export.
- `POST /api/admin/session/import-check` — checks JSON structure only, not live session validity.
- `POST /api/admin/test-send` — admin-only test send.

## Known limits / deployment notes

- Render Free can sleep; the first request may wait for cold start. `/health` is lightweight but cannot wake a sleeping instance instantly without waiting for Render.
- `/health` checks HTTP responsiveness only, not WhatsApp connectivity.
- Admin sessions are held in process memory and are cleared on server restart. Browser session cookies normally disappear when the browser is fully closed, but browser session-restore features can preserve them.
- The recent event log is in memory and resets on restart.
- `/api/notify` has no API key by design; the rate limit is not authentication. Since it can only notify the owner number, keep the payload short and do not use it as a public broadcast endpoint.
- The session export can be large. If Render environment-variable size limits are reached, env-only storage may be impractical; use a proper encrypted persistent secret store instead.
- Pairing code is printed in Render logs as requested. Treat access to those logs as sensitive while the code is valid.
- Baileys v7 is a release candidate with breaking changes from v6. Pinning the dependency helps reproducibility; test pairing on a non-critical secondary account before relying on it.

## Verification

```bash
npm run check
```

This checks JavaScript syntax. It does not prove WhatsApp pairing or delivery; those require deployment and a real test send.


## Pairing implementation

This version uses the stable Baileys 6.7.21 pairing flow inspired by the supplied Knight Bot project: fetch the current Baileys version, use a cached Signal key store, validate the international phone number, wait briefly before requesting the phone-number pairing code, and preserve the complete auth store for export. The old project’s QR generator, Mega upload code, automatic session-file WhatsApp messages, and session-directory deletion were intentionally excluded.
