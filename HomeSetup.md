# Home PC Setup Guide

Step-by-step instructions for cloning and running Probe Commander on your own machine.

---

## Prerequisites

| Tool | Minimum version | How to get it |
|------|----------------|---------------|
| **Node.js** | v20 | https://nodejs.org (LTS) |
| **pnpm** | v10 | `npm install -g pnpm` |
| **Git** | any | https://git-scm.com |

Verify before continuing:

```bash
node --version   # should print v20.x or higher
pnpm --version   # should print 10.x
```

---

## Step 1 — Clone the repo

```bash
git clone <your-repo-url>
cd <repo-folder>
```

---

## Step 2 — Install dependencies

```bash
pnpm install
```

This installs packages for every workspace in the monorepo at once.

---

## Step 3 — Gather your API credentials

You will need three things:

### 3a. VNG API key
Your personal API key for **neumann-probe.net**. Log in at the site and find it in your account settings or profile page.

### 3b. An OpenAI-compatible AI endpoint
The natural-language command feature calls an OpenAI-compatible API. Pick **one** of these options:

| Option | BASE_URL | API_KEY |
|--------|----------|---------|
| **OpenAI** (easiest) | `https://api.openai.com/v1` | Your OpenAI key from platform.openai.com |
| **Local Ollama** | `http://localhost:11434/v1` | Any non-empty string (e.g. `ollama`) |
| **Other compatible provider** | Provider's URL | Provider's key |

> **Ollama note:** If you choose Ollama, install it from https://ollama.com, pull a model (`ollama pull llama3.1`), and make sure it is running (`ollama serve`) before starting the api-server. You will also need to change the model name in step 6 below.

---

## Step 4 — Create environment files

### `artifacts/api-server/.env`

```
PORT=8080
VNG_API_KEY=<your neumann-probe.net API key>
AI_INTEGRATIONS_OPENAI_BASE_URL=<base URL from step 3b>
AI_INTEGRATIONS_OPENAI_API_KEY=<API key from step 3b>
```

### `artifacts/probe-commander/.env`

```
PORT=5173
BASE_PATH=/
```

> Port 5173 is the Vite default. You can use any free port.

---

## Step 5 — Add a local API proxy to Vite

On Replit, a built-in proxy routes `/api/*` from the frontend to the api-server. Locally you need to tell Vite to do the same thing. Open `artifacts/probe-commander/vite.config.ts` and add a `proxy` block inside the `server` section:

```ts
server: {
  port,
  strictPort: true,
  host: "0.0.0.0",
  allowedHosts: true,
  fs: {
    strict: true,
  },
  // Add this block for local development:
  proxy: {
    "/api": {
      target: "http://localhost:8080",
      changeOrigin: true,
    },
  },
},
```

This makes requests to `http://localhost:5173/api/...` forward to `http://localhost:8080/api/...`, exactly like the Replit proxy does in production.

> **Important:** Do not commit this change if you want to keep the repo Replit-compatible. You can instead create a local git stash or a separate git branch for home use.

---

## Step 6 — (Ollama only) Change the model name

If you are using a local Ollama model, open `artifacts/api-server/src/routes/vng/index.ts` and find line 226:

```ts
model: "gpt-5.4",
```

Change it to the Ollama model you pulled, for example:

```ts
model: "llama3.1",
```

---

## Step 7 — Start both servers

Open **two terminal windows** in the repo root.

**Terminal 1 — API server:**

```bash
pnpm --filter @workspace/api-server run dev
```

You should see: `Server listening  {"port":8080}`

**Terminal 2 — Frontend:**

```bash
pnpm --filter @workspace/probe-commander run dev
```

You should see: `VITE ready in ... ms  ➜  Local: http://localhost:5173/`

---

## Step 8 — Open the app

Navigate to **http://localhost:5173** in your browser.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| `PORT environment variable is required` | Missing `.env` file | Create the `.env` files in step 4 |
| `VNG_API_KEY not set` | Missing or wrong `.env` location | Confirm the file is at `artifacts/api-server/.env` |
| AI commands return errors | Wrong base URL or model name | Double-check steps 3b and 6 |
| Sector/telemetry panels show nothing | API server not running | Start terminal 1 first, check for errors |
| Globe shows a blank canvas | Frontend can't reach `/api/*` | Confirm the Vite proxy in step 5 is saved and the dev server restarted |
| Ollama errors mentioning the model | Model not pulled | Run `ollama pull <model-name>` |

---

## Quick reference — env variables

| Variable | Set in | Purpose |
|----------|--------|---------|
| `VNG_API_KEY` | `api-server/.env` | Authenticates with neumann-probe.net |
| `AI_INTEGRATIONS_OPENAI_BASE_URL` | `api-server/.env` | Where the AI endpoint lives |
| `AI_INTEGRATIONS_OPENAI_API_KEY` | `api-server/.env` | Key for the AI endpoint |
| `PORT` | both `.env` files | Which port each server binds to |
| `BASE_PATH` | `probe-commander/.env` | URL base for the Vite build (keep as `/`) |
