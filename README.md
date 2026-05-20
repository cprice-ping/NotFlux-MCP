# NotFlux — Zero-Trust AI Agent Governance

> **A blueprint for securely governing non-deterministic AI Agents in a Zero-Trust Enterprise.**

NotFlux demonstrates that the hardest problems in enterprise AI deployment — *Who authorized this action? Can this agent do that? Who is watching?* — are **identity and policy problems**, not application problems. The answers live at the gateway and the authorization engine, not in the agent code.

---

## 1. First-Class Agent Identity via OAuth Delegation

**The problem:** Most enterprise AI deployments use shared system credentials ("give the agent an API key"). If the agent is compromised, or logs a conversation, or calls the wrong tool, nothing in the audit trail ties the action to the human who authorised it.

**The NotFlux pattern:** Every tool call carries a token chain that traces back to a **specific human** who granted a **specific agent** a **specific scope**.

```
person_token  ──(Exchange 1)──▶  agent_token  ──(Exchange 2)──▶  mcp_token  ──(Exchange 3)──▶  kong_token
  sub: alice                       sub: alice                       sub: alice                    sub: alice
  aud: notflux-api                 aud: notflux-agent               aud: notflux-mcp              aud: notflux-kong
                                   act.sub: vertex-agent-id                                       scope: get_media
```

Each hop is an **RFC 8693 Token Exchange**. PingOne stamps the `sub` (Alice) forward at every exchange, and the Vertex Agent's resource path is injected as an `act.sub` claim so Kong can distinguish:

- `sub=alice, act.sub=<none>` → Direct app request from Alice
- `sub=alice, act.sub=projects/…/reasoningEngines/8292402347477303296` → Agent acting *on behalf of* Alice

Kong and PingOne Authorize can evaluate these separately. **An agent can be blocked from DELETE while Alice's direct session is not.** No system accounts. No blind API keys.

---

## 2. State-Free, Gateway-Enforced Human-in-the-Loop (HITL)

**The problem:** Traditional HITL pauses execution and parks an open HTTP connection while the user grabs their phone. This breaks stateless agent runtimes and requires the application to own and manage interrupt state.

**The NotFlux pattern:** HITL is a **policy challenge**, not an application-state problem. PingOne Authorize issues a `401` with a `WWW-Authenticate` challenge header. Nothing in the stack polls or waits.

```
Agent calls tool
  └─▶ MCP Server ──▶ Kong ──▶ NotFlux API
                                └─▶ P1 Authorize: DENY (step-up required)
                                └─▶ 401 WWW-Authenticate: Bearer realm="...", scope="otp-required", transaction_id="..."
      MCP Server detects 401 challenge
      └─▶ Returns structured HITL payload to agent (not an error)
          Agent forwards interrupt to AG-UI frontend
          Frontend renders native OTP or QR widget
          User completes step-up ──▶ Agent retries tool with transaction_id + credential
```

The MCP server never idles. The agent loop never blocks. The frontend widget is driven by the interrupt protocol, not by bespoke application logic. **The gateway is the HITL engine.**

See [docs/HITL.md](docs/HITL.md) for the full challenge format, backend detection, AG-UI interrupt protocol, and sequence diagram.

---

## 3. Cryptographic Audience (`aud`) Isolation

**The problem:** A leaked token or a compromised agent memory log should not hand an attacker the keys to the backend APIs.

**The NotFlux pattern:** Every token is audience-restricted. Each service only accepts tokens minted for it.

| Token | `aud` | Who validates |
|-------|-------|---------------|
| `person_token` | `notflux-api` | Backend before Exchange 1 |
| `agent_token` | `notflux-agent` | Agent callback before Exchange 2 |
| `mcp_token` | `notflux-mcp` | MCP server (`EXPECTED_AUDIENCE`) before any tool |
| `kong_token` | `notflux-kong` | Kong before forwarding to the target API |

A `mcp_token` cannot be replayed against Kong. An `agent_token` cannot be replayed against the MCP server. **Blast radius is bounded at each hop by cryptographic audience enforcement**, not by firewall rules or application-layer checks.

Exchange 3 additionally selects scope **per tool call** — `get_media`, `manage_account`, `manage_profiles` — so the Kong token grants only the minimum privilege for the specific operation in flight.

---

## 4. Zero-Knowledge MCP Servers

**The problem:** MCP tool scripts accumulate enterprise complexity — host names, path prefixes, gateway headers, SNI rules, credential rotation. Each new target API means rewriting the tool.

**The NotFlux pattern:** The MCP server knows one endpoint: `NOTFLUX_API_BASE`. It speaks clean REST against a unified surface.

```
MCP Tool call  ──▶  POST /managed/profiles  (plain REST, bearer kong_token)
                        ▼
                     Kong
                      ├─ Host rewrite: openam-cpricelab-idm.forgeblocks.com
                      ├─ Path rewrite: /openidm/managed/
                      ├─ Audience enforcement: aud=notflux-kong required
                      ├─ Scope enforcement: scope=manage_profiles required
                      └─ PingOne Authorize: policy evaluation, act claim assertion
```

Kong manages host-swapping, path restructuring, TLS/SNI, and all security mediation. **AI teams write pure tools. Enterprise routing and security policy stay in the gateway where they belong.**

---

## Architecture Overview

```
┌─────────────┐     PKCE      ┌─────────────────┐
│  Browser /  │◀─────────────▶│    PingOne AS    │
│  React UI   │  person_token │                  │
└──────┬──────┘               └─────────────────┘
       │ person_token                   ▲
       ▼                                │ RFC 8693 Token Exchange (×3)
┌─────────────┐  Exchange 1   ┌─────────────────┐
│   Backend   │──────────────▶│    PingOne AS    │
│   Proxy     │  agent_token  └─────────────────┘
└──────┬──────┘
       │ agent_token (stored in Vertex session state)
       ▼
┌─────────────┐  Exchange 2   ┌─────────────────┐
│   Vertex    │──────────────▶│    PingOne AS    │
│  ADK Agent  │  mcp_token    └─────────────────┘
└──────┬──────┘  (+ act.sub = agent resource path)
       │ Bearer mcp_token
       ▼
┌─────────────┐  Exchange 3   ┌─────────────────┐
│  MCP Server │──────────────▶│    PingOne AS    │
│  (NotFlux)  │  kong_token   └─────────────────┘
└──────┬──────┘  (scope = per-tool minimum privilege)
       │ Bearer kong_token
       ▼
┌─────────────┐               ┌─────────────────┐
│    Kong     │──────────────▶│  NotFlux API    │
│   Gateway   │               │ + P1 Authorize  │
└─────────────┘               └─────────────────┘
```

**PingOne Authorize / AAM is the policy brain.** The agent, app backend, and MCP server do not make authorization decisions — they pass tokens, execute requests, and relay policy outcomes.

---

## Components

| Path | Purpose |
|------|---------|
| `src/` | MCP server — validates `mcp_token`, performs Exchange 3, exposes NotFlux tools |
| `notflux-app/frontend/` | React/Vite UI — PKCE login, chat, AG-UI OTP/QR HITL widgets |
| `notflux-app/backend/` | Express bridge — Vertex session proxy, Exchange 1, SSE translation |
| `notflux-agent/` | Vertex ADK agent — Exchange 2 in `before_agent_callback`, `inject_mcp_auth` |
| `k8s/` | Kubernetes manifests for MCP server deployment |
| `docs/HITL.md` | HITL architecture — challenge format, interrupt protocol, sequence diagram |

---

## MCP Tools

| Tool | Scope (Exchange 3) | Purpose |
|------|--------------------|---------|
| `get_all_media_metadata` | `get_media` | List media available to the current user |
| `get_media_metadata` | `get_media` | Fetch metadata for a single title |
| `get_media_content` | `get_media` | Retrieve playable content (HITL-capable) |
| `get_account` | `manage_account` | Return account details |
| `create_profile` | `manage_profiles` | Create a profile (HITL-capable — QR step-up) |
| `delete_profile` | `manage_profiles` | Delete a profile by UUID |
| `get_primary_account` | `manage_profiles` | Fetch a primary account by UUID |

`get_media_content` and `create_profile` carry `transaction_id` and step-up credentials on HITL retry.

---

## MCP Server — Running

### Prerequisites
- Node.js ≥ 20
- PingOne environment with three Token Exchange clients wired (see below)

### Environment Variables

| Variable | Description |
|----------|-------------|
| `EXPECTED_AUDIENCE` | `aud` the MCP server requires on the incoming `mcp_token` |
| `PINGONE_ENV_ID` | PingOne environment for Exchange 3 |
| `PINGONE_TX_CLIENT_ID` | Confidential client for Exchange 3 |
| `PINGONE_TX_CLIENT_SECRET` | Client secret for Exchange 3 |
| `PINGONE_KONG_AUDIENCE` | `aud` to request on the `kong_token` |
| `NOTFLUX_API_BASE` | Base URL for the NotFlux API behind Kong |
| `PORT` | HTTP listen port, default `8080` |

See [.env.example](.env.example).

### Start

```bash
npm install && npm run dev        # development
npm run build && npm start        # production
```

Listens on `http://localhost:8080/mcp` (Streamable HTTP, MCP spec 2025-11-25).

### MCP Client Config

```json
{
  "servers": {
    "notflux": { "type": "http", "url": "http://localhost:8080/mcp" }
  }
}
```

In the full NotFlux flow, the `Authorization: Bearer <mcp_token>` header is injected dynamically by the Vertex agent — it is never hard-coded in client config.

---

## PingOne Wiring

Three confidential clients with Token Exchange grant:

| Client | Exchange | subject → issued token |
|--------|----------|------------------------|
| Backend TX client | Exchange 1 | `person_token` (aud: notflux-api) → `agent_token` (scope: `use_agent`) |
| Agent TX client | Exchange 2 | `agent_token` → `mcp_token` (scope: `use_mcp`) + `agent_id` custom claim |
| MCP TX client | Exchange 3 | `mcp_token` → `kong_token` (scope: per-tool) |

For the full app setup, see [notflux-app/README.md](notflux-app/README.md).
