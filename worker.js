import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';

const execFileAsync = promisify(execFile);
loadDotEnv();

const SERVER_URL = must('SERVER_URL').replace(/\/$/, '');
const WORKER_SECRET = must('WORKER_SECRET');
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 30000);
const OPENCLAW_COMMAND = process.env.OPENCLAW_COMMAND || 'openclaw';
const OPENCLAW_TIMEOUT_MS = Number(process.env.OPENCLAW_TIMEOUT_MS || 180000);
const WORKER_EXECUTION_MODE = (process.env.WORKER_EXECUTION_MODE || 'hybrid').toLowerCase();
const OPENAI_API_KEY = process.env.OPENAI_API_KEY?.trim() || '';
const OPENAI_MODEL = process.env.OPENAI_MODEL?.trim() || 'gpt-5.4-mini';
const OPENAI_TIMEOUT_MS = Number(process.env.OPENAI_TIMEOUT_MS || 180000);
const HEARTBEAT_FILE = process.env.HEARTBEAT_FILE || '/tmp/openclaw-worker-heartbeat';

const ROLE_HINTS = {
  content_creator: 'Create polished content for LinkedIn, WhatsApp, newsletters, and campaign assets.',
  scraper: 'Return structured scraping plan/data only. Do not invent missing data.',
  image_prompt_creator: 'Return detailed image prompts with aspect ratio, layout, subject, mood, and text placement.',
  email_sequence_creator: 'Return concise outreach sequence with subject + body and one CTA per email.',
  lead_enrichment_agent: 'Enrich only from provided data; do not invent contact details.',
  blog_writer: 'Draft blog content focused on agro-trade execution.',
  social_post_creator: 'Generate social-ready posts and optional variants by platform.',
  warehouse_content_creator: 'Position warehouse listing/booking as agro-trade execution infrastructure.',
  research_agent: 'Produce structured research brief with assumptions and open questions.',
};

const BASE_PROMPT = `You are OBAOL's internal automation assistant.

Before answering, follow the company context inside OpenClaw workspace:
- ~/.openclaw/workspace/context/OBAOL_COMPANY_CONTEXT.md
- ~/.openclaw/workspace/context/CONTENT_CREATOR.md
- ~/.openclaw/workspace/HEARTBEAT.md

Company positioning:
OBAOL is a B2B agro-trade execution ecosystem, not just a marketplace, broker, trader, or lead-selling platform.
GAIN is secondary and should not be the main focus unless explicitly requested.

Output rules:
- Return only final usable output.
- Do not invent facts, prices, company names, phone numbers, emails, certifications, live market data, or fake claims.
- Use practical agro trade language.
- Keep OBAOL positioned as an execution ecosystem.
- If task asks for multiple outputs, return them clearly as separate sections.

Structured output instruction:
When possible, return a JSON block at the end using this format:
{
  "structured_outputs": [
    {
      "type": "linkedin_post",
      "title": "",
      "content": "",
      "metadata": {}
    }
  ]
}`;

validateConfiguration();

async function run() {
  logStartup();
  while (true) {
    try {
      touchHeartbeat();
      const next = await fetchJson(`${SERVER_URL}/agents/tasks/next`, {
        method: 'GET',
        headers: authHeaders(),
      });

      const task = next?.task ?? null;
      if (!task) {
        await sleep(POLL_INTERVAL_MS);
        continue;
      }

      console.log('[openclaw-worker] picked', { id: task.id, role: task.role_key, type: task.task_type });
      const prompt = buildPrompt(task);
      const generated = await generateOutput(prompt);

      const parsed = extractStructuredOutputs(generated.stdout);
      const resultText = parsed.cleanedText || generated.stdout || generated.stderr || 'No output produced';

      await submitResult(task.id, {
        status: 'completed',
        result: resultText,
        structured_outputs: parsed.structuredOutputs,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown worker error';
      console.error('[openclaw-worker] loop error', message);
      await sleep(POLL_INTERVAL_MS);
    }
  }
}

async function generateOutput(prompt) {
  if (WORKER_EXECUTION_MODE === 'cli') {
    return runOpenClawCli(prompt);
  }

  if (WORKER_EXECUTION_MODE === 'api') {
    return runOpenAiApi(prompt);
  }

  try {
    return await runOpenClawCli(prompt);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'CLI mode failed';
    console.warn('[openclaw-worker] cli failed, falling back to OpenAI API', { message });
    return runOpenAiApi(prompt);
  }
}

async function runOpenClawCli(prompt) {
  const response = await execFileAsync(
    OPENCLAW_COMMAND,
    ['agent', '--message', prompt],
    {
      timeout: OPENCLAW_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
    }
  );

  return {
    mode: 'cli',
    stdout: String(response.stdout || '').trim(),
    stderr: String(response.stderr || '').trim(),
  };
}

async function runOpenAiApi(prompt) {
  if (!OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is required for API execution mode');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);

  try {
    const res = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        input: prompt,
      }),
      signal: controller.signal,
    });

    const raw = await res.text();
    if (!res.ok) {
      throw new Error(`OpenAI API error ${res.status}: ${raw.slice(0, 800)}`);
    }

    const parsed = raw ? JSON.parse(raw) : {};
    const text = extractOpenAiOutputText(parsed).trim();

    return {
      mode: 'api',
      stdout: text || 'No output produced',
      stderr: '',
    };
  } finally {
    clearTimeout(timeout);
  }
}

function extractOpenAiOutputText(payload) {
  if (!payload || typeof payload !== 'object') {
    return '';
  }

  const candidateText = payload.output_text;
  if (typeof candidateText === 'string' && candidateText.trim()) {
    return candidateText;
  }

  const output = Array.isArray(payload.output) ? payload.output : [];
  const chunks = [];

  for (const item of output) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const part of content) {
      if (part?.type === 'output_text' && typeof part?.text === 'string') {
        chunks.push(part.text);
      }
      if (part?.type === 'text' && typeof part?.text === 'string') {
        chunks.push(part.text);
      }
    }
  }

  return chunks.join('\n').trim();
}

function buildPrompt(task) {
  const hint = ROLE_HINTS[task.role_key] || 'Return practical output for the requested role.';
  return `${BASE_PROMPT}

Task role:
${task.role_key}

Task type:
${task.task_type}

Role-specific behavior:
${hint}

User request:
${task.input}

Metadata:
${JSON.stringify(task.metadata || {}, null, 2)}`;
}

function extractStructuredOutputs(output) {
  const matches = output.match(/\{[\s\S]*"structured_outputs"[\s\S]*\}/g);
  if (!matches || matches.length === 0) {
    return { structuredOutputs: [], cleanedText: output };
  }

  for (let i = matches.length - 1; i >= 0; i -= 1) {
    try {
      const parsed = JSON.parse(matches[i]);
      if (parsed && Array.isArray(parsed.structured_outputs)) {
        const cleanedText = output.replace(matches[i], '').trim();
        return {
          structuredOutputs: parsed.structured_outputs,
          cleanedText,
        };
      }
    } catch {
      // Ignore parse errors and keep full result text.
    }
  }

  return { structuredOutputs: [], cleanedText: output };
}

async function submitResult(taskId, payload) {
  await fetchJson(`${SERVER_URL}/agents/tasks/${taskId}/result`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(payload),
  });
  console.log('[openclaw-worker] submitted', { taskId, status: payload.status });
}

function authHeaders() {
  return {
    Authorization: `Bearer ${WORKER_SECRET}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}

async function fetchJson(url, options) {
  const res = await fetch(url, options);
  const raw = await res.text();
  let data = {};
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    data = { raw };
  }

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${raw.slice(0, 400)}`);
  }

  return data;
}

function must(name) {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`Missing environment variable: ${name}`);
  }
  return value.trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadDotEnv() {
  const envPath = path.join(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    const val = trimmed.slice(idx + 1).trim().replace(/^"|"$/g, '');
    if (!(key in process.env)) {
      process.env[key] = val;
    }
  }
}

function validateConfiguration() {
  const allowedModes = new Set(['hybrid', 'cli', 'api']);
  if (!allowedModes.has(WORKER_EXECUTION_MODE)) {
    throw new Error(
      `Invalid WORKER_EXECUTION_MODE: ${WORKER_EXECUTION_MODE}. Expected one of hybrid|cli|api`
    );
  }

  if ((WORKER_EXECUTION_MODE === 'api' || WORKER_EXECUTION_MODE === 'hybrid') && !OPENAI_API_KEY) {
    console.warn(
      '[openclaw-worker] OPENAI_API_KEY is not set; API mode/fallback will fail if CLI is unavailable.'
    );
  }
}

function logStartup() {
  console.log('[openclaw-worker] started', {
    SERVER_URL,
    POLL_INTERVAL_MS,
    WORKER_EXECUTION_MODE,
    OPENCLAW_COMMAND,
    OPENCLAW_TIMEOUT_MS,
    OPENAI_MODEL,
    openaiKeyConfigured: Boolean(OPENAI_API_KEY),
    HEARTBEAT_FILE,
  });
}

function touchHeartbeat() {
  try {
    fs.writeFileSync(HEARTBEAT_FILE, String(Date.now()));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn('[openclaw-worker] heartbeat write failed', { HEARTBEAT_FILE, message });
  }
}

run().catch((error) => {
  console.error('[openclaw-worker] fatal', error);
  process.exit(1);
});
