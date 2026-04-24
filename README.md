# NotFlux — AI-Powered Streaming Demo

A demo application showing how to integrate a **Google Vertex AI Agent Engine** chatbot into a streaming media app, with a full enterprise OAuth 2.0 token exchange chain enforced at every service boundary.

## System overview

```
┌─────────────────────────────────────────────────────────┐
│  NotFlux App  (notflux-app/)                            │
│                                                         │
│  React + Vite frontend  ◄──────────────────────────┐   │
│    • PingOne PKCE login                             │   │
│    • Netflix-style media grid                       │   │
│    • AI chat panel (streaming)                      │   │
│         │                                           │   │
│         │ agent_token                               │   │
│         ▼                                           │   │
│  Express backend proxy                              │   │
│    • Token Exchange 1: agent_token → mcp_token      │   │
│    • Vertex AI Agent Engine sessions + SSE stream ──┘   │
└──────────────────────────┬──────────────────────────────┘
                           │ mcp_token (via Vertex session state)
                           ▼
┌─────────────────────────────────────────────────────────┐
│  NotFlux MCP Server  (src/)                             │
│                                                         │
│  MCP 2025-11-25 spec, Streamable HTTP, port 8080        │
│    • JWT validation (RFC 9470 / RFC 6750)               │
│    • Token Exchange 2: mcp_token → api_token            │
│    • 4 tools: get_all_media_metadata, get_media_        │
│      metadata, get_media_content, get_account           │
└──────────────────────────┬──────────────────────────────┘
                           │ api_token (ephemeral)
                           ▼
┌─────────────────────────────────────────────────────────┐
│  Kong Gateway + PingOne AAM                             │
│    • ping-auth plugin validates api_token               │
│    • AAM policy enforces per-user content ratings       │
└─────────────────────────────────────────────────────────┘
```

The user logs into the NotFlux App with PingOne. A second, silently-acquired token is scoped to the Vertex AI agent. The Vertex agent calls the MCP Server via the MCP protocol, passing a token that is only useful against the MCP Server — not Kong. The MCP Server performs its own token exchange to get a short-lived Kong-usable token before making each API call. No single component ever holds a token that is valid against all services.

## Components

| Directory | Description |
|-----------|-------------|
| `src/` | MCP Server — TypeScript, Node.js 22, `@modelcontextprotocol/sdk` |
| `notflux-app/frontend/` | React + Vite + Tailwind SPA |
| `notflux-app/backend/` | Express proxy — Vertex AI bridge + token exchanges |
| `k8s/` | Kubernetes manifests (ARM64, namespace `ping-devops-cprice`) |

## MCP Server transport

**Streamable HTTP** – the server exposes a single `/mcp` endpoint:

| Method | Purpose |
|--------|---------|
| `POST /mcp` | JSON-RPC requests (initialize + all tool calls) |
| `GET /mcp` | SSE stream for server-to-client notifications |
| `DELETE /mcp` | Explicit session termination |

## MCP tools

| Tool | Description |
|------|-------------|
| `get_all_media_metadata` | List all media items available to the user |
| `get_media_metadata` | Fetch metadata (incl. DRM token) for a single item |
| `get_media_content` | Retrieve playable content using the DRM token |
| `get_account` | Look up an account by UUID |

## Running locally

```bash
# 1. Install all dependencies (root MCP Server + notflux-app)
npm install
cd notflux-app && npm install && cd ..

# 2. Configure environment files
cp .env.example .env                                          # MCP Server
cp notflux-app/.env.example notflux-app/backend/.env         # App backend
cp notflux-app/frontend/.env.example notflux-app/frontend/.env  # App frontend

# 3. Fill in PingOne client IDs/secrets/audiences in each .env file

# 4. Start the app (frontend on :5173, backend on :3001)
cd notflux-app && npm run dev

# 5. Start the MCP Server separately (port 8080)
npm run dev
```

## Environment Variables

### MCP Server (`.env`)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PINGONE_ENV_ID` | Yes | — | PingOne environment UUID |
| `MCP_AUDIENCE` | Yes* | — | `aud` claim to validate on inbound tokens (`notflux-mcp`). Set to enable JWT validation |
| `MCP_REQUIRED_SCOPE` | No | `use_mcp_tools` | Scope required on inbound MCP tokens |
| `MCP_RS_CLIENT_ID` | Yes* | — | `notflux-mcp-rs` Worker app client ID. Set to enable Exchange 2 |
| `MCP_RS_CLIENT_SECRET` | Yes* | — | `notflux-mcp-rs` Worker app client secret |
| `MCP_API_AUDIENCE` | Yes* | — | Audience of the NotFlux API resource (what Kong validates) |
| `MCP_API_SCOPE` | No | `get_media` | Scope to request on the outbound API token |
| `MCP_PUBLIC_BASE_URL` | No | — | Public URL, used in WWW-Authenticate headers and RFC 9470 discovery |
| `PORT` | No | `8080` | HTTP listen port |

### App backend (`notflux-app/backend/.env`)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PINGONE_ENV_ID` | Yes | — | PingOne environment UUID |
| `PINGONE_TX_CLIENT_ID` | Yes* | — | `notflux-backend` Worker app client ID |
| `PINGONE_TX_CLIENT_SECRET` | Yes* | — | `notflux-backend` Worker app client secret |
| `PINGONE_MCP_AUDIENCE` | Yes* | — | Audience of the MCP Server resource (`notflux-mcp`) |
| `PINGONE_MCP_SCOPE` | No | `use_mcp_tools` | Scope to request in Exchange 1 |
| `PINGONE_AGENT_AUDIENCE` | No | — | Expected `aud` on incoming agent tokens (enables validation) |
| `VERTEX_AGENT_RESOURCE` | Yes | — | Vertex AI Agent Engine resource name |
| `BACKEND_PORT` | No | `3001` | HTTP listen port |

### App frontend (`notflux-app/frontend/.env`)

| Variable | Required | Description |
|----------|----------|-------------|
| `VITE_PINGONE_ENV_ID` | Yes | PingOne environment UUID |
| `VITE_PINGONE_CLIENT_ID` | Yes | SPA application client ID |
| `VITE_PINGONE_AGENT_RESOURCE` | No | Audience URI for the agent resource (enables separate agent token) |

## OAuth 2.0 Token Chain (RFC 8693 Token Exchange)

The full request path involves three tokens, each scoped to exactly one service boundary. No token is usable beyond the hop it was issued for.

```
Browser (PKCE login)
  │
  ├─ person_token  aud=notflux-api  scope=get_media
  │   └─► NotFlux App frontend → direct Kong calls (/media, /accounts)
  │
  └─ agent_token   aud=google-agent  scope=agent-use
      └─► NotFlux App backend
            │
            Exchange 1 (notflux-backend Worker app)
            │   subject_token: agent_token
            │   → mcp_token   aud=notflux-mcp  scope=use_mcp_tools
            │
            └─► Vertex AI Agent Engine session state
                  └─► MCP Server
                        │
                        Exchange 2 (notflux-mcp-rs Worker app)
                        │   subject_token: mcp_token
                        │   → api_token   aud=notflux-api  scope=get_media
                        │
                        └─► Kong Gateway (ping-auth + AAM)
```

### Token hop summary

| Hop | Token name | `aud` | `scope` | Validated by | Env var(s) |
|-----|-----------|-------|---------|--------------|------------|
| 0 — PKCE login | `person_token` | `notflux-api` | `get_media` | Kong ping-auth | `VITE_PINGONE_*` (frontend) |
| 0 — silent PKCE | `agent_token` | `google-agent` | `agent-use` | Backend (`checkAgentToken`) | `PINGONE_AGENT_AUDIENCE` |
| 1 — Exchange | `mcp_token` | `notflux-mcp` | `use_mcp_tools` | MCP Server (`validateBearerToken`) | `MCP_AUDIENCE`, `MCP_REQUIRED_SCOPE` |
| 2 — Exchange | `api_token` | `notflux-api` | `get_media` | Kong ping-auth + AAM | `MCP_API_AUDIENCE`, `MCP_API_SCOPE` |

The `api_token` is ephemeral — created inside `notfluxRequest()` and never stored in session state. A compromised agent session or MCP transport yields only a `mcp_token`, which Kong will reject (wrong audience). An attacker also needs `MCP_RS_CLIENT_ID` + `MCP_RS_CLIENT_SECRET` to perform Exchange 2.

### PingOne application setup

| PingOne app | Type | Grant | Actor policy | Issues |
|-------------|------|-------|--------------|--------|
| NotFlux SPA | Native/SPA | Authorization Code + PKCE | — | `person_token`, `agent_token` |
| `notflux-backend` | Worker | Token Exchange | subject=`google-agent` audience tokens | `mcp_token` |
| `notflux-mcp-rs` | Worker | Token Exchange | subject=`notflux-mcp` audience tokens | `api_token` |

### PingOne resource setup

| Resource name | Audience | Scopes |
|---------------|----------|--------|
| NotFlux MCP Server | `notflux-mcp` | `use_mcp_tools` |
| NotFlux API | `notflux-api` _(or Kong's configured value)_ | `get_media` |

---

## Workflow Example

A typical agent interaction looks like:

1. Call `get_all_media_metadata` to see the available catalogue.
2. Call `get_media_metadata` with a specific `id` to get the DRM token.
3. Call `get_media_content` with both `id` and `drm` to retrieve the content.
