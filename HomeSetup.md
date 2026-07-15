# Home PC Setup Guide (Windows)

Step-by-step instructions for running Probe Commander on your Windows PC. No coding experience required — just follow each step in order.

---

## Before you start — install the tools

You need three free programs installed before anything else. If you already have them, skip ahead.

| Program | Minimum version | Download |
|---------|----------------|----------|
| **Node.js** | v20 | https://nodejs.org — click the **LTS** button |
| **pnpm** | v10 | Installed via terminal after Node.js (see below) |
| **Git** | any | https://git-scm.com |

**How to open a terminal (Command Prompt):**
Press `Win + R`, type `cmd`, press Enter — or search for "Command Prompt" in the Start menu. All commands in this guide are typed here.

**After installing Node.js,** open Command Prompt and run:

```
npm install -g pnpm
```

Then confirm everything is ready:

```
node --version
pnpm --version
```

You should see `v20.x` or higher for Node, and `10.x` for pnpm. If you do, you're good to go.

---

## Step 1 — Download the code

In Command Prompt, run:

```
git clone <your-repo-url>
cd <repo-folder>
```

Replace `<your-repo-url>` with the actual URL of the repository, and `<repo-folder>` with the name of the folder it creates (Git will print the name after cloning).

---

## Step 2 — Install dependencies

From inside the repo folder, run:

```
pnpm install
```

This downloads all the code libraries the app needs. It may take a minute or two. When it finishes, you're ready to move on.

---

## Step 3 — Get your accounts and credentials

The app needs two things to work. **Both are required** — without them, every panel will show an error.

### 3a. Von Neumann Game account + API key

You need an account on **neumann-probe.net** with your own probe. The app talks directly to the game using your personal API key.

1. Register or log in at https://neumann-probe.net
2. Find your API key in your account or profile settings
3. Copy it — you'll paste it into a file in Step 4

> **Keep this key private.** It controls your probe and your game data.

### 3b. An AI service (for natural language commands)

When you type a command like "have Socrates mine carbon into the container", the app sends it to an AI that figures out what to do. You need to pick one AI service:

| Service | Cost | Sign up |
|---------|------|---------|
| **OpenAI** | Paid (pay-as-you-go) | https://platform.openai.com |
| **Groq** | Free tier, fast | https://console.groq.com |
| **Ollama** | Free, runs on your PC | https://ollama.com |

**Groq is recommended** if you want something free and quick to set up.

Once signed up, you'll need two things from your chosen service: a **Base URL** and an **API key**. Use these values:

| Service | Base URL | API key |
|---------|----------|---------|
| OpenAI | `https://api.openai.com/v1` | From platform.openai.com → API keys |
| Groq | `https://api.groq.com/openai/v1` | From console.groq.com → API keys |
| Ollama | `http://localhost:11434/v1` | Type any word (e.g. `ollama`) |

> **Ollama extra step:** After installing from https://ollama.com, open a new Command Prompt and run `ollama pull llama3.1` to download the AI model, then `ollama serve` to start it. Keep that window open.

---

## Step 4 — Create the configuration files

The app reads settings from two plain text files called `.env`. You'll create each one in a specific folder.

> **What is a `.env` file?** It's a plain text file named exactly `.env` (dot at the start, no other extension). Open Notepad, type the contents, then choose **File → Save As**, navigate to the correct folder, set **Save as type** to **All Files**, and type `.env` as the filename.

### File 1: `artifacts\api-server\.env`

Navigate to the `artifacts\api-server\` folder inside the repo and create a file named `.env` containing:

```
PORT=8080
VNG_API_KEY=paste-your-neumann-probe-api-key-here
AI_INTEGRATIONS_OPENAI_BASE_URL=paste-the-base-url-from-step-3b-here
AI_INTEGRATIONS_OPENAI_API_KEY=paste-the-api-key-from-step-3b-here
```

Replace each placeholder with your actual values from Step 3.

### File 2: `artifacts\probe-commander\.env`

Navigate to the `artifacts\probe-commander\` folder and create a file named `.env` containing:

```
PORT=5173
```

You don't need to change anything here — copy it exactly as shown.

---

## Step 5 — Clear the sector history (first-time setup only)

The repo includes the original author's explored-sector data. Run this command once to reset it so the map starts fresh for your probe.

**In PowerShell** (search "PowerShell" in the Start menu, open it, navigate to the repo folder with `cd <path-to-repo>`):

```
Set-Content artifacts\api-server\data\visited-sectors.json '{"sectors":[]}'
```

**Or in Command Prompt:**

```
echo {"sectors":[]}> artifacts\api-server\data\visited-sectors.json
```

> If you get an error saying the file or folder doesn't exist, skip this step — the app will create the file on its own when it first starts.

---

## Step 6 — Add a local network connection between the two parts of the app

The app has two parts: a **backend** (the API server) and a **frontend** (the web interface). On Replit these are wired together automatically; locally you need to do it yourself by editing one file.

Open `artifacts\probe-commander\vite.config.ts` in a text editor (right-click → Open with → Notepad, or use VS Code if you have it) and find this section near the bottom:

```ts
  server: {
    port,
    strictPort: true,
    host: "0.0.0.0",
    allowedHosts: true,
```

Add the following four lines **inside** that `server: {` block, just after the line that says `allowedHosts: true,`:

```ts
    proxy: {
      "/api": {
        target: "http://localhost:8080",
        changeOrigin: true,
      },
    },
```

Save the file. This tells the frontend to forward any `/api/...` requests to the backend running on port 8080.

> **Don't commit this change** if you want to keep the repo working on Replit. You can undo it before pushing (`git stash`) or keep it on a local-only branch.

---

## Step 7 — (Ollama only) Switch the AI model name

If you chose Ollama in Step 3b, open `artifacts\api-server\src\routes\vng\index.ts` in a text editor and find this line:

```ts
model: "gpt-5.4",
```

Change it to the model you pulled, for example:

```ts
model: "llama3.1",
```

Skip this step entirely if you're using OpenAI or Groq.

---

## Step 8 — Start the app

You need **two Command Prompt windows** open at the same time. In each one, navigate to the repo folder first:

```
cd C:\Users\YourName\Documents\GitHub\<repo-folder>
```

**Window 1 — start the backend:**

```
pnpm --filter @workspace/api-server run dev
```

Wait until you see a line like:
```
Server listening  {"port":8080}
```

**Window 2 — start the frontend:**

```
pnpm --filter @workspace/probe-commander run dev
```

Wait until you see:
```
VITE ready in ... ms  ➜  Local: http://localhost:5173/
```

---

## Step 9 — Open the app

Go to **http://localhost:5173** in your browser (Chrome, Edge, Firefox — any will work).

If everything is working, the PROBE tab will show your probe's name, sector, fuel, and hull integrity within a few seconds.

---

## Alternative — Desktop app (no browser, no terminal after setup)

The repo includes an Electron wrapper (`artifacts\electron-app\`) that packages everything into a double-clickable `.exe`. On first launch it shows a setup screen where you enter your credentials — no `.env` files or Command Prompt required after that.

### Build it

> You need the web app built first (Steps 1–7 above), then run these three commands once from the repo folder:

**1. Build the backend:**
```
pnpm --filter @workspace/api-server run build
```

**2. Build the frontend:**
```
pnpm --filter @workspace/probe-commander run build
```

**3. Package the desktop app:**
```
pnpm --filter @workspace/electron-app run dist:win
```

The installer (`.exe`) is created inside `artifacts\electron-app\release\`. Double-click it to install, then launch Probe Commander from the Start menu or desktop shortcut.

> **If you see a "Cannot create symbolic link" error:** Windows blocks symlink creation for standard user accounts. Enable **Developer Mode** to fix it permanently: go to **Start → Settings → System → For Developers** and turn on **Developer Mode**, then re-run the command. Alternatively, right-click Command Prompt and choose **Run as administrator**.

### What happens on first launch

A setup screen appears asking for:
- Your **neumann-probe.net API key**
- Your **AI provider** (OpenAI, Groq, or Ollama) and its key

These are saved privately on your computer. The app remembers them from then on. You can re-open the setup screen anytime via the **Probe Commander → Credentials & Settings…** menu.

> **Note:** The desktop app and the browser method are equivalent — use whichever suits you. The `.env` file approach (Steps 1–9 above) is simpler for development; the desktop `.exe` is better for everyday use or sharing with others.

---

## Troubleshooting

| What you see | Most likely cause | What to do |
|---|---|---|
| `API ERROR` in every panel | Wrong or missing `VNG_API_KEY` | Double-check the key in `artifacts\api-server\.env` and that you have a neumann-probe.net account |
| `PORT environment variable is required` | Missing `.env` file | Create the `.env` files from Step 4 |
| AI commands return errors | Wrong Base URL or API key | Re-check Step 3b; for Ollama also check Step 7 |
| Panels load forever | Backend not running | Make sure Window 1 started without errors; look for red text |
| Map/globe shows no data | Frontend can't reach the backend | Confirm the proxy block from Step 6 is saved and restart Window 2 |
| Ollama errors about the model | Model not downloaded | Run `ollama pull llama3.1` in a new Command Prompt |
| Map shows someone else's route | Old sector history in the repo | Run the command from Step 5 |
| `'pnpm' is not recognized` | pnpm not installed | Re-run `npm install -g pnpm` and open a fresh Command Prompt |

---

## Quick reference — what each setting does

| Setting | File | What it's for |
|---------|------|---------------|
| `VNG_API_KEY` | `api-server\.env` | Connects to neumann-probe.net (**required**) |
| `AI_INTEGRATIONS_OPENAI_BASE_URL` | `api-server\.env` | Where to send AI commands (**required**) |
| `AI_INTEGRATIONS_OPENAI_API_KEY` | `api-server\.env` | Authenticates with your AI service (**required**) |
| `PORT` | both `.env` files | Which port each server runs on |
| `BASE_PATH` | auto-detected | Defaults to `/`; set by Replit automatically when hosted there |
