# NotFlux

NotFlux is a demo streaming application built around a Vertex-hosted ADK agent, an MCP server, and PingOne-issued tokens exchanged across service boundaries.

The key architectural rule is that **PingOne Authorize / AAM is the policy brain**. It decides entitlement, restriction, and step-up outcomes. The agent, app backend, and MCP server do not make their own authorization decisions; they pass tokens, execute requests, and relay policy outcomes.

## Components

| Path | Purpose |
|------|---------|
| `src/` | MCP server that exposes NotFlux API operations as MCP tools |
| `notflux-app/frontend/` | React/Vite frontend for login, chat UI, and HITL rendering |
| `notflux-app/backend/` | Express bridge for Vertex sessions, stream translation, and Exchange 1 |
| `notflux-agent/` | Vertex ADK agent that injects MCP auth from session state |
| `k8s/` | Kubernetes manifests for MCP deployment |

## MCP Server

The MCP server is compliant with the **2025-11-25 specification** and exposes NotFlux API operations as tools for the agent.

It is intentionally thin. It validates the incoming MCP token audience, performs a tool-scoped token exchange for the NotFlux API, forwards the request, and relays the policy outcome back to the agent.

## Transport

**Streamable HTTP** on `/mcp`:

| Method | Purpose |
|--------|---------|
| `POST /mcp` | JSON-RPC requests (initialize + tool calls) |
| `GET /mcp` | SSE stream for server-to-client notifications |
| `DELETE /mcp` | Explicit session termination |

## Tools

| Tool | Scope used in MCP -> Kong exchange | Purpose |
|------|------------------------------------|---------|
| `get_all_media_metadata` | `get_media` | List media available to the current user |
| `get_media_metadata` | `get_media` | Fetch metadata for a single title |
| `get_media_content` | `get_media` | Retrieve playable content using a DRM token |
| `get_account` | `manage_account` | Return account details for the current user or a specific account |
| `create_profile` | `manage_profiles` | Create a profile under a primary account |
| `delete_profile` | `manage_profiles` | Delete a profile by UUID |
| `get_primary_account` | `manage_profiles` | Fetch a primary account by UUID |

`get_media_content` is the only tool that accepts `transaction_id` and `otp_code` for HITL retry. Other tools surface policy outcomes but do not expose retry arguments in the tool schema.

## Architecture

```text
PingOne person/agent token
  -> Exchange 1 in app backend: agent_token/person_token -> mcp_token
  -> Agent sends Bearer mcp_token to MCP Server
  -> MCP Server validates aud=EXPECTED_AUDIENCE
  -> Exchange 2 in MCP Server: mcp_token -> kong_token(scope is chosen per tool)
  -> NotFlux API behind Kong + PingOne Authorize / AAM
```

Important boundary:

- **PingOne Authorize / AAM** decides access, restrictions, and step-up requirements.
- **MCP Server** executes the requested tool call and returns the policy result.
- **Agent** explains results to the user and retries only when the policy engine requires additional input.

## HITL / Step-Up Behavior

When the NotFlux API responds with a `401` Bearer challenge containing PingOne step-up metadata, the MCP server converts that into a structured HITL payload:

```json
{
  "hitl_required": true,
  "event_type": "otp-required",
  "transaction_id": "...",
  "message": "This request needs an OTP ..."
}
```

The agent/client must treat that as a policy challenge, not as an application error. On retry, only `get_media_content` currently carries `transaction_id` and `otp_code` back into the tool call.

## Prerequisites

- Node.js >= 20
- A PingOne environment configured for both exchanges
- A client that can send an `Authorization: Bearer <mcp_token>` header to `/mcp`

## Environment Variables

See [.env.example](.env.example).

Key variables:

| Variable | Description |
|----------|-------------|
| `EXPECTED_AUDIENCE` | Audience the MCP server requires on the incoming MCP token |
| `PINGONE_ENV_ID` | PingOne environment for Exchange 2 |
| `PINGONE_TX_CLIENT_ID` | Confidential client used for Exchange 2 |
| `PINGONE_TX_CLIENT_SECRET` | Client secret for Exchange 2 |
| `PINGONE_KONG_AUDIENCE` | Audience of the Kong / NotFlux API token |
| `PORT` | HTTP listen port, default `8080` |

Exchange 2 scope is **not** configured globally in `.env`. It is selected per tool call in code so the resulting Kong token matches the API operation being performed.

## Running The MCP Server

```bash
npm install
npm run dev
```

For a production build:

```bash
npm run build
npm start
```

The server listens on `http://localhost:8080/mcp` by default.

For the full end-to-end app flow, see [notflux-app/README.md](notflux-app/README.md).

## Connecting an MCP Client

### VS Code

```json
{
  "servers": {
    "notflux": {
      "type": "http",
      "url": "http://localhost:8080/mcp"
    }
  }
}
```

### Claude Desktop

```json
{
  "mcpServers": {
    "notflux": {
      "url": "http://localhost:8080/mcp"
    }
  }
}
```

The MCP client must provide an `Authorization` header carrying an MCP-audience token. In the full NotFlux flow, that token is injected dynamically by the Vertex agent runtime rather than hard-coded in client config.
