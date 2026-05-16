# OpenClaw Worker (CapRover + GitHub Actions)

This worker polls backend task APIs and completes queued AI tasks.

## 1) Runtime Modes

`WORKER_EXECUTION_MODE` controls execution:

- `hybrid` (recommended): try OpenClaw CLI first, fallback to OpenAI API
- `cli`: only use `openclaw` command
- `api`: only use OpenAI Responses API

## 2) Required Environment Variables

Copy `.env.example` to `.env` for local runs or set these in CapRover app env:

- `SERVER_URL=https://<your-backend-domain>`
- `WORKER_SECRET=<same as backend OPENCLAW_WORKER_SECRET>`
- `POLL_INTERVAL_MS=30000`
- `WORKER_EXECUTION_MODE=hybrid`
- `OPENAI_API_KEY=<required for api mode and hybrid fallback>`
- `OPENAI_MODEL=gpt-5.4-mini`

Optional:

- `OPENCLAW_COMMAND=openclaw`
- `OPENCLAW_TIMEOUT_MS=180000`
- `OPENAI_TIMEOUT_MS=180000`
- `HEARTBEAT_FILE=/tmp/openclaw-worker-heartbeat`
- `HEALTHCHECK_MAX_HEARTBEAT_AGE_MS=120000`

## 3) Local Run

```bash
cd openclaw-worker
npm install
npm start
```

## 4) Container Build (Manual)

```bash
docker build -t openclaw-worker:local .
docker run --env-file .env openclaw-worker:local
```

## 5) CapRover Setup

1. Create a dedicated CapRover app, e.g. `openclaw-worker`.
2. Set app as non-web app (no public HTTP routing needed).
3. Add env vars listed above.
4. Ensure backend has matching `OPENCLAW_WORKER_SECRET`.

## 6) GitHub Actions Auto Deploy

Workflow: `.github/workflows/openclaw-worker-deploy.yml`

Trigger:

- Push to `main` where changed files include `openclaw-worker/**`

Pipeline behavior:

1. Build multi-arch image (`linux/amd64`, `linux/arm64`)
2. Push to GHCR:
   - `ghcr.io/<owner>/openclaw-worker:sha-<shortsha>`
   - `ghcr.io/<owner>/openclaw-worker:latest`
3. Deploy new SHA image to CapRover app

Required GitHub secrets:

- `CAPROVER_SERVER` (example: `https://captain.example.com`)
- `CAPROVER_APP_NAME` (example: `openclaw-worker`)
- `CAPROVER_APP_TOKEN` (app token from CapRover)
- `GHCR_PAT` (optional; if omitted, workflow uses `GITHUB_TOKEN`)

## 7) Validation Scenarios

1. Create a task from dashboard and verify state: `pending -> processing -> completed`.
2. Set `WORKER_EXECUTION_MODE=api` and confirm tasks complete through OpenAI API.
3. In `hybrid` mode, simulate CLI failure and verify API fallback completes task.
4. Confirm `structured_outputs` are still stored when worker output includes valid JSON block.
# openclaw-workers
