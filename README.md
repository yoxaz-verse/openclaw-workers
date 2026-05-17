# OpenClaw Worker (CapRover + GitHub Actions)

This worker polls backend task APIs and completes queued AI tasks.

## 1) Runtime Mode

This worker is **CLI-only** and executes tasks through local OpenClaw.

- `WORKER_EXECUTION_MODE=cli` (required)
- Any other mode is rejected at startup.

## 2) Required Environment Variables

Copy `.env.example` to `.env` for local runs or set these in CapRover app env:

- `SERVER_URL=https://<your-backend-domain>`
- `WORKER_SECRET=<same as backend OPENCLAW_WORKER_SECRET>`
- `POLL_INTERVAL_MS=30000`
- `WORKER_EXECUTION_MODE=cli`
- `OPENCLAW_AGENT=<OpenClaw agent name/id>` (preferred fixed target)
- `OPENCLAW_SESSION_ID=<existing OpenClaw session id>` (fallback if agent is not used)
- `OPENAI_MODEL=gpt-5.4-mini`

Optional:

- `OPENCLAW_COMMAND=openclaw`
- `OPENCLAW_TIMEOUT_MS=180000`
- `OPENAI_API_KEY=<optional; ignored in cli mode>`
- `OPENAI_MODEL=gpt-5.4-mini`
- `OPENAI_TIMEOUT_MS=180000`
- `HEARTBEAT_FILE=/tmp/openclaw-worker-heartbeat`
- `HEALTHCHECK_MAX_HEARTBEAT_AGE_MS=120000`

Notes:

- In cli mode, set one fixed target: `OPENCLAW_AGENT` (preferred) or `OPENCLAW_SESSION_ID`.
- The worker marks task execution errors as `failed` in backend task status; it does not use OpenAI fallback.
- If OpenClaw returns auth-invalid text (for example token invalidated/sign-in required), worker classifies the task as `failed` instead of `completed`.

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
2. Start with a valid target and confirm startup logs include `openclawTargetConfigured: true`.
3. Force CLI failure (invalid target) and verify task status becomes `failed` with readable error.
4. Confirm `structured_outputs` are still stored when worker output includes valid JSON block.

## 8) Troubleshooting

- Missing target at startup
  - Error: `OpenClaw target is required...`
  - Fix: set `OPENCLAW_AGENT`, or `OPENCLAW_SESSION_ID` if you intentionally route by session.

- `openclaw` command not found
  - Typical error includes `spawn openclaw ENOENT`.
  - Fix: install OpenClaw CLI in runtime image/host, or set `OPENCLAW_COMMAND` to the correct executable path.

- Invalid agent/session
  - Task gets marked `failed` with the CLI error message in result.
  - Fix: verify the configured `OPENCLAW_AGENT`/`OPENCLAW_SESSION_ID` exists and is reachable from worker runtime.

- OpenClaw auth token invalidated
  - Task may fail with message: `Authentication token is invalid or expired for OpenClaw target...`
  - Fix: re-authenticate OpenClaw channel/session for the configured target and retry the task.
# openclaw-workers
