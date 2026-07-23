"""Deploy or update the NotFlux agent on Vertex AI Agent Engine.

Uses ADK directly — not Agent Studio — so we can attach before_agent_callback
to inject per-session MCP auth headers from Vertex session state.

Prerequisites:
    pip install -r requirements.txt
    gcloud auth application-default login

Usage:
    # First deployment — creates a new Reasoning Engine:
    python deploy.py --create

    # Update existing agent (retains the same resource ID, no need to
    # reconfigure the NotFlux App backend VERTEX_AGENT_RESOURCE):
    python deploy.py --update 7712115294709219328
"""

import argparse
import os
import vertexai
from vertexai.agent_engines import AgentEngine, AdkApp

# Load .env file if present (install python-dotenv in your venv to use this).
# Values can also be exported in the shell before running this script.
try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

# Change to the script's directory so extra_packages relative paths resolve correctly.
# This ensures 'agent.py' is bundled as 'agent.py' (not a deep absolute path)
# in the tar uploaded to the staging bucket.
os.chdir(os.path.dirname(os.path.abspath(__file__)))

from agent import root_agent

PROJECT_ID = 'cprice---agentic-demos'
LOCATION = 'us-west1'
STAGING_BUCKET = 'gs://notflux-agent-staging'  # must exist in the project

# NOTE: agent.py imports McpToolset from google.adk.tools.mcp_tool, which needs
# the `mcp` package. That package is ONLY pulled in by the google-adk[mcp] extra
# — neither plain `google-adk` nor aiplatform's [adk] extra installs it. If it is
# missing from this list, the Agent Engine container installs an ADK without mcp,
# `import agent` raises ModuleNotFoundError at startup, and create() fails with
# "Reasoning Engine ... failed to start and cannot serve traffic". So the [mcp]
# extra here is load-bearing, not cosmetic.
REQUIREMENTS = [
    # Agent Engine loads code.pkl inside an isolated runtime venv. cloudpickle is
    # version-sensitive: if the runtime installs a NEWER build of any library that
    # a pickled object depends on than the one that CREATED the pickle, the load
    # crashes before uvicorn starts — the engine "failed to start and cannot serve
    # traffic" with no serving logs. So every dependency here is pinned to the exact
    # version in the local venv that ran deploy.py (see `pip freeze`).
    #
    #   - google-cloud-aiplatform provides vertexai.agent_engines.templates.adk,
    #     the AdkApp class the pickle is an instance of, so its version must match
    #     the LOCAL venv that ran deploy.py — otherwise the runtime can't unpickle.
    #     Pinned to 1.162.0 (NOT 1.152.0): aiplatform 1.152.0 declares google-genai
    #     <2.0.0, which conflicts with google-adk 2.5.0's genai 2.x and makes the
    #     runtime pip resolve fail (ResolutionImpossible). 1.162.0 allows genai<3.0.
    #     IMPORTANT: keep your local aiplatform at 1.162.0 too and re-run deploy.py
    #     so the pickle is created with the same version the runtime installs.
    #     The [adk,reasoningengine] extras are required (they pull the serving deps).
    #   - google-adk is NON-NEGOTIABLE: root_agent is a google.adk LlmAgent, so the
    #     runtime literally cannot unpickle the agent without ADK installed. The
    #     [mcp] extra pulls the `mcp` package that agent.py's McpToolset imports.
    #   - google-genai 2.14.0 satisfies aiplatform 1.162.0 (<3.0.0) and google-adk
    #     2.5.0; it's the version already in the local venv.
    'google-cloud-aiplatform[adk,reasoningengine]==1.162.0',
    'google-adk[mcp]==2.5.0',
    'google-genai==2.14.0',
    'pydantic==2.13.4',
    'cloudpickle==3.1.2',
    'requests>=2.32.0',    # Exchange 2: agent_token -> mcp_token via PingOne
]

# ---------------------------------------------------------------------------
# PingOne Token Exchange env vars injected into the Agent Engine runtime.
# Values are read from the environment (or notflux-agent/.env — gitignored).
# See .env.example for the required keys.
# ---------------------------------------------------------------------------
AGENT_ENV_VARS = {
    'PINGONE_ENV_ID':         os.getenv('PINGONE_ENV_ID', ''),
    'PINGONE_CLIENT_ID':      os.getenv('PINGONE_CLIENT_ID', ''),
    'PINGONE_CLIENT_SECRET':  os.getenv('PINGONE_CLIENT_SECRET', ''),
    'PINGONE_AGENT_AUDIENCE': os.getenv('PINGONE_AGENT_AUDIENCE', ''),
    'PINGONE_MCP_SCOPE':      os.getenv('PINGONE_MCP_SCOPE', ''),
    # VERTEX_REASONING_ENGINE_ID is NOT injected here — Vertex does not expose
    # the engine's own resource ID to its runtime automatically, and passing it
    # at create-time creates a chicken-and-egg problem.  _get_vertex_agent_id()
    # in agent.py constructs a partial identifier from GOOGLE_CLOUD_PROJECT and
    # GOOGLE_CLOUD_LOCATION, which GCP does set in the managed runtime.
}


def create_agent() -> AgentEngine:
    vertexai.init(project=PROJECT_ID, location=LOCATION, staging_bucket=STAGING_BUCKET)
    app = AdkApp(agent=root_agent)
    engine = AgentEngine.create(
        app,
        requirements=REQUIREMENTS,
        extra_packages=['agent.py'],
        display_name='NotFlux',
        description='NotFlux AI assistant with PingOne Token Exchange for MCP access',
        env_vars=AGENT_ENV_VARS,
    )
    resource_id = engine.resource_name.split('/')[-1]
    print(f'Created: {engine.resource_name}')
    print(f'Resource ID: {resource_id}')
    print(f'\nUpdate VERTEX_AGENT_RESOURCE in notflux-app/backend/.env:')
    print(f'  projects/{PROJECT_ID}/locations/{LOCATION}/reasoningEngines/{resource_id}')
    return engine


def update_agent(resource_id: str) -> AgentEngine:
    vertexai.init(project=PROJECT_ID, location=LOCATION, staging_bucket=STAGING_BUCKET)
    app = AdkApp(agent=root_agent)
    engine = AgentEngine(resource_id)
    engine.update(
        agent_engine=app,
        requirements=REQUIREMENTS,
        extra_packages=['agent.py'],
        env_vars=AGENT_ENV_VARS,
    )
    print(f'Updated: {engine.resource_name}')
    return engine


def recreate_agent(resource_id: str) -> AgentEngine:
    """Delete an existing engine and create a fresh one.

    Use this when the existing engine was created via Agent Studio
    (spec.deployment_source) and cannot be updated with spec.package_spec.
    The new engine will have a different resource ID — update
    VERTEX_AGENT_RESOURCE in notflux-app/backend/.env accordingly.
    """
    vertexai.init(project=PROJECT_ID, location=LOCATION, staging_bucket=STAGING_BUCKET)
    print(f'Deleting engine {resource_id} …')
    AgentEngine(resource_id).delete(force=True)
    print('Deleted. Creating replacement …')
    return create_agent()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Deploy NotFlux agent to Vertex AI Agent Engine')
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument('--create', action='store_true', help='Create a new agent')
    group.add_argument('--update', metavar='RESOURCE_ID', help='Update existing agent by resource ID')
    group.add_argument('--recreate', metavar='RESOURCE_ID', help='Delete existing agent and create a fresh one (use when switching from Studio deployment)')
    args = parser.parse_args()

    if args.create:
        create_agent()
    elif args.recreate:
        recreate_agent(args.recreate)
    else:
        update_agent(args.update)
