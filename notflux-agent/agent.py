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
    person_token ──[Exchange 1]──────►  pingone_authorization: "Bearer mcp_token"
    → mcp_token                                       │
                                                      │  inject_mcp_auth reads
                                                      │  state on every turn
                                                      ▼
  POST /api/chat                        McpToolset(headers={"Authorization": mcp_token})
    message ─────────────────────────►                │
                                                      ▼
                                        MCP Server validates aud=notflux-mcp
                                        Exchange 2: mcp_token → api_token
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

import logging
from typing import Optional

from google.adk.agents import llm_agent
from google.adk.agents.callback_context import CallbackContext
from google.adk.tools.mcp_tool.mcp_session_manager import StreamableHTTPConnectionParams
from google.adk.tools.mcp_tool.mcp_toolset import McpToolset
from google.genai import types

MCP_URL = 'https://notflux-mcp.ping-devops.com/mcp?rev=2'


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

    agent = callback_context._invocation_context.agent
    non_mcp = [t for t in agent.tools if not isinstance(t, McpToolset)]
    agent.tools = non_mcp + [
        McpToolset(
            connection_params=StreamableHTTPConnectionParams(
                url=MCP_URL,
                headers={'Authorization': auth},
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
