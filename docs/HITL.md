# Human-in-the-Loop (HITL) Architecture

This document describes how the NotFlux stack implements Human-in-the-Loop verification flows — specifically PingOne Advanced Identity Cloud (P1AZ) MFA challenges issued by the NotFlux/Kong resource server.

---

## Overview

```
User Browser
    │
    │  AG-UI SSE (RUN_FINISHED / interrupt)
    ▼
notflux-app / frontend  (React)
    │
    │  POST /api/chat  { resume: [...] }
    ▼
notflux-app / backend  (Express proxy)
    │
    │  Plain-text resume instruction → Vertex AI Agent Engine (ADK)
    ▼
Google Vertex AI Agent Engine  (Gemini + ADK)
    │
    │  MCP tool call  (with X-Hitl-* headers on retry)
    ▼
notflux-mcp-server  (MCP 2025-11-25)
    │
    │  Bearer request → NotFlux API / Kong
    ▼
PingOne AIC  (resource server / policy engine)
```

Two HITL event types are currently supported:

| `event_type`   | Trigger                                 | User action               |
|----------------|-----------------------------------------|---------------------------|
| `otp-required` | P1AZ requires an SMS/email OTP code     | Enter code in UI          |
| `qr-required`  | P1AZ requires identity document scan   | Scan QR on mobile device  |

---

## Layer 1 — Resource Server → MCP Server (P1AZ 401 Challenge)

When a protected NotFlux API call requires step-up authentication, PingOne AIC returns:

```http
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer error="<event_type>",
                         error_description="<text or QR URL>",
                         acr_values="<transactionId>",
                         max_age="3600"
```

| Parameter           | Meaning                                                                 |
|---------------------|-------------------------------------------------------------------------|
| `error`             | HITL event type: `otp-required` or `qr-required`                       |
| `error_description` | Human-readable message (OTP) **or bare QR image URL** (QR)             |
| `acr_values`        | P1AZ transaction handle — must be echoed back on retry                 |
| `max_age`           | Seconds until the transaction expires                                   |

> **QR special case:** For `qr-required`, `error_description` contains the raw QR image URL
> (e.g. `https://api.pingone.com/v1/idValidations/webVerifications/<id>/qr?code=<digits>`).
> This URL serves double duty: it is both the `<img src>` endpoint *and* carries the
> human-readable verification code as the `?code=` query parameter.
> A trailing `)` artifact may appear (from a P1AZ policy template) and is stripped by the MCP server.

### Retry headers

On the agent's second tool call the MCP server includes:

| Header                  | Present when        | Value                              |
|-------------------------|---------------------|------------------------------------|
| `X-Hitl-Transaction-Id` | Always on retry     | `acr_values` from the 401 response |
| `X-Hitl-Otp`            | OTP flow only       | The code entered by the user       |

P1AZ checks the transaction, evaluates the policy, and either allows (`2xx`) or denies (`non-401` error).

---

## Layer 2 — MCP Server (src/index.ts)

### `parseBearerChallenge(header)`

Parses the `WWW-Authenticate` header into:

```typescript
interface BearerChallenge {
  error: string;           // "otp-required" | "qr-required"
  errorDescription: string;
  transactionId: string;   // acr_values
  maxAge?: number;
}
```

### `executeWithHitl(mcpToken, ctx, scope, hitl?)`

Wraps every tool call that touches a HITL-protected endpoint.

**First call** (`hitl` is absent or empty):
- Makes the API request with no HITL headers
- If 401 + parseable Bearer challenge → returns structured HITL payload (see below)
- If success → returns data normally

**Retry call** (`hitl.transactionId` supplied by the agent):
- Adds `X-Hitl-Transaction-Id` (and `X-Hitl-Otp` for OTP) to the request headers
- If `2xx` → success, returns data
- If non-`2xx` → returns error text (DENY or other failure)

### HITL tool response payload

Returned as a `text` content item so the ADK agent sees it as the tool's output:

```json
{
  "hitl_required": true,
  "event_type": "qr-required",
  "transaction_id": "<acr_values from P1AZ>",
  "message": "Scan the QR code with your mobile device to verify your identity.",
  "qr_code_url": "https://api.pingone.com/v1/idValidations/webVerifications/<id>/qr?code=<digits>"
}
```

For `otp-required`, `message` is the `error_description` text from P1AZ and `qr_code_url` is omitted.

### Tool schema (`create_profile`)

The `transaction_id` argument is optional so the agent can call the tool without it on the first attempt and then supply it on the HITL retry:

```json
{
  "name": "transaction_id",
  "description": "HITL transaction id from a previous QR-code challenge response",
  "required": false
}
```

---

## Layer 3 — Backend Proxy (notflux-app/backend/src/server.ts)

The Express backend bridges Vertex AI Agent Engine's NDJSON SSE stream to AG-UI SSE for the browser.

### `findHitlChallenge(value)`

Recursively walks any event payload — including deeply nested `function_response` structures — looking for an object with `hitl_required: true`. Handles:
- Objects at any nesting depth
- JSON strings embedded inside object values (e.g. ADK wraps tool responses as text)
- Markdown fenced code blocks

### `emitInterrupt(challenge)`

Converts a detected HITL challenge into an **AG-UI `RUN_FINISHED` interrupt** event sent to the browser. The `emittedInterruptIds` set prevents duplicate emissions when the model echoes the HITL payload in its own text response (which ADK/Gemini sometimes does).

```json
{
  "type": "RUN_FINISHED",
  "outcome": {
    "type": "interrupt",
    "interrupts": [{
      "id": "<transaction_id>",
      "reason": "input_required",
      "message": "<challenge.message>",
      "responseSchema": { ... },
      "metadata": {
        "event_type": "qr-required",
        "transaction_id": "<transaction_id>",
        "qr_code_url": "<url>"
      }
    }]
  }
}
```

`responseSchema` differs by event type:
- **OTP**: requires `transaction_id` + `otp_code`
- **QR**: requires `transaction_id` only

### `buildResumeInstruction(resume)`

When the user completes verification, the frontend sends a `resume` array to `POST /api/chat`. The backend converts it to a plain-text instruction that the ADK agent understands as a new turn:

**OTP:**
```
HITL verification complete. Retry the same tool call now.
event_type: otp-required
transaction_id: <id>
otp_code: <code>
Use transaction_id and otp_code as tool arguments.
```

**QR:**
```
HITL verification complete. Retry the same tool call now.
event_type: qr-required
transaction_id: <id>
Use transaction_id as a tool argument.
```

> **Why plain text?** Vertex AI Agent Engine's `streamQuery` endpoint takes a free-text `message`. There is no native HITL/interrupt resume API, so the resume is delivered as a human turn instruction. The agent re-calls the tool using the arguments from the instruction text.

---

## Layer 4 — Frontend App (notflux-app/frontend)

### Types (`src/types/index.ts`)

```typescript
interface HitlChallenge {
  id: string;              // = transaction_id (interrupt id)
  reason: string;          // "input_required"
  message?: string;
  responseSchema?: { ... };
  metadata?: {
    event_type?: string;       // "otp-required" | "qr-required"
    transaction_id?: string;
    qr_code_url?: string;      // QR flow only
  };
}
```

### `useAgent` hook (`src/hooks/useAgent.ts`)

Manages `activeHitl: HitlChallenge | null` state alongside the chat stream.

| Function          | Behaviour                                                                 |
|-------------------|---------------------------------------------------------------------------|
| `submitHitlOtp`   | Reads `transaction_id` + OTP from input; sends resume; clears `activeHitl` |
| `submitHitlQr`    | Reads `transaction_id`; sends resume without OTP; clears `activeHitl`    |
| `cancelHitl`      | Clears `activeHitl` without sending a resume                             |

`activeHitl` is set when the SSE stream delivers a `RUN_FINISHED` interrupt event. It is cleared when the user submits or cancels.

### `AgentPanel` component (`src/components/AgentPanel.tsx`)

When `activeHitl` is non-null, an amber verification card is rendered above the input bar. Branching on `metadata.event_type`:

**OTP branch:**
- Text input for the code
- "Verify" button → `onSubmitHitlOtp`
- "✕" cancel button → `onCancelHitl`

**QR branch:**
- `<img src={qr_code_url}>` — the URL is both the image endpoint and carries the code
- Verification code extracted from `?code=` query param via `new URL(url).searchParams.get('code')` and displayed in amber monospace text for fallback manual entry on the mobile app
- "I've scanned it" button (disabled while `thinking`) → `onSubmitHitlQr`
- "Cancel" button → `onCancelHitl`

---

## Sequence — QR Happy Path

```
Browser                  Backend              Agent Engine          MCP Server           P1AZ
  │                         │                      │                    │                  │
  │── POST /api/chat ───────►│                      │                    │                  │
  │   { message: "create profile" }                 │                    │                  │
  │                         │── streamQuery ────────►│                    │                  │
  │                         │                      │── create_profile ──►│                  │
  │                         │                      │                    │── POST /profiles ►│
  │                         │                      │                    │◄── 401 qr-required┤
  │                         │                      │◄── hitl_required ──│                  │
  │◄── RUN_FINISHED ────────│  (interrupt)         │                    │                  │
  │    (QR img URL + txnId) │                      │                    │                  │
  │                         │                      │                    │                  │
  │  [user scans QR on mobile, P1AZ marks verified]                     │                  │
  │                         │                      │                    │                  │
  │── POST /api/chat ───────►│                      │                    │                  │
  │   { resume: [{ transaction_id, event_type }] }  │                    │                  │
  │                         │── streamQuery ────────►│                    │                  │
  │                         │  "HITL complete. Retry │                    │                  │
  │                         │   transaction_id: ..." │                    │                  │
  │                         │                      │── create_profile ──►│                  │
  │                         │                      │   (transaction_id)  │── POST /profiles ►│
  │                         │                      │                    │   X-Hitl-Transaction-Id
  │                         │                      │                    │◄── 201 Created ───┤
  │                         │                      │◄── profile data ───│                  │
  │◄── RUN_FINISHED ────────│  (success)           │                    │                  │
  │    "Profile created"    │                      │                    │                  │
```
