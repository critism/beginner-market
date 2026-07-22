# discord community hub — cloudflare edition

Now with a **real shared database**. The frontend (GitHub Pages) talks to a
**Cloudflare Worker** backed by a **D1 database** (SQLite). Everyone sees the same
tickets and applications across all devices, and the Discord webhook is hidden
server-side.

New in this version:
- 🗄️ **Real database** (Cloudflare D1) — no more per-browser localStorage
- 👑 **High Staff** role that can **review** (accept / deny) applications
- 📋 **Applications section** where members apply for open positions

```
folder structure
├── site/                 → goes to GitHub Pages (the website)
│   ├── index.html
│   └── .github/workflows/deploy.yml
└── worker/               → goes to Cloudflare (the backend + database)
    ├── worker.js
    ├── schema.sql
    └── wrangler.toml
```

---

## Roles

| Role | Set via | Can do |
|---|---|---|
| **member** | anyone logged in | open tickets, apply for staff |
| **staff** | `STAFF_IDS` | everything above + view & answer **all** tickets |
| **high staff** | `HIGH_STAFF_IDS` | everything above + **review applications** (accept/deny) |

A high-staff id automatically counts as staff too — you don't need to add it to both.

---

## Part A — the backend (Cloudflare Worker + D1)

You'll need a free Cloudflare account and Node.js installed.

### 1. Install wrangler and log in
```bash
npm install -g wrangler
wrangler login
```

### 2. Create the D1 database
```bash
cd worker
wrangler d1 create hub-db
```
This prints a `database_id`. Open `wrangler.toml` and paste it into
`database_id = "…"`.

### 3. Create the tables
```bash
wrangler d1 execute hub-db --file=./schema.sql            # local
wrangler d1 execute hub-db --remote --file=./schema.sql   # live database
```

### 4. Fill in `wrangler.toml`
- `ALLOWED_ORIGIN` → your GitHub Pages origin **without trailing slash**,
  e.g. `https://yourname.github.io` (this is the CORS allow-list).
- `STAFF_IDS` → comma-separated Discord user IDs (staff).
- `HIGH_STAFF_IDS` → comma-separated Discord user IDs (application reviewers).

Get IDs with Developer Mode on (Discord → Settings → Advanced), then
right-click a user → **Copy User ID**.

### 5. Add the webhook as a secret (stays hidden!)
```bash
wrangler secret put TICKET_WEBHOOK
```
Paste your Discord webhook URL when prompted. Unlike the old version, this URL
is **never** sent to the browser — the Worker calls it server-side.

### 6. Deploy the worker
```bash
wrangler deploy
```
Wrangler prints your worker URL, e.g.
`https://discord-hub-api.yourname.workers.dev`. Copy it — the frontend needs it.

---

## Part B — the frontend (GitHub Pages)

### 7. Fill in CONFIG at the top of `site/index.html`
```js
const CONFIG = {
  serverName: "my discord",
  clientId:   "…",                        // discord app client id
  redirectUri:"https://yourname.github.io/yourrepo/",  // must match discord + pages exactly
  guildId:    "…",                        // your server id (for the widget/status)
  invite:     "https://discord.gg/…",     // your invite link
  apiBase:    "https://discord-hub-api.yourname.workers.dev"  // ← your worker url (no trailing slash)
};
```

### 8. Discord application (login)
Same as before: https://discord.com/developers/applications → your app →
**OAuth2** → copy the **Client ID**, and under **Redirects** add your exact
GitHub Pages URL. (Scope used is just `identify`.)

### 9. Enable the server widget (for the status page)
Discord → Server Settings → **Widget** → enable it. Copy the server id into
`CONFIG.guildId`.

### 10. Deploy to GitHub Pages
Upload the **contents of the `site/` folder** to your repo (so `index.html`
sits at the repo root), then Settings → Pages → Source: **GitHub Actions**.
Push, and the site goes live.

> The `.github/workflows/deploy.yml` here just publishes the site — there are no
> secrets to inject anymore, because the sensitive parts moved to the Worker.

---

## How the pieces talk

```
browser  ──(discord token)──►  cloudflare worker  ──►  D1 database
   │                                  │
   │                                  └──►  discord webhook (hidden)
   └──(widget.json, public)──►  discord api (online count)
```

- On login, the browser gets a Discord token and sends it to the Worker.
- The Worker verifies the token with Discord, checks the id against
  `STAFF_IDS` / `HIGH_STAFF_IDS`, and returns the user's **role**.
- Every ticket/application action is authorized **on the Worker**, so a user
  can't fake staff access by editing the page — the role is decided server-side.

## Troubleshooting

| Problem | Fix |
|---|---|
| "could not load tickets (401)" | Token expired — log out and back in. |
| CORS error in console | `ALLOWED_ORIGIN` in `wrangler.toml` must match your Pages origin exactly (no trailing slash), then `wrangler deploy` again. |
| Staff/review tab missing | Your id isn't in `STAFF_IDS` / `HIGH_STAFF_IDS`, or you edited the toml but didn't redeploy the worker. |
| Status shows "widget unavailable" | Enable the server widget + check `guildId`. |
| Webhook messages missing | Re-run `wrangler secret put TICKET_WEBHOOK`; check the URL is valid. |

## Free tier notes

Cloudflare's free plan covers a hobby community easily: Workers give 100,000
requests/day and D1 gives 5 GB storage + millions of row reads/day. No credit
card required.

## Later ideas

- **Verify server membership** on login (add the `guilds` scope, check the guild list in the Worker).
- **Email/DM on application decision** via a Discord bot.
- **Rate limiting** on ticket creation (Cloudflare has a built-in rate-limiting binding).
