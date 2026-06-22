# NotFlux App

React frontend + Express backend for the NotFlux demo, with PingOne login and a Vertex-hosted ADK agent.

The app is the user-facing shell. It does **not** decide entitlements, restrictions, or step-up requirements. Those decisions come from **PingOne Authorize / AAM** at the API layer. The app gathers user input, establishes agent sessions, and renders the outcomes returned by the agent and MCP server.

## Architecture

```text
Browser (React SPA)
  -> PingOne login
  -> frontend calls backend with Bearer token

Backend (/api/sessions)
  -> Exchange 1: agent/person token -> mcp_token
  -> creates Vertex session
  -> stores pingone_authorization="Bearer <mcp_token>" in session state

Backend (/api/chat)
  -> streams Vertex agent output back to browser as SSE

Vertex ADK agent
  -> reads pingone_authorization from session state
  -> injects Authorization header into MCP tool connection

MCP Server
  -> validates MCP token audience
  -> Exchange 2: mcp_token -> kong_token(scope chosen per tool)
  -> calls NotFlux API

NotFlux API behind Kong + PingOne Authorize / AAM
  -> returns allow / deny / step-up challenge
```

## Decision Boundary

- **PingOne Authorize / AAM** is the policy brain. It decides what the caller can access and whether step-up is required.
- **NotFlux API** enforces that policy result.
- **MCP Server** forwards requests and relays the result.
- **Agent** does not invent authorization decisions. It explains results, asks the user for additional input when the policy engine requires it, and retries the relevant tool call.
- **Frontend/backend app** renders the conversation and HITL state; it does not make access-control decisions.

## Token Exchanges

### Exchange 1: app backend → gateway token

The backend performs RFC 8693 token exchange before creating the Vertex session:

- input: frontend `person_token` presented to `/api/sessions`
- output: `gateway_token` (`aud=notflux-gateway`, `scope=use_gateway`)
- storage: session state key `pingone_authorization`

This is what lets the Vertex agent call PingGateway with a per-user Bearer token.

### Exchange 2: PingGateway → mcp token (NotFlux path only)

PingGateway performs RFC 8693 token exchange via `OAuth2TokenExchangeFilter` before forwarding to the NotFlux MCP server:

- input: `gateway_token` from the agent
- output: `mcp_token` (`aud=notflux-mcp`, `scope=use_mcp_tools`)

Weather and Agent Registry backends receive an API key instead — no token exchange at this hop.

### Exchange 3: MCP server → Kong token

The NotFlux MCP server performs a third RFC 8693 token exchange on each tool call:

- input: `mcp_token` forwarded by PingGateway
- output: Kong / NotFlux API token
- scope: selected **per tool** in the MCP server code, for example `get_media`, `manage_account`, or `manage_profiles`

This is what binds each API call to the scope required by the underlying NotFlux endpoint.

## HITL / Step-Up

When PingOne policy requires step-up, the API returns a Bearer challenge. The MCP server converts that challenge into structured HITL JSON, and the backend/frontend render it as interrupt UI.

The important detail is that the step-up requirement is a **policy decision**, not an agent decision. The agent is expected to preserve and relay the structured challenge rather than reinterpret it.

## Prerequisites

- Node.js 22+
- `gcloud auth application-default login`
- PingOne OIDC client `5d24d1a9-851e-4cfb-8f94-d23d4b8b5be2` configured for PKCE login

## Quick Start

```bash
cd notflux-app
cp backend/.env.example backend/.env
npm install
npm run dev
```

Open `http://localhost:5173`, sign in via PingOne, and use the assistant or direct UI flows.

## Notes

- The backend streams agent output as SSE and translates HITL events for the frontend.
- The frontend renders OTP / HITL UI from structured interrupt data.
- The agent injects MCP auth dynamically from Vertex session state rather than from static config.

See [../README.md](../README.md) for MCP-server-specific details.
