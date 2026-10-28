# Render deployment checklist

1. Create a private GitHub repository and upload this project. Never commit `.env` or session exports.
2. In Render, create a Node Web Service or use the included `render.yaml`.
3. Set `OWNER_NUMBER`, `WHATSAPP_NUMBER`, `API_KEY`, and `ADMIN_TOTP_SECRET` as secret environment variables. Leave `WHATSAPP_SESSION` empty for the first pairing.
4. Deploy and open `/`. Generate a TOTP secret locally using `npm run setup:totp` and configure an authenticator app using the secret.
5. Log in, open Pairing & session, and request a pairing code. Enter it on the secondary phone under Linked Devices → Link with phone number.
6. After connection, export the session snapshot and paste it into Render's `WHATSAPP_SESSION`, then redeploy.
7. Check `/health` for the HTML HTTP-service status page.

Important: Baileys auth state changes. Re-export after successful connection/key updates if you need a recent env snapshot for restart recovery. This is manual env-only persistence; it is not an automatic update to Render's env variables. The session export is a credential.
