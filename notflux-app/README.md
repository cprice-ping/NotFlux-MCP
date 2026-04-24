# NotFlux App

Netflix-pun streaming demo with PingOne OIDC login and an embedded Vertex AI Agent.

## Architecture

```
Browser (React SPA)
  │  PKCE Auth Code flow
  ▼
PingOne  ─── issues access_token (scope: get_media)
  │
  │  Bearer token in Authorization header
  ▼
Vite dev proxy /api → localhost:3001 (backend)
  │
  ├── POST /api/sessions ──► Vertex AI Agent Engine (creates session, injects PingOne token in state)
  ├── POST /api/chat     ──► Vertex AI Agent Engine (stream SSE)   ← GCP ADC auth
  └── /api/notflux/*    ──► notflux-api.ping-devops.com (Kong / ping-auth AAM)
```

The agent tool-calls flow back through the existing **NotFlux MCP Server** running in k8s.  
The agent reads `pingone_authorization` from session state and uses it as the Bearer token for MCP calls.

## Prerequisites

- Node.js 22+
- `gcloud auth application-default login` (for backend GCP auth)
- PingOne OIDC client `5d24d1a9-851e-4cfb-8f94-d23d4b8b5be2` configured with:
  - Grant type: **Authorization Code (PKCE)**
  - Redirect URI: `http://localhost:5173/callback`
  - Post-logout redirect URI: `http://localhost:5173/`
  - Allowed scopes: `openid profile get_media`
  - Token endpoint auth method: **None** (public client / PKCE)

## Quick start

```bash
cd notflux-app

# Copy and review env
cp .env.example backend/.env

# Install all workspaces
npm install

# Start both backend (port 3001) and frontend (port 5173) in parallel
npm run dev
```

Open http://localhost:5173 → sign in via PingOne → browse content → click ✦ to chat with the agent.

## PingOne OIDC client setup note

The ADK agent must read the `pingone_authorization` session state key in MCP tool calls:

```python
# In your ADK agent tool or MCPToolset connection headers:
headers={"Authorization": lambda ctx: ctx.state.get("pingone_authorization", "")}
```

See the MCP Server README for more details on the token flow.
