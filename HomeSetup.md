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

## Step 3 — Get your accounts and credentials

This app has two hard requirements. **Both are mandatory** — the app will show an API error in every panel without them.

### 3a. Von Neumann Game account + API key (required)

You must have an active account on **neumann-probe.net** with your own probe. This app talks directly to the game API using your personal API key — it cannot run without one.

1. Register or log in at https://neumann-probe.net
2. Find your API key in your account/profile settings
3. Copy it — you'll paste it into the `.env` file in Step 4

> **This key is personal to your probe.** It controls your probe and your game data. Do not share it.

### 3b. An OpenAI-compatible AI endpoint (required for natural language commands)

The command panel sends your text to an AI that translates it into game actions. Pick **one**:

| Option | BASE_URL | API_KEY |
|--------|----------|---------|
| **OpenAI** | `https://api.openai.com/v1` | Your key from platform.openai.com |
| **Groq** (free tier, fast) | `https://api.groq.com/openai/v1` | Your key from console.groq.com |
| **Local Ollama** | `http://localhost:11434/v1` | Any non-empty string (e.g. `ollama`) |

Groq is recommended for free usage — it has a generous daily limit and is very fast.

> **Ollama note:** If you choose Ollama, install it from https://ollama.com, pull a model (`ollama pull llama3.1`), and make sure it is running (`ollama serve`) before starting the api-server. You will also need to change the model name in Step 6.

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

## Step 5 — Clear the sector history

The repo contains the original author's sector visit history. Before your first run, replace it with an empty log so the globe and map start fresh for your probe:

```bash
echo '{"sectors":[]}' > artifacts/api-server/data/visited-sectors.json
```

If that file doesn't exist yet, you can skip this step — the server creates it automatically on first run.

---

## Step 6 — Add a local API proxy to Vite

On Replit, a built-in proxy routes `/api/*` from the frontend to the api-server. Locally you need to tell Vite to do the same. Open `artifacts/probe-commander/vite.config.ts` and add a `proxy` block inside the `server` section:

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

> **Important:** Do not commit this change if you want to keep the repo Replit-compatible. You can stash it (`git stash`) or keep it on a local branch.

---

## Step 7 — (Ollama only) Change the model name

If you are using a local Ollama model, open `artifacts/api-server/src/routes/vng/index.ts` and find this line:

```ts
model: "gpt-5.4",
```

Change it to the Ollama model you pulled, for example:

```ts
model: "llama3.1",
```

---

## Step 8 — Start both servers

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

## Step 9 — Open the app

Navigate to **http://localhost:5173** in your browser.

If everything is working, the PROBE tab will show your probe's name, sector, fuel, and hull integrity within a few seconds.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| `API ERROR` shown in every panel | Wrong or missing `VNG_API_KEY` | Confirm your key in `artifacts/api-server/.env` and that you have a neumann-probe.net account |
| `PORT environment variable is required` | Missing `.env` file | Create the `.env` files from Step 4 |
| AI commands return errors | Wrong base URL or model name | Double-check Steps 3b and 7 |
| Globe shows a blank canvas | Frontend can't reach `/api/*` | Confirm the Vite proxy in Step 6 is saved and the dev server was restarted |
| Panels say loading forever | API server not running | Start Terminal 1 first, check its output for errors |
| Ollama errors mentioning the model | Model not pulled | Run `ollama pull <model-name>` |
| Map shows someone else's probe path | Old sector history in the repo | Run the command in Step 5 to reset it |

---

## Quick reference — env variables

| Variable | Set in | Purpose |
|----------|--------|---------|
| `VNG_API_KEY` | `api-server/.env` | Authenticates with neumann-probe.net (**required**) |
| `AI_INTEGRATIONS_OPENAI_BASE_URL` | `api-server/.env` | Where the AI endpoint lives (**required**) |
| `AI_INTEGRATIONS_OPENAI_API_KEY` | `api-server/.env` | Key for the AI endpoint (**required**) |
| `PORT` | both `.env` files | Which port each server binds to |
| `BASE_PATH` | `probe-commander/.env` | URL base for the Vite build (keep as `/`) |
