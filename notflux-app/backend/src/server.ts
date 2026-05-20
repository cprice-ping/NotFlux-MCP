import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { GoogleAuth } from 'google-auth-library';

const app = express();
const PORT = process.env.BACKEND_PORT ?? 3001;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const AGENT_RESOURCE =
  process.env.VERTEX_AGENT_RESOURCE ??
  'projects/3682147732/locations/us-west1/reasoningEngines/7712115294709219328';
const AGENT_REGION = AGENT_RESOURCE.match(/locations\/([^/]+)/)?.[1] ?? 'us-west1';
const AGENT_BASE = `https://${AGENT_REGION}-aiplatform.googleapis.com/v1/${AGENT_RESOURCE}`;

const NOTFLUX_API =
  process.env.NOTFLUX_API_BASE ?? 'https://notflux-api.ping-devops.com';

// ---------------------------------------------------------------------------
// PingOne Token Exchange config (RFC 8693)
// Set all three env vars to enable. If unset, the raw frontend token is used
// (current behaviour — safe fallback while the PingOne client is being set up).
// ---------------------------------------------------------------------------
const P1_ENV_ID =
  process.env.PINGONE_ENV_ID ?? '59bb6a66-e76e-490c-b83a-884c50423da4';
const P1_TOKEN_URL = `https://auth.pingone.com/${P1_ENV_ID}/as/token`;
const P1_TX_CLIENT_ID = process.env.PINGONE_TX_CLIENT_ID ?? '';      // confidential backend client
const P1_TX_CLIENT_SECRET = process.env.PINGONE_TX_CLIENT_SECRET ?? '';
// Scope that PingOne maps to the agent resource server audience (e.g. use_agent)
const P1_AGENT_SCOPE = process.env.PINGONE_AGENT_SCOPE ?? 'use_agent';

const TOKEN_EXCHANGE_ENABLED =
  Boolean(P1_TX_CLIENT_ID) &&
  Boolean(P1_TX_CLIENT_SECRET) &&
  Boolean(P1_AGENT_SCOPE);

interface HitlChallenge {
  hitl_required: true;
  event_type: string;
  transaction_id: string;
  message: string;
  /** Deep-link URL for QR-code challenges. Frontend renders this as a QR image. */
  qr_code_url?: string;
}

interface AgUiInterrupt {
  id: string;
  reason: string;
  message?: string;
  responseSchema?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

interface AgUiRunFinishedOutcome {
  type: 'success' | 'interrupt';
  interrupts?: AgUiInterrupt[];
}

interface AgUiEventBase {
  type: string;
  timestamp?: number;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function tryParseJson(value: string): unknown | null {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function tryParseJsonFromMaybeMarkdown(value: string): unknown | null {
  const trimmed = value.trim();
  const direct = tryParseJson(trimmed);
  if (direct !== null) return direct;

  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (!fenced) return null;
  return tryParseJson(fenced[1]);
}

function emitSse(res: express.Response, event: AgUiEventBase) {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function randomId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

function buildResumeInstruction(
  resume: Array<{ interruptId: string; status: 'resolved' | 'cancelled'; payload?: unknown }>
): string {
  const resolved = resume.find((r) => r.status === 'resolved');
  if (!resolved || !isRecord(resolved.payload)) {
    return 'Human-in-the-loop step was cancelled. Continue safely and explain what is needed next.';
  }

  const payload = resolved.payload;
  const otp = typeof payload.otp_code === 'string' ? payload.otp_code : '';
  const transactionId =
    typeof payload.transaction_id === 'string'
      ? payload.transaction_id
      : resolved.interruptId;
  const eventType =
    typeof payload.event_type === 'string'
      ? payload.event_type
      : 'otp-required';
  const isQr = eventType === 'qr-required';

  return [
    'HITL verification complete. Retry the same tool call now.',
    `event_type: ${eventType}`,
    `transaction_id: ${transactionId}`,
    ...(isQr
      ? ['Use transaction_id as a tool argument.']
      : [`otp_code: ${otp}`, 'Use transaction_id and otp_code as tool arguments.']),
  ].join('\n');
}

/** Recursively scans an event payload for an MCP HITL challenge object. */
function findHitlChallenge(value: unknown): HitlChallenge | null {
  if (typeof value === 'string') {
    const parsed = tryParseJsonFromMaybeMarkdown(value);
    if (parsed !== null) {
      const nested = findHitlChallenge(parsed);
      if (nested) return nested;
    }

    const fencedWithContext = value.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (fencedWithContext) {
      const parsedFromFence = tryParseJson(fencedWithContext[1]);
      if (parsedFromFence !== null) {
        const nested = findHitlChallenge(parsedFromFence);
        if (nested) return nested;
      }
    }
    return null;
  }

  if (!isRecord(value)) return null;

  if (
    value.hitl_required === true &&
    typeof value.event_type === 'string' &&
    typeof value.transaction_id === 'string' &&
    typeof value.message === 'string'
  ) {
    return {
      hitl_required: true,
      event_type: value.event_type,
      transaction_id: value.transaction_id,
      message: value.message,
      qr_code_url: typeof value.qr_code_url === 'string' ? value.qr_code_url : undefined,
    };
  }

  for (const child of Object.values(value)) {
    if (Array.isArray(child)) {
      for (const item of child) {
        const found = findHitlChallenge(item);
        if (found) return found;
      }
      continue;
    }

    if (typeof child === 'string' && child.includes('hitl_required')) {
      const parsed = tryParseJsonFromMaybeMarkdown(child.trim());
      if (parsed !== null) {
        const found = findHitlChallenge(parsed);
        if (found) return found;
      }
    }

    const found = findHitlChallenge(child);
    if (found) return found;
  }

  return null;
}

if (TOKEN_EXCHANGE_ENABLED) {
  console.log(`Token Exchange enabled → scope: ${P1_AGENT_SCOPE}`);
} else {
  console.log('Token Exchange disabled — set PINGONE_TX_CLIENT_ID/SECRET and PINGONE_AGENT_SCOPE to enable');
}

/**
 * Exchange the user's frontend access token for an MCP-audience token.
 * Uses RFC 8693 Token Exchange with client_secret_basic authentication.
 *
 * PingOne requirement: the backend application must have the
 * "Token Exchange" grant type enabled, and an "Actor" token policy
 * that permits this client to act on behalf of the subject token's user.
 */
async function tokenExchange(subjectToken: string): Promise<string> {
  if (!TOKEN_EXCHANGE_ENABLED) return subjectToken;

  const params = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
    subject_token: subjectToken,
    subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
    requested_token_type: 'urn:ietf:params:oauth:token-type:access_token',
    scope: P1_AGENT_SCOPE,
  });

  // client_secret_basic — credentials in Authorization header
  const basicCred = Buffer.from(
    `${encodeURIComponent(P1_TX_CLIENT_ID)}:${encodeURIComponent(P1_TX_CLIENT_SECRET)}`
  ).toString('base64');

  const res = await fetch(P1_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${basicCred}`,
    },
    body: params.toString(),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Token Exchange failed (${res.status}): ${err}`);
  }

  const data = await res.json() as { access_token?: string };
  if (!data.access_token) {
    throw new Error('Token Exchange response missing access_token');
  }
  return data.access_token;
}

// ---------------------------------------------------------------------------
// Google Cloud auth (Application Default Credentials)
// ---------------------------------------------------------------------------
const gauth = new GoogleAuth({
  scopes: ['https://www.googleapis.com/auth/cloud-platform'],
});

async function gcpToken(): Promise<string> {
  const client = await gauth.getClient();
  const { token } = await client.getAccessToken();
  if (!token) throw new Error('Failed to obtain GCP access token');
  return token;
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------
app.use(express.json());
app.use(
  cors({
    origin: [
      'http://localhost:5173',
      'http://localhost:4173',
      ...(process.env.CORS_ORIGIN ? [process.env.CORS_ORIGIN] : []),
    ],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
  })
);

function extractBearer(req: express.Request): string {
  const h = req.headers.authorization ?? '';
  return h.startsWith('Bearer ') ? h.slice(7) : '';
}

function requireBearer(
  req: express.Request,
  res: express.Response
): string | null {
  const token = extractBearer(req);
  if (!token) {
    res.status(401).json({ error: 'Missing Bearer token' });
    return null;
  }
  return token;
}

// ---------------------------------------------------------------------------
// POST /api/sessions — create a Vertex AI Agent Engine session
//
// Expects: Bearer person_token (aud=notflux-api, scope=get_media)
// The backend performs Token Exchange (RFC 8693) to obtain an mcp_token
// [aud=notflux-mcp] before injecting it into the Vertex session state.
// The MCP Server independently validates aud=notflux-mcp on every request,
// so the person_token can never reach it even if forwarded by mistake.
// ---------------------------------------------------------------------------
app.post('/api/sessions', async (req, res) => {
  const userToken = requireBearer(req, res);
  if (!userToken) return;

  try {
    // Exchange person_token → mcp_token (falls back to person_token when
    // Token Exchange is not yet configured).
    const mcpToken = await tokenExchange(userToken);

    const token = await gcpToken();
    const body = {
      userId: (req.body.sub as string | undefined) ?? 'anonymous',
      // ADK reads context.state as a flat dict from sessionState — do NOT
      // nest under a "state" key, and use camelCase for the REST API field.
      sessionState: {
        pingone_authorization: `Bearer ${mcpToken}`,
      },
    };

    console.log(`[sessions] creating session for userId=${body.userId}`);

    const r = await fetch(`${AGENT_BASE}/sessions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!r.ok) {
      const err = await r.text();
      return res.status(r.status).json({ error: err });
    }

    const session = await r.json() as { name?: string; response?: { name?: string } };
    console.log(`[sessions] response: ${JSON.stringify(session).slice(0, 400)}`);
    // The Vertex API returns a long-running Operation. The actual session name
    // is in response.name (.../sessions/<id>), not the top-level name which
    // is the operation ID (.../operations/<id>).
    const sessionName = session.response?.name ?? session.name;
    const sessionId = sessionName?.split('/').pop() ?? sessionName;
    res.json({ sessionId, raw: session });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ---------------------------------------------------------------------------
// POST /api/chat — streaming chat with the Vertex AI Agent Engine
//
// Expects: Bearer person_token (aud=notflux-api, scope=get_media)
// Accepts: { message: string, sessionId?: string }
// Returns: text/event-stream (SSE) — each event is raw NDJSON from Agent Engine
// ---------------------------------------------------------------------------
app.post('/api/chat', async (req, res) => {
  const userToken = requireBearer(req, res);
  if (!userToken) return;

  const { message, sessionId, sub: userSub, resume } = req.body as {
    message: string;
    sessionId?: string;
    sub?: string;
    resume?: Array<{ interruptId: string; status: 'resolved' | 'cancelled'; payload?: unknown }>;
  };
  if (!message && (!resume || resume.length === 0)) {
    return res.status(400).json({ error: 'message or resume is required' });
  }

  try {
    // Refresh the exchanged token on every turn so it stays valid.
    // If Token Exchange is disabled this is a no-op (returns userToken).
    const mcpToken = await tokenExchange(userToken);

    const token = await gcpToken();

    // Use the non-deprecated async_stream_query entrypoint on the deployed ADK
    // app. It maps to POST .../reasoningEngines/{id}:streamQuery with user_id
    // and optional session_id in the body — NOT /sessions/{id}:streamQuery.
    const url = `${AGENT_BASE}:streamQuery`;

    const inputMessage =
      resume && resume.length > 0
        ? buildResumeInstruction(resume)
        : message;

    const inputBody = {
      class_method: 'async_stream_query',
      input: {
        message: inputMessage,
        user_id: userSub ?? 'anonymous',
        ...(sessionId ? { session_id: sessionId } : {}),
      },
    };

    console.log(`[chat] → POST ${url}`);
    console.log(`[chat]   body: ${JSON.stringify(inputBody)}`);

    const upstream = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(inputBody),
    });

    console.log(`[chat] ← ${upstream.status} ${upstream.statusText}`);

    if (!upstream.ok) {
      const err = await upstream.text();
      console.error(`[chat] upstream error body: ${err}`);
      return res.status(upstream.status).json({ error: err });
    }

    // Stream SSE back to the browser
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const threadId = sessionId ?? userSub ?? 'anonymous';
    const runId = randomId('run');
    const assistantMessageId = randomId('msg');
    let interrupted = false;
    const emittedInterruptIds = new Set<string>();

    const emitInterrupt = (challenge: HitlChallenge) => {
      const interruptId = challenge.transaction_id || randomId('int');
      if (emittedInterruptIds.has(interruptId)) {
        return;
      }

      emittedInterruptIds.add(interruptId);
      interrupted = true;
      const isQr = challenge.event_type === 'qr-required';
      emitSse(res, {
        type: 'RUN_FINISHED',
        threadId,
        runId,
        outcome: {
          type: 'interrupt',
          interrupts: [
            {
              id: interruptId,
              reason: 'input_required',
              message: challenge.message,
              responseSchema: isQr
                ? {
                    type: 'object',
                    properties: {
                      transaction_id: { type: 'string' },
                      event_type: { type: 'string' },
                    },
                    required: ['transaction_id'],
                  }
                : {
                    type: 'object',
                    properties: {
                      transaction_id: { type: 'string' },
                      otp_code: { type: 'string' },
                      event_type: { type: 'string' },
                    },
                    required: ['transaction_id', 'otp_code'],
                  },
              metadata: {
                event_type: challenge.event_type,
                transaction_id: challenge.transaction_id,
                ...(challenge.qr_code_url ? { qr_code_url: challenge.qr_code_url } : {}),
              },
            },
          ],
        } as AgUiRunFinishedOutcome,
        timestamp: Date.now(),
      } as AgUiEventBase & {
        threadId: string;
        runId: string;
        outcome: AgUiRunFinishedOutcome;
      });
    };

    emitSse(res, {
      type: 'RUN_STARTED',
      threadId,
      runId,
      timestamp: Date.now(),
    } as AgUiEventBase & { threadId: string; runId: string });

    const reader = upstream.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let eventCount = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) {
          eventCount++;
          console.log(`[chat] event #${eventCount}: ${trimmed.slice(0, 200)}`);

            try {
              const parsed = JSON.parse(trimmed) as unknown;
              const challenge = findHitlChallenge(parsed);
              if (challenge) {
                emitInterrupt(challenge);
                continue;
              }

              if (isRecord(parsed)) {
                const text =
                  isRecord(parsed.content) && Array.isArray(parsed.content.parts)
                    ? parsed.content.parts
                        .map((p) => (isRecord(p) && typeof p.text === 'string' ? p.text : ''))
                        .join('')
                    : typeof parsed.output === 'string'
                      ? parsed.output
                      : typeof parsed.text === 'string'
                        ? parsed.text
                        : '';

                if (text) {
                  const challengeInText = findHitlChallenge(text);
                  if (challengeInText) {
                    emitInterrupt(challengeInText);
                    continue;
                  }

                  if (interrupted) {
                    // Ignore late assistant chunks after an interrupt payload
                    // has been surfaced to keep the chat bubble clean.
                    continue;
                  }

                  emitSse(res, {
                    type: 'TEXT_MESSAGE_CHUNK',
                    messageId: assistantMessageId,
                    role: 'assistant',
                    delta: text,
                    timestamp: Date.now(),
                  } as AgUiEventBase & {
                    messageId: string;
                    role: 'assistant';
                    delta: string;
                  });
                  continue;
                }

                if (typeof parsed.error === 'string') {
                  emitSse(res, {
                    type: 'RUN_ERROR',
                    message: parsed.error,
                    timestamp: Date.now(),
                  } as AgUiEventBase & { message: string });
                }
              }
            } catch {
              // ignore non-JSON lines
            }
        }
      }
    }

    if (buffer.trim()) {
      eventCount++;
      console.log(`[chat] event #${eventCount} (final): ${buffer.trim().slice(0, 200)}`);

      try {
        const parsed = JSON.parse(buffer.trim()) as unknown;
        const challenge = findHitlChallenge(parsed);
        if (challenge) {
          emitInterrupt(challenge);
        }
      } catch {
        // ignore non-JSON final line
      }
    }
    console.log(`[chat] stream done — ${eventCount} events`);

    if (!interrupted) {
      emitSse(res, {
        type: 'RUN_FINISHED',
        threadId,
        runId,
        outcome: { type: 'success' } as AgUiRunFinishedOutcome,
        timestamp: Date.now(),
      } as AgUiEventBase & {
        threadId: string;
        runId: string;
        outcome: AgUiRunFinishedOutcome;
      });
    }

    res.end();
  } catch (e) {
    if (!res.headersSent) {
      res.status(500).json({ error: String(e) });
    } else {
      emitSse(res, {
        type: 'RUN_ERROR',
        message: String(e),
        timestamp: Date.now(),
      } as AgUiEventBase & { message: string });
      res.end();
    }
  }
});

// ---------------------------------------------------------------------------
// NotFlux API proxy — forwards requests to the NotFlux/Kong API
// Avoids CORS issues in local dev; production can call the external API directly
// ---------------------------------------------------------------------------
app.use('/api/notflux', async (req, res) => {
  const userToken = requireBearer(req, res);
  if (!userToken) return;

  // Strip /api/notflux prefix, forward to real API
  const upstream = NOTFLUX_API + req.path;
  try {
    const r = await fetch(upstream, {
      method: req.method,
      headers: {
        Authorization: `Bearer ${userToken}`,
        'Content-Type': 'application/json',
      },
      body:
        req.method !== 'GET' && req.method !== 'HEAD'
          ? JSON.stringify(req.body)
          : undefined,
    });

    res.status(r.status);
    r.headers.forEach((v, k) => {
      // Skip headers that break the proxy
      if (['transfer-encoding', 'connection'].includes(k.toLowerCase())) return;
      res.setHeader(k, v);
    });
    const data = await r.text();
    res.send(data);
  } catch (e) {
    res.status(502).json({ error: `Upstream error: ${String(e)}` });
  }
});

// ---------------------------------------------------------------------------
// Health probe
// ---------------------------------------------------------------------------
app.get('/healthz', (_req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () =>
  console.log(`NotFlux backend proxy listening on http://localhost:${PORT}`)
);
