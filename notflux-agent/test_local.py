"""Reproduce the Agent Engine startup sequence LOCALLY — no cloud round-trip.

This runs the same lifecycle the managed runtime runs when it boots your engine:
it imports agent.py, wraps root_agent in AdkApp, calls set_up(), and issues a
query. If the agent crashes or hangs at startup, it happens HERE with a full
Python traceback — in seconds — instead of a silent "failed to start" in the
cloud five minutes later.

Because your local venv is now pinned to the same versions as the runtime
(aiplatform 1.162.0, adk 2.5.0, genai 2.14.0), this is a faithful reproduction.

Prereqs (you already have these — you've been deploying):
    gcloud auth application-default login   # for the Gemini model call

Run:
    python test_local.py
"""

import vertexai
from vertexai.agent_engines import AdkApp

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

from agent import root_agent

PROJECT_ID = 'cprice---agentic-demos'
LOCATION = 'us-west1'

vertexai.init(project=PROJECT_ID, location=LOCATION)

print('1) Wrapping root_agent in AdkApp …')
app = AdkApp(agent=root_agent)

print('2) Calling set_up() — this is what the runtime does at boot …')
app.set_up()

print('3) register_operations():', app.register_operations())

print('4) Issuing a test query (no MCP token in state — MCP tools skip) …')
for event in app.stream_query(user_id='local-test', message='Say hello in five words.'):
    print('   event:', event)

print('\nOK — the agent started and answered locally. If deployment still fails')
print('to start, the fault is environmental (runtime image), not the agent code.')
