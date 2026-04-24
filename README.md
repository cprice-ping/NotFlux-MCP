# NotFlux MCP Server

An [MCP](https://modelcontextprotocol.io/) server compliant with the **2025-11-25 specification** that exposes the NotFlux streaming API as callable tools for AI agents.

## Transport

**Streamable HTTP** – the server exposes a single `/mcp` endpoint:

| Method | Purpose |
|--------|---------|
| `POST /mcp` | JSON-RPC requests (initialize + all tool calls) |
| `GET /mcp` | SSE stream for server-to-client notifications |
| `DELETE /mcp` | Explicit session termination |

## Tools

| Tool | Description |
|------|-------------|
| `get_all_media_metadata` | List all media items available to the user |
| `get_media_metadata` | Fetch metadata (incl. DRM token) for a single item |
| `get_media_content` | Retrieve playable content using the DRM token |
| `get_account` | Look up an account by UUID |

## Prerequisites

- Node.js ≥ 20
- A valid PingOne bearer token for the NotFlux API

## Setup

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env
# Edit .env and set ACCESS_TOKEN
```

> **Getting a token** – use the PingOne Orchestrate flow in the Postman collection
> ("Get Person Token") to obtain a bearer token, then paste it into `ACCESS_TOKEN`.

## Running

```bash
# Development (live-reload)
npm run dev

# Production build
npm run build
npm start
```

The server starts on `http://localhost:3000/mcp` by default. Set `PORT` in `.env` to override.

## Connecting an MCP Client

### Claude Desktop (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "notflux": {
      "url": "http://localhost:3000/mcp"
    }
  }
}
```

### VS Code (`.vscode/mcp.json`)

```json
{
  "servers": {
    "notflux": {
      "type": "http",
      "url": "http://localhost:3000/mcp"
    }
  }
}
```

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ACCESS_TOKEN` | Yes | — | PingOne bearer token |
| `PORT` | No | `3000` | HTTP listen port |

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
