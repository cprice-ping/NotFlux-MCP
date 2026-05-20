"""NotFlux ADK Agent — deployed directly to Vertex AI Agent Engine.

WHY THIS EXISTS (and why not Agent Studio):
  Google Agent Studio exports static MCP configurations.  The MCP tool
  authentication dropdown shows "None" and "OAuth (Coming soon)" — there is
  no mechanism in Studio's generated code to inject a per-session Bearer token
  into the MCP connection at runtime.

  This agent solves that using `before_agent_callback`.  The NotFlux App
  backend injects the user's mcp_token into Vertex session state when it
  creates the session (POST /api/sessions).  This callback reads that value
  before every agent turn and rebuilds the McpToolset with the correct
  Authorization header, so the MCP Server receives a valid token to validate
  and exchange.

  This is NOT a limitation of the ADK itself — it is a gap in Studio's code
  generation.  The ADK fully supports per-session dynamic toolset config.

TOKEN FLOW:
  NotFlux App backend                   Vertex Agent Engine
  ───────────────────                   ──────────────────────────────────
  POST /api/sessions                    Session state:
    person_token ──[Exchange 1]──────►  pingone_authorization: "Bearer agent_token"
    → agent_token (aud=notflux-agent)             │
                                                  │  inject_mcp_auth reads state,
                                                  │  performs Exchange 2 per turn:
                                                  │  agent_token ──[Exchange 2]──► mcp_token
                                                  │  agent_id=<vertex_engine_id>       │
                                                  ▼                                    │
  POST /api/chat                        McpToolset(headers={"Authorization": mcp_token})
    message ─────────────────────────►                │
                                                      ▼
                                        MCP Server validates aud=notflux-mcp
                                        Exchange 3: mcp_token → kong_token
                                                      │
                                                      ▼
                                        Kong Gateway + PingOne AAM

POLICY AUTHORITY:
    PingOne Authorize / AAM is the decision point for entitlement, restriction,
    and step-up outcomes. The agent does not make its own access-control
    decisions. It selects tools, relays policy outcomes, and preserves structured
    HITL challenges so the client can render them and retry when required.

DEPLOYMENT PATTERN:
  Follows the canonical Google ADK pattern — AdkApp is passed directly to
  ReasoningEngine.create(), NOT wrapped in a custom class.  This ensures
  Agent Engine uses its built-in managed session service, which correctly
  loads Vertex session state (including pingone_authorization) on every turn.
"""

import base64
import json
import logging
import os
import time
from typing import Optional
from urllib.parse import quote

import requests as http_requests
from google.adk.agents import llm_agent
from google.adk.agents.callback_context import CallbackContext
from google.adk.tools.mcp_tool.mcp_session_manager import StreamableHTTPConnectionParams
from google.adk.tools.mcp_tool.mcp_toolset import McpToolset
from google.genai import types

MCP_URL = 'https://notflux-mcp.ping-devops.com/mcp?rev=2'

# ---------------------------------------------------------------------------
# PingOne Token Exchange — Exchange 2: agent_token → mcp_token
# Set these in the Vertex AI Agent Engine runtime environment.
# ---------------------------------------------------------------------------
_PINGONE_ENV_ID        = os.getenv('PINGONE_ENV_ID', '')
_PINGONE_CLIENT_ID     = os.getenv('PINGONE_CLIENT_ID', '')
_PINGONE_CLIENT_SECRET = os.getenv('PINGONE_CLIENT_SECRET', '')
# Audience the agent_token must carry (aud check before Exchange 2)
_PINGONE_AGENT_AUDIENCE = os.getenv('PINGONE_AGENT_AUDIENCE', '')
# Audience to request in Exchange 2 (the MCP resource server)
_PINGONE_MCP_AUDIENCE   = os.getenv('PINGONE_MCP_AUDIENCE', '')

# Simple in-process token cache: stripped_agent_token → (mcp_token, expires_at)
_mcp_token_cache: dict[str, tuple[str, float]] = {}


def _get_vertex_agent_id() -> str:
    """Return the Vertex Agent Engine resource path for use as a custom claim.

    Reads standard GCP runtime env vars; returns an empty string when they are
    not available so the exchange still proceeds without the claim.
    """
    project  = os.getenv('GOOGLE_CLOUD_PROJECT') or os.getenv('CLOUD_ML_PROJECT_ID', '')
    location = os.getenv('VERTEX_LOCATION', os.getenv('CLOUD_ML_REGION', 'us-west1'))
    engine   = os.getenv('VERTEX_REASONING_ENGINE_ID', '')
    if project and engine:
        return f'projects/{project}/locations/{location}/reasoningEngines/{engine}'
    return ''


def _exchange_for_mcp_token(agent_token: str) -> str:
    """Exchange an agent-scoped PingOne token for an MCP-scoped token.

    Performs RFC 8693 Token Exchange with:
      subject_token      — the agent_token from Vertex session state
      audience           — PINGONE_MCP_AUDIENCE (notflux-mcp resource server)
      agent_id           — Vertex Agent Engine resource path (custom claim)

    Results are cached by agent_token until 30 s before the token's expiry.
    Falls back to returning the original token when PingOne env vars are unset
    (useful for local dev or before P1 is wired up).
    """
    if not all([_PINGONE_ENV_ID, _PINGONE_CLIENT_ID, _PINGONE_CLIENT_SECRET, _PINGONE_MCP_AUDIENCE]):
        logging.warning('exchange_for_mcp: PingOne env vars not configured — using agent token directly')
        return agent_token

    # Validate that the token from session state was issued for this agent.
    # Decode the JWT payload (no sig verification — PingOne verifies in Exchange 2).
    if _PINGONE_AGENT_AUDIENCE:
        try:
            parts = agent_token.split('.')
            padded = parts[1] + '=' * (-len(parts[1]) % 4)
            payload = json.loads(base64.urlsafe_b64decode(padded).decode())
            aud = payload.get('aud', [])
            if isinstance(aud, str):
                aud = [aud]
            if _PINGONE_AGENT_AUDIENCE not in aud:
                raise ValueError(f'aud={aud!r} does not contain {_PINGONE_AGENT_AUDIENCE!r}')
        except Exception as exc:
            raise RuntimeError(f'exchange_for_mcp: agent_token audience validation failed — {exc}')

    cached = _mcp_token_cache.get(agent_token)
    if cached and time.time() < cached[1]:
        logging.debug('exchange_for_mcp: cache_hit')
        return cached[0]

    agent_id  = _get_vertex_agent_id()
    token_url = f'https://auth.pingone.com/{_PINGONE_ENV_ID}/as/token'

    # client_secret_basic — credentials in Authorization header (same as backend)
    basic_cred = base64.b64encode(
        f'{quote(_PINGONE_CLIENT_ID)}:{quote(_PINGONE_CLIENT_SECRET)}'.encode()
    ).decode()

    payload: dict[str, str] = {
        'grant_type':        'urn:ietf:params:oauth:grant-type:token-exchange',
        'subject_token':     agent_token,
        'subject_token_type':'urn:ietf:params:oauth:token-type:access_token',
        'audience':          _PINGONE_MCP_AUDIENCE,
    }
    if agent_id:
        payload['agent_id'] = agent_id

    logging.info(f'exchange_for_mcp: POST {token_url} agent_id={agent_id or "(none)"}')
    resp = http_requests.post(
        token_url,
        data=payload,
        headers={'Authorization': f'Basic {basic_cred}'},
        timeout=10,
    )
    resp.raise_for_status()

    result      = resp.json()
    mcp_token   = result['access_token']
    expires_in  = int(result.get('expires_in', 3600))
    _mcp_token_cache[agent_token] = (mcp_token, time.time() + expires_in - 30)
    logging.info('exchange_for_mcp: ok')
    return mcp_token


def inject_mcp_auth(callback_context: CallbackContext) -> Optional[types.Content]:
    """Inject per-session MCP auth before each turn.

    McpToolset connects to the MCP server lazily when tools are first resolved,
    which happens AFTER this callback returns.  By rebuilding the toolset here
    — before tool resolution — the correct Authorization header is used for the
    MCP connection established during this turn.

    The agent is initialised WITHOUT a McpToolset (no unauthenticated placeholder).
    This callback always adds a fresh authenticated one using the mcp_token from
    Vertex session state, replacing any McpToolset from a previous turn.

    Returns None to let the agent continue normally.
    """
    auth = callback_context.state.get('pingone_authorization', '')
    logging.info(f'inject_mcp_auth: auth_present={bool(auth)}')
    if not auth:
        # No token in session state — MCP tools not available this turn.
        return None

    # Strip "Bearer " prefix before using as subject_token in the exchange.
    agent_token = auth.removeprefix('Bearer ').strip()

    try:
        mcp_token = _exchange_for_mcp_token(agent_token)
        mcp_auth  = f'Bearer {mcp_token}'
    except Exception as exc:
        # Do NOT fall back to the agent_token — it carries the wrong audience
        # for MCP calls and would be rejected by the MCP server.
        logging.error(f'inject_mcp_auth: exchange failed — {exc}. MCP tools unavailable this turn.')
        return None

    agent = callback_context._invocation_context.agent
    non_mcp = [t for t in agent.tools if not isinstance(t, McpToolset)]
    agent.tools = non_mcp + [
        McpToolset(
            connection_params=StreamableHTTPConnectionParams(
                url=MCP_URL,
                headers={'Authorization': mcp_auth},
            )
        )
    ]
    return None


root_agent = llm_agent.LlmAgent(
    name='NotFlux',
    model='gemini-2.5-pro',
    description='AI Assistant for the NotFlux media streaming service',
    sub_agents=[],
    instruction=(
        'You are a helpful assistant for a media streaming service called NotFlux.\n\n'
        'HITL / STEP-UP AUTH RULES — follow these strictly:\n'
        '- Some tool calls may return a JSON object with hitl_required=true. This is not a final failure.\n'
        '- When hitl_required=true, do NOT paraphrase it into plain text.\n'
        '- Instead, respond with the challenge JSON object unchanged so the client can render HITL UI.\n'
        '- After the client provides verification details, retry the same tool call.\n'
        '- On retry, pass transaction_id and otp_code as tool arguments alongside original tool inputs.\n'
        '- Never ask the user to provide transaction_id manually.\n\n'
        'TOOL USE RULES — follow these strictly:\n'
        '- For ANY question about what content is available on this service, what the user '
        'can watch, or details about specific titles IN this service\'s catalogue: '
        'call get_all_media_metadata or get_media_metadata. Never answer from your own '
        'knowledge about what is "available" — you do not know what is in this catalogue.\n'
        '- For ANY question about the user\'s account, profile, or subscription: '
        'call get_account.\n'
        '- For general entertainment knowledge (e.g. "what is the IMDB rating of MASH", '
        '"who directed Inception"): answer from your own knowledge without calling tools.\n\n'
        'DECISION GUIDE:\n'
        '"What can I watch tonight?" → call get_all_media_metadata\n'
        '"Do you have any action movies?" → call get_all_media_metadata\n'
        '"Tell me about [title] on your service" → call get_media_metadata\n'
        '"What is my account name?" → call get_account\n'
        '"What is the TV show MASH rated?" → answer from knowledge\n'
    ),
    before_agent_callback=inject_mcp_auth,
    tools=[
        # No McpToolset here — inject_mcp_auth adds one with the
        # session's mcp_token before every turn.
    ],
)

# root_agent is exported for deploy.py to wrap in AdkApp after vertexai.init().
