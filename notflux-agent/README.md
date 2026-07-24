# NotFlux Agent — Vertex AI Agent Engine deployment

The NotFlux ADK agent, deployed directly to Vertex AI Agent Engine (not Agent
Studio) so it can attach a `before_agent_callback` that injects per-session MCP
auth and run RFC 8693 token exchanges. This is the deployment runbook.

---

## Prerequisites

- **Python 3.12 or 3.13 — NOT 3.14.** Agent Engine builds a runtime image
  matching your local Python minor version. The `assembly-service-py314` image
  is too new: a provably-working app fails to boot in it with *"failed to start
  and cannot serve traffic"* and **no serving logs**. Build on 3.12.
  ```bash
  python3.12 -m venv .venv && source .venv/bin/activate
  ```
- **Google Cloud auth** for the deploying user:
  ```bash
  gcloud auth application-default login
  ```
- **A staging bucket** that already exists in the project (`gs://notflux-agent-staging`).
- Dependencies:
  ```bash
  pip install -r requirements.txt python-dotenv
  ```

### Why the dependencies are pinned

`REQUIREMENTS` in `deploy.py` and `requirements.txt` pin every library to the
exact version in your local venv. Agent Engine cloudpickles the app locally and
unpickles it in the runtime; cloudpickle is version-sensitive, so if the runtime
installs a newer build than the one that created the pickle, the load crashes
before uvicorn starts. Keep local and runtime identical. In particular:

- `google-cloud-aiplatform[adk,reasoningengine]==1.162.0` — defines the `AdkApp`
  class the pickle is an instance of. (1.152.0 conflicts: it requires
  `google-genai<2.0.0`, which breaks against `google-adk 2.5.0`.)
- `google-adk[mcp]==2.5.0` — **required**: `root_agent` is a `google.adk`
  `LlmAgent`, so the runtime cannot unpickle it without ADK. The `[mcp]` extra
  pulls the `mcp` package `agent.py`'s `McpToolset` imports.

If you upgrade a library locally, update both files to match and re-deploy.

---

## One-time GCP setup — per-agent runtime identity

By default the engine runs as Google's shared, project-level Agent Engine service
agent (`service-<PROJECT_NUMBER>@gcp-sa-aiplatform-re.iam.gserviceaccount.com`),
which is identical for every engine in the project. To give an agent its **own**
persistent identity — the Agent Identifier presented to the token provider in the
3rd-party exchange — run it as a user-managed service account.

Do this once per agent (substitute your project and SA name):

```bash
PROJECT=cprice---agentic-demos
PROJECT_NUMBER=3682147732           # gcloud projects describe $PROJECT --format='value(projectNumber)'
SA=notflux-agent@${PROJECT}.iam.gserviceaccount.com

# 1. Create the service account
gcloud iam service-accounts create notflux-agent \
  --project=$PROJECT --display-name="NotFlux Agent runtime identity"

# 2. Let the Agent Engine service agent run AS your SA (required, or deploy fails)
gcloud iam service-accounts add-iam-policy-binding $SA \
  --member="serviceAccount:service-${PROJECT_NUMBER}@gcp-sa-aiplatform-re.iam.gserviceaccount.com" \
  --role="roles/iam.serviceAccountUser"

# 3. Give the SA what the agent needs at runtime (the Gemini model call)
gcloud projects add-iam-policy-binding $PROJECT \
  --member="serviceAccount:${SA}" \
  --role="roles/aiplatform.user"
```

Then point the deploy at it:

```bash
echo "AGENT_SERVICE_ACCOUNT=${SA}" >> .env
```

The identity is stable across both `--update` and `--create` (it is your SA, not
tied to the engine's resource ID). Leave `AGENT_SERVICE_ACCOUNT` blank to use the
managed default.

---

## Configure `.env`

Copy `.env.example` to `.env` (gitignored) and fill in the values:

| Variable | Purpose |
|---|---|
| `PINGONE_ENV_ID` | PingOne environment for the token exchange |
| `PINGONE_CLIENT_ID` / `PINGONE_CLIENT_SECRET` | Confidential client for Exchange 2 (agent_token → mcp_token) |
| `PINGONE_AGENT_AUDIENCE` | `aud` the agent validates on the incoming agent_token |
| `PINGONE_MCP_SCOPE` | Scope requested in Exchange 2 (maps to the MCP resource server aud) |
| `AGENT_SERVICE_ACCOUNT` | Runtime SA = the per-agent Agent Identifier (see above) |
| `MCP_URL` | Override the MCP/gateway endpoint (default: the PingGateway edge) |

---

## Deploy

```bash
# Confirm it boots locally FIRST (~10s, full traceback on failure):
python test_roundtrip.py

# Create a new engine (mints a new resource ID):
python deploy.py --create

# Update an existing engine in place (keeps the resource ID, so the backend
# VERTEX_AGENT_RESOURCE does not change):
python deploy.py --update <RESOURCE_ID>

# Replace a Studio-created engine that cannot be updated in place:
python deploy.py --recreate <RESOURCE_ID>
```

`deploy.py` prints the runtime identity it used and, on `--create`, the exact
`VERTEX_AGENT_RESOURCE` line to set. **After `--create`, update
`notflux-app/backend/.env`** with the new resource path or the app keeps calling
the old engine.

---

## Local testing (fast feedback, no cloud round-trip)

The cloud loop is ~5 minutes and, on a boot failure, gives no logs. These probes
reproduce the runtime boot locally in seconds:

| Script | What it exercises |
|---|---|
| `test_local.py` | `AdkApp.set_up()` + a query against the live agent |
| `test_roundtrip.py` | Full boot including the cloudpickle `dumps`/`loads` the runtime performs |
| `deploy_minimal.py` | Deploys a bare `LlmAgent` — bisects code faults vs environment faults |

Run `test_roundtrip.py` before every deploy; if it's green the code and pickle
are good and any cloud failure is environmental (usually the Python version).

---

## Watch the deployed agent

```bash
# Live tail (needs the gcloud alpha component):
gcloud alpha logging tail \
  'resource.type="aiplatform.googleapis.com/ReasoningEngine"
   AND resource.labels.reasoning_engine_id="<RESOURCE_ID>"' \
  --project=cprice---agentic-demos \
  --format='value(timestamp, severity, textPayload, jsonPayload.message)'

# Recent serving logs (exclude the image-build stream):
gcloud logging read \
  'resource.type="aiplatform.googleapis.com/ReasoningEngine"
   AND resource.labels.reasoning_engine_id="<RESOURCE_ID>"
   AND NOT logName:"reasoning_engine_build"' \
  --project=cprice---agentic-demos --freshness=30m --order=desc --limit=100 \
  --format='value(timestamp, severity, textPayload, jsonPayload.message)'
```

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `ModuleNotFoundError: No module named 'mcp'` at startup | `mcp` not installed | Use the `google-adk[mcp]` extra in `REQUIREMENTS` |
| "failed to start", no serving logs, `google-adk` absent from the requirements | Can't unpickle the `LlmAgent` | Keep `google-adk[mcp]` in `REQUIREMENTS` |
| `ResolutionImpossible` in the build log, mentions `google-genai` | `aiplatform 1.152.0` requires `genai<2.0.0` | Pin `aiplatform==1.162.0` (allows `genai<3.0.0`) |
| "failed to start", no serving logs, deps all correct | py314 runtime image | Rebuild the venv on Python 3.12 and re-deploy |
| Deploy fails with a permission / `actAs` error | Custom SA prereqs missing | Grant the AE service agent `roles/iam.serviceAccountUser` on the SA |

Confirm the code itself is fine with `python test_roundtrip.py` before chasing a
cloud failure — if it's green locally, the fault is environmental.

---

## A second agent for a different IdP (e.g. PingFed)

If the gateway (PingGateway) accepts tokens from more than one IdP on the same
routes, you do **not** need a fork or a second gateway. Deploy this same code a
second time with a different `.env`; the two agents share the PingGateway routes
and differ only in configuration. Switching which one notflux-app targets stays a
single `VERTEX_AGENT_RESOURCE` change in the backend `.env`.

What differs between the two deployments — all env, no code:

- **Token endpoint:** set `TOKEN_EXCHANGE_ENDPOINT=https://<pingfed-host>/as/token`.
  Blank keeps the PingOne default. `agent.py` uses this for both Exchange 2 and
  the workload-identity audience.
- **Exchange 2 client / audience / scope:** put the PingFed client and values in
  `PINGONE_CLIENT_ID` / `PINGONE_CLIENT_SECRET` / `PINGONE_AGENT_AUDIENCE` /
  `PINGONE_MCP_SCOPE` (the names are historical — they're just "the Exchange 2
  client" for whichever endpoint you point at).
- **Identity:** a **distinct** service account (e.g. `pingfed-agent@…`) via
  `AGENT_SERVICE_ACCOUNT`, so PingFed sees its own stable Agent Identifier.
- **Display name:** change `display_name='NotFlux'` in `create_agent()` so the two
  engines are distinguishable in the console.
- **Gateway:** unchanged — same `MCP_URL`, since PingGateway fronts both.

Both agents run in the same project simultaneously; the per-agent service account
keeps their identities distinct.

> **Verify PingFed's exchange request shape.** `TOKEN_EXCHANGE_ENDPOINT` fixes the
> URL, but the RFC 8693 request body in `_exchange_for_mcp_token` is written for
> PingOne: `client_secret_basic` auth, a `scope` parameter, and a custom `agent_id`
> claim. PingFed may expect `resource`/`audience` instead of `scope`, a different
> client-auth method, or may not accept the `agent_id` param. Confirm against
> PingFed's token-exchange policy and adjust the payload if needed — that is the
> one spot that may still need a code tweak.
