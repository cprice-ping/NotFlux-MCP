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

PROJECT_ID = '3682147732'
LOCATION = 'us-west1'
STAGING_BUCKET = 'gs://notflux-agent-staging'  # must exist in the project

REQUIREMENTS = [
    'google-cloud-aiplatform[adk,reasoningengine]',
    'google-adk>=0.4.0',
    'requests>=2.32.0',    # Exchange 2: agent_token -> mcp_token via PingOne
]

# ---------------------------------------------------------------------------
# PingOne Token Exchange env vars injected into the Agent Engine runtime.
# Values are read from the environment (or notflux-agent/.env — gitignored).
# See .env.example for the required keys.
# ---------------------------------------------------------------------------
AGENT_ENV_VARS = {
    'PINGONE_ENV_ID':             os.getenv('PINGONE_ENV_ID', ''),
    'PINGONE_CLIENT_ID':          os.getenv('PINGONE_CLIENT_ID', ''),
    'PINGONE_CLIENT_SECRET':      os.getenv('PINGONE_CLIENT_SECRET', ''),
    'PINGONE_AGENT_AUDIENCE':     os.getenv('PINGONE_AGENT_AUDIENCE', ''),
    'PINGONE_MCP_AUDIENCE':       os.getenv('PINGONE_MCP_AUDIENCE', ''),
    'VERTEX_REASONING_ENGINE_ID': os.getenv('VERTEX_REASONING_ENGINE_ID', ''),
}


def create_agent() -> AgentEngine:
    vertexai.init(project=PROJECT_ID, location=LOCATION, staging_bucket=STAGING_BUCKET)
    app = AdkApp(agent=root_agent)
    engine = AgentEngine.create(
        app,
        requirements=REQUIREMENTS,
        extra_packages=['agent.py'],
        display_name='NotFlux',
        description='NotFlux AI assistant with per-session authenticated MCP tool access',
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


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Deploy NotFlux agent to Vertex AI Agent Engine')
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument('--create', action='store_true', help='Create a new agent')
    group.add_argument('--update', metavar='RESOURCE_ID', help='Update existing agent by resource ID')
    args = parser.parse_args()

    if args.create:
        create_agent()
    else:
        update_agent(args.update)
