"""Bisection probe — deploy the barest possible ADK agent to Agent Engine.

Purpose: isolate whether the "failed to start / cannot serve traffic" (with no
serving logs) is caused by something in agent.py, or by the runtime environment
itself (Python 3.14 image, project, service account).

  - If THIS deploys and starts cleanly  -> the environment is fine; the problem
    is in agent.py. We add pieces back (MCP import, callback, token code) until
    it breaks.
  - If THIS also fails to start          -> the problem is environmental, not
    your code. Next step: rebuild the venv on Python 3.12 and retry.

There is deliberately NO McpToolset, NO before_agent_callback, NO token logging,
NO extra_packages here. root_agent is defined inline so it pickles by value with
no module import on the runtime.

Run:  python deploy_minimal.py
"""

import vertexai
from vertexai.agent_engines import AgentEngine, AdkApp
from google.adk.agents import llm_agent

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

PROJECT_ID = 'cprice---agentic-demos'
LOCATION = 'us-west1'
STAGING_BUCKET = 'gs://notflux-agent-staging'

# Same pinned, resolvable set as deploy.py — this run is only testing the
# environment + a bare agent, so any startup failure here is NOT about deps.
REQUIREMENTS = [
    'google-cloud-aiplatform[adk,reasoningengine]==1.162.0',
    'google-adk==2.5.0',
    'google-genai==2.14.0',
    'pydantic==2.13.4',
    'cloudpickle==3.1.2',
]

root_agent = llm_agent.LlmAgent(
    name='NotFluxMinimal',
    model='gemini-2.5-pro',
    description='Minimal bisection agent',
    instruction='You are a helpful assistant. Answer briefly.',
)

if __name__ == '__main__':
    vertexai.init(project=PROJECT_ID, location=LOCATION, staging_bucket=STAGING_BUCKET)
    app = AdkApp(agent=root_agent)
    engine = AgentEngine.create(
        app,
        requirements=REQUIREMENTS,
        display_name='NotFlux-Minimal-Bisect',
        description='Minimal agent to isolate the startup failure',
    )
    print(f'Created: {engine.resource_name}')
    print('If this engine starts cleanly, the environment is fine and the')
    print('problem is in agent.py. If it also fails to start, it is environmental.')
