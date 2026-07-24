"""Reproduce the FULL Agent Engine boot, including the cloudpickle round-trip.

test_local.py proved the live agent works. But the managed runtime does one more
thing that test never did: it cloudpickle-dumps the AdkApp, uploads it, and
cloudpickle-LOADS it in a fresh process before calling set_up(). If the crash is
in that (de)serialization step, this script reproduces it locally, in seconds,
with a real traceback.

Run:
    python test_roundtrip.py
"""

import cloudpickle
import vertexai
from vertexai.agent_engines import AdkApp

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

from agent import root_agent

vertexai.init(project='cprice---agentic-demos', location='us-west1')

print('1) Building AdkApp and cloudpickle.dumps() — what deploy.py does …')
app = AdkApp(agent=root_agent)
blob = cloudpickle.dumps(app)
print(f'   pickled OK: {len(blob)} bytes')

print('2) cloudpickle.loads() in this process — what the runtime does at boot …')
app2 = cloudpickle.loads(blob)
print('   unpickled OK')

print('3) set_up() on the UN-pickled app …')
app2.set_up()
print('   set_up OK')

print('4) Query the un-pickled app …')
for event in app2.stream_query(user_id='roundtrip-test', message='Say hello in five words.'):
    parts = event.get('content', {}).get('parts', [{}])
    print('   reply:', parts[0].get('text'))

print('\nOK — the pickle round-trip works locally too. If the cloud STILL fails')
print('to start, the fault is the py314 runtime image itself → rebuild on 3.12.')
