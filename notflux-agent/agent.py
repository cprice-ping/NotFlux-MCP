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
"""

from typing import Any, Optional

from google.adk.agents import llm_agent
from google.adk.agents.callback_context import CallbackContext
from google.adk.sessions import vertex_ai_session_service
from google.adk.tools.mcp_tool.mcp_session_manager import StreamableHTTPConnectionParams
from google.adk.tools.mcp_tool.mcp_toolset import McpToolset
from google.adk.tools import agent_tool
from google.adk.tools.google_search_tool import GoogleSearchTool
from google.adk.tools import url_context
from google.genai import types
from vertexai.preview.reasoning_engines import AdkApp

VertexAiSessionService = vertex_ai_session_service.VertexAiSessionService

MCP_URL = 'https://notflux-mcp.ping-devops.com/mcp'


def inject_mcp_auth(callback_context: CallbackContext) -> Optional[types.Content]:
    """Rebuild the McpToolset with the session's current mcp_token before each turn.

    The NotFlux App backend writes pingone_authorization into Vertex session
    state on every /api/sessions and /api/chat call (via stateDelta) so the
    token stays fresh across turns.

    McpToolset.get_tools() establishes the MCP connection lazily (after this
    callback returns), so replacing the toolset here — before tool resolution —
    ensures the correct Authorization header is used for this turn's MCP calls.

    Returns None to let the agent continue normally.
    """
    auth = callback_context.state.get('pingone_authorization', '')
    if not auth:
        return None

    agent = callback_context.agent
    agent.tools = [
        McpToolset(
            connection_params=StreamableHTTPConnectionParams(
                url=MCP_URL,
                headers={'Authorization': auth},
            )
        ) if isinstance(t, McpToolset) else t
        for t in agent.tools
    ]
    return None


class AgentClass:

    def __init__(self):
        self.app = None

    def session_service_builder(self):
        return VertexAiSessionService()

    def set_up(self):
        """Sets up the ADK application.

        McpToolset is included here without auth headers as a placeholder.
        The inject_mcp_auth before_agent_callback replaces it with an
        authenticated instance on every turn using the mcp_token from
        Vertex session state.
        """
        not_flux_google_search_agent = llm_agent.LlmAgent(
            name='NotFlux_google_search_agent',
            model='gemini-2.5-pro',
            description='Agent specialized in performing Google searches.',
            sub_agents=[],
            instruction='Use the GoogleSearchTool to find information on the web.',
            tools=[GoogleSearchTool()],
        )

        not_flux_url_context_agent = llm_agent.LlmAgent(
            name='NotFlux_url_context_agent',
            model='gemini-2.5-pro',
            description='Agent specialized in fetching content from URLs.',
            sub_agents=[],
            instruction='Use the UrlContextTool to retrieve content from provided URLs.',
            tools=[url_context],
        )

        root_agent = llm_agent.LlmAgent(
            name='NotFlux',
            model='gemini-2.5-pro',
            description='AI Assistant to the Media APIs used by my old NotFlux demo',
            sub_agents=[],
            instruction=(
                'You are a helpful assistant for a media streaming service.\n\n'
                'Things that are within your scope are:\n'
                'Questions about tv shows / movies\n'
                'Correlation between Person constraints and those media (particularly the Ratings)\n'
                'Questions about the Account / Profile'
            ),
            # Injects per-session Bearer token into the MCP connection before
            # each turn.  See inject_mcp_auth above for full explanation.
            before_agent_callback=inject_mcp_auth,
            tools=[
                agent_tool.AgentTool(agent=not_flux_google_search_agent),
                agent_tool.AgentTool(agent=not_flux_url_context_agent),
                # Unauthenticated placeholder — replaced by inject_mcp_auth
                # with an auth-bearing instance using the session's mcp_token.
                McpToolset(
                    connection_params=StreamableHTTPConnectionParams(
                        url=MCP_URL,
                    )
                ),
            ],
        )

        self.app = AdkApp(
            agent=root_agent,
            session_service_builder=self.session_service_builder,
        )

    async def stream_query(self, query: str, user_id: str = 'test') -> Any:
        """Streaming query."""
        async for chunk in self.app.async_stream_query(
            message=query,
            user_id=user_id,
        ):
            yield chunk


app = AgentClass()
