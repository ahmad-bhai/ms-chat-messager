# MS Chat (Vercel version)

Telegram-style installable chat app (PWA).
- Frontend: `index.html`, `style.css`, `app.js`, `sw.js`, `manifest.json`, icons (all in repo root)
- Backend: `api/index.js` (one Vercel serverless function)
- Database: Upstash Redis (free)

## Deploy
1. Upload ALL files to a GitHub repo. The `api` folder must stay as `api/index.js`.
2. Vercel -> Add New Project -> import the repo. Framework: "Other". No build command.
3. In the Vercel project: Storage -> Create/Connect **Upstash Redis** (free plan). This adds the
   `KV_REST_API_URL` / `KV_REST_API_TOKEN` (or `UPSTASH_REDIS_REST_*`) environment variables.
4. Redeploy (Deployments -> Redeploy). Open `https://YOUR-PROJECT.vercel.app/api/health`
   - it must show `{"ok":true,"db":true}`.
5. Open the site in Chrome on Android -> menu -> Install app.

Optional: set `AUTH_SECRET` (any long random text) in Environment Variables.
