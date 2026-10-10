# TransitSync

RFID campus shuttle operations console — a React panel, a Node/Express API with
SQLite, role-based access control, and live Server-Sent Events.

```
SYP/
├── client/   React + Vite panel (REST + SSE)
├── server/   Node/Express API, SQLite (node:sqlite), RBAC, SSE hub
├── scripts/  launchers, IIS provisioning, server helpers
├── assets/   branding (icon etc.)
└── .github/  GitHub Pages deployment workflow
```

## Architecture

- **Panel (static frontend):** hosted on GitHub Pages at `https://transitsync.me`.
  The build sets `VITE_API_URL=https://api.transitsync.me`, so every REST call
  and the SSE stream go to the backend.
- **Backend (live):** runs on the TransitSync server machine in a visible
  console window (`start-transitsync-console.bat`). The API is served at
  `https://api.transitsync.me` (IIS reverse-proxying to the Node process on
  port 8080). Closing that console window takes the panel offline.
- **Database:** SQLite file at `server/data/transitsync.db` (never committed).

## Local development

```bash
cd client && npm install && npm run dev      # panel on :5173 (proxies /api)
cd server && npm install && npm start        # API on http://localhost:8080
```

Default build is same-origin (the server also serves `client/dist`), so
`VITE_API_URL` is only needed for the GitHub Pages build.

## Running the server (Windows)

Double-click **TransitSync Server** (desktop shortcut) or run:

```
start-transitsync-console.bat
```

A visible console window streams live logs. **Closing it stops the server and
takes the web panel offline.**

## Deploying the panel to GitHub Pages

On every push to `main`, `.github/workflows/pages.yml` builds the client with
`VITE_API_URL=https://api.transitsync.me` and deploys `client/dist` to Pages.

### DNS (Namecheap)

For the payload domain (`transitsync.me`):

| Type | Host | Value |
|------|------|-------|
| A    | @     | 185.199.108.153 |
| A    | @     | 185.199.109.153 |
| A    | @     | 185.199.110.153 |
| A    | @     | 185.199.111.153 |
| TXT  | `_github-pages-challenge-<username>` | token shown in Settings → Pages |
| A    | api  | <public IP of the TransitSync server> |

`@` A-records point the panel at GitHub Pages; the `api` A-record and any TXT
token come from the GitHub Pages custom-domain and DNS-verification steps.

## Sensitive files

`.gitignore` excludes `server/.env`, `node_modules/`, `dist/`, `data/` and
`*.db*`. Never commit the `.env` — it holds `JWT_SECRET`, the bootstrap admin
password and `RELAY_TOKEN`.