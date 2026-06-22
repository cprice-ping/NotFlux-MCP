---
name: PingGateway MCP Gateway Builder
description: Configures and deploys PingGateway as an MCP security gateway in front of one or more existing MCP servers. Use when Glean or a coding agent needs to add or update PingGateway routes, token validation, token exchange, Docker localhost deployment, Kubernetes deployment, optional PingOne Authorize or PingAuthorize integration, logging, or troubleshooting for MCP gateway topologies.
---
# Purpose

Use this skill when the user already has an agent and one or more MCP servers, and wants PingGateway configured as the protected MCP entrypoint.

The skill assumes:
- the agent and MCP server already exist
- PingGateway is the gateway product to deploy and configure
- the gateway may run on localhost via Docker or in Kubernetes
- inbound token validation may use introspection or stateless validation depending on the provider
- gateway-to-backend token exchange should prefer product-native PingGateway filters over custom scripts when possible
- optional Authorize integration may be added for policy decisions

# What this skill should produce

Produce the exact files and changes needed for the target repo or deployment bundle, such as:
- PingGateway route JSON
- admin.json
- logback.xml when better logs are needed
- Docker Compose or Docker run instructions for localhost
- Kubernetes ConfigMap, Secret, Deployment, Service, and Ingress changes
- environment variable list
- rollout and validation commands
- a short explanation of why the chosen topology and filter chain are correct

Prefer concrete file contents over prose.

# First decisions

Before writing config, determine these four things from the repo, manifests, and user request:

1. Topology
- single MCP server
- multiple MCP servers

2. Deployment target
- localhost with Docker
- Kubernetes

3. Inbound token validation mode
- PingAM-issued stateless token validation
- non-AM token validation via introspection
- other provider-specific validation already present in the architecture

4. Optional policy layer
- no Authorize integration
- P1AZ integration
- PAZ standalone integration

If the architecture already exists, adapt to it instead of redesigning it.

# Core architecture rules

## 1. Treat PingGateway as the public MCP resource

Use PingGateway as the externally reachable MCP endpoint. The agent should call PingGateway, not the backend MCP server directly.

Model:
- Agent -> PingGateway
- PingGateway validates inbound token
- PingGateway optionally performs token exchange for the backend hop
- PingGateway proxies to backend MCP server
- backend MCP server may still perform its own downstream exchange if the architecture already requires it

## 2. Prefer product-native filters

Prefer built-in PingGateway config over custom Groovy whenever product config can do the job.

Preferred order:
1. built-in PingGateway filter or handler
2. small header manipulation filter
3. script only if product config cannot express the requirement cleanly

For gateway-to-backend token exchange, prefer `OAuth2TokenExchangeFilter` over custom Groovy.

### OAuth2TokenExchangeFilter support pattern

The filter usually needs supporting heap objects for client authentication, failure handling, and outbound Authorization header rewriting. Use this pattern as the default starting point:

```json
"heap": [
 {
  "name": "SecretsStore",
  "type": "SystemAndEnvSecretStore",
  "config": { "format": "PLAIN" }
 },
 {
  "name": "TokenExchangeEndpointHandler",
  "type": "Chain",
  "config": {
   "filters": [
    {
     "name": "TokenExchangeClientAuth",
     "type": "ClientSecretBasicAuthenticationFilter",
     "config": {
      "clientId": "${env['TE_CLIENT_ID']}",
      "clientSecretId": "te.client.secret",
      "secretsProvider": "SecretsStore"
     }
    }
   ],
   "handler": { "type": "ClientHandler" }
  }
 },
 {
  "name": "TokenExchangeFailureHandler",
  "type": "StaticResponseHandler",
  "config": {
   "status": 401,
   "headers": { "Content-Type": [ "application/json" ] },
   "entity": "{\"error\":\"${contexts.oauth2Failure.error}\"}"
  }
 }
],
"handler": {
 "type": "Chain",
 "config": {
  "filters": [
   {
    "name": "GatewayToBackendTokenExchange",
    "type": "OAuth2TokenExchangeFilter",
    "config": {
     "endpoint": "&{authorizationServerUri}/token",
     "endpointHandler": "TokenExchangeEndpointHandler",
     "failureHandler": "TokenExchangeFailureHandler",
     "subjectToken": "#{request.headers['Authorization'][0].substring(7)}",
     "subjectTokenType": "urn:ietf:params:oauth:token-type:access_token",
     "requestedTokenType": "urn:ietf:params:oauth:token-type:access_token",
     "scopes": [ "&{mcpServerScope}" ],
     "audience": "&{mcpServerAudience}"
    }
   },
   {
    "type": "HeaderFilter",
    "config": {
     "messageType": "request",
     "remove": [ "Authorization" ],
     "add": {
      "Authorization": [ "Bearer ${contexts.oauth2TokenExchange.issuedToken}" ]
     }
    }
   }
  ],
  "handler": { "type": "ReverseProxyHandler" }
 }
}
```

### API key backend hop pattern

When the backend MCP server authenticates inbound requests using a static API key (e.g. `X-Api-Key` header) instead of a Bearer token, skip `OAuth2TokenExchangeFilter` entirely.

Use a `HeaderFilter` to:
1. Remove the inbound `Authorization` header (the gateway token must not reach the backend).
2. Add the backend-specific API key header.

```json
{
  "type": "HeaderFilter",
  "config": {
    "messageType": "request",
    "remove": [ "Authorization" ],
    "add": {
      "X-Api-Key": [ "${env['BACKEND_MCP_API_KEY']}" ]
    }
  }
}
```

Store the API key in a Kubernetes Secret alongside the other gateway secrets:

```yaml
# In the ping-gateway-secrets Secret:
BACKEND_MCP_API_KEY: "<base64-encoded-key>"
```

Reference it as an env var in the Deployment:

```yaml
env:
  - name: BACKEND_MCP_API_KEY
    valueFrom:
      secretKeyRef:
        name: ping-gateway-secrets
        key: BACKEND_MCP_API_KEY
```

The backend MCP server must also have its own Secret with the same key value so both sides agree. Store and deploy them separately — do not share a single Secret across gateway and backend deployments unless they are in the same namespace and that coupling is intentional.

Filter chain for API key backend hop (secondary route example):

```
UriPathRewriteFilter
  → "rsFilter"
    → McpValidationFilter
      → HeaderFilter (remove Authorization, add X-Api-Key)
        → ReverseProxyHandler
```

No `TokenExchangeEndpointHandler`, `TokenExchangeClientAuth`, or `TokenExchangeFailureHandler` are needed when the backend uses API key auth.

### SystemAndEnvSecretStore secret ID naming

With `"format": "PLAIN"`, `SystemAndEnvSecretStore` resolves a `clientSecretId` by uppercasing it and replacing dots with underscores. Use secret IDs that map cleanly to the environment variables available in the container.

Examples:
- `te.client.secret` -> `TE_CLIENT_SECRET`
- `oauth.introspect.client.secret` -> `OAUTH_INTROSPECT_CLIENT_SECRET`
- `pingone.te.client.secret` -> `PINGONE_TE_CLIENT_SECRET`

`clientSecretId` must be a label, not the raw secret value.

## 3. Use the correct inbound validation strategy

Choose inbound validation based on the issuer:

- If the inbound token is from PingAM and the architecture uses stateless JWT validation, use a stateless resolver pattern.
- If the inbound token is from PingOne or another non-AM provider and the route needs token introspection, use `TokenIntrospectionAccessTokenResolver` with the appropriate provider handler and client authentication.
- Do not pin validation to a single rotating signing key unless the architecture explicitly requires that.

## 4. Keep resource boundaries distinct

Use different resource identity and token expectations per hop:
- inbound agent token should be for the gateway resource
- gateway-to-MCP-server token should be for the backend MCP resource
- downstream API token should remain separate if the MCP server already exchanges again

Do not collapse hops unless the user explicitly wants that redesign.

# Single MCP server pattern

Use one route for the MCP server.

Recommended route flow:
1. ensure `admin.json` sets `"streamingEnabled": true` for SSE and MCP traffic
2. match `/mcp`
3. optional path rewrite
4. `McpProtectionFilter`
5. `McpValidationFilter`
6. `PingAuthorizeFilter` if policy decisioning is required (PingGateway 2026+ only)
7. `OAuth2TokenExchangeFilter` if backend token exchange is required
8. rewrite outbound `Authorization` header with the exchanged token
9. reverse proxy to the backend MCP server

`McpProtectionFilter.resourceId` must be the HTTPS URL for the public gateway MCP resource, and the inbound access token audience must match that resource ID. Example: if the public endpoint is `https://gateway.example.com/mcp`, use that exact HTTPS URL as `resourceId` and expect the agent token `aud` to match it.

Keep the route simple and deterministic.

# Multiple MCP server pattern

When multiple MCP servers exist, do not mix them in a single ambiguous route.

Prefer one of these patterns:

## Pattern A: path-based split
Examples:
- `/mcp/notflux`
- `/mcp/tools`
- `/mcp/internal`

Use one route per backend MCP server with its own:
- backend URL
- audience
- scope
- optional token exchange config
- optional Authorize policy config

## Pattern B: host-based split
Use only if the existing architecture already routes by host and the deployment environment supports it cleanly.

For each MCP server, keep backend identity isolated. Do not reuse the wrong audience or scope across servers.

## Single inbound token for multiple backend routes

The agent only needs one gateway token, regardless of how many backend MCP servers exist behind the gateway. This works because all routes share the same gateway resource ID — the inbound token's `aud` matches that one resource, and any route that validates via the same introspection/resource server config will accept the same token.

### McpProtectionFilter constraint — primary vs. secondary routes

`McpProtectionFilter` does two things at route build time:
1. Registers a `/.well-known/oauth-protected-resource/<path>` metadata endpoint.
2. Validates inbound tokens via introspection.

**Only one route per resource path may use `McpProtectionFilter`.** If two routes both use it with the same resource ID path, the second route throws `AlreadyRegisteredException` at startup and fails to load.

Design rule:
- Designate **one route as the primary route**. It uses `McpProtectionFilter` and owns the well-known registration.
- All other routes are **secondary routes**. They validate the inbound token using `OAuth2ResourceServerFilter` (heap object named `rsFilter` by convention) directly, without re-registering any well-known endpoint.

This means:
- one well-known registration covers all routes
- the agent sends the same token to every route
- secondary routes validate the token identically to the primary (same introspection endpoint, same scope)

### Primary route condition narrowing

When using path-based split, the primary route's condition must be narrowed to avoid matching secondary route paths. Use a negative lookahead to exclude the secondary paths:

```json
"condition": "${find(request.uri.path, '^/mcp(?!/weather)')}"
```

Without this, the primary route's broader condition (e.g. `^/mcp`) will match `/mcp/weather` before the secondary route is evaluated.

### rsFilter heap pattern

Define `rsFilter` as a named heap object in the secondary route's `heap` array:

```json
{
  "name": "rsFilter",
  "type": "OAuth2ResourceServerFilter",
  "config": {
    "accessTokenResolver": "RsFilterTokenResolver"
  }
}
```

Supporting heap objects required alongside `rsFilter`:

```json
{
  "name": "IntrospectionProviderHandler",
  "type": "Chain",
  "config": {
    "filters": [
      {
        "name": "IntrospectionClientAuth",
        "type": "ClientSecretBasicAuthenticationFilter",
        "config": {
          "clientId": "${env['INTROSPECT_CLIENT_ID']}",
          "clientSecretId": "introspect.client.secret",
          "secretsProvider": "SecretsStore"
        }
      }
    ],
    "handler": { "type": "ClientHandler" }
  }
},
{
  "name": "RsFilterTokenResolver",
  "type": "TokenIntrospectionAccessTokenResolver",
  "config": {
    "endpoint": "&{authorizationServerUri}/introspect",
    "providerHandler": "IntrospectionProviderHandler",
    "scopes": [ "&{agentFacingScope}" ]
  }
}
```

Reference `rsFilter` in the secondary route's filter chain as a bare string, not an inline object:

```json
"filters": [
  { "name": "PathRewrite", "type": "UriPathRewriteFilter", "config": { ... } },
  "rsFilter",
  { "name": "McpValidationFilter", "type": "McpValidationFilter" },
  ...
  { "type": "ReverseProxyHandler" }
]
```

Using the string `"rsFilter"` (bare heap reference) is required — wrapping it in an inline object would attempt to instantiate a second copy and may re-trigger the registration conflict.

### Secondary route filter chain

Full recommended filter chain for a secondary route (token validation, no well-known registration):

```
UriPathRewriteFilter (strip the sub-path prefix: /mcp/weather → /mcp)
  → "rsFilter"                  (validates inbound token via introspection)
    → PingAuthorizeFilter        (if P1AZ/PAZ is in use — must be before McpValidationFilter)
      → McpValidationFilter      (validates MCP protocol — consumes body; must run after P1AZ)
        → [HeaderFilter / TokenExchange] (backend hop auth — see below)
          → ReverseProxyHandler
```

**P1AZ on secondary routes**: `PingAuthorizeFilter` must be added to every route that should be policy-governed — it is not inherited from the primary route. A secondary route that omits `PingAuthorizeFilter` will bypass P1AZ entirely even though the primary route is protected. Add the same `PingAuthorizeFilter` + `P1AZDenyHandler` heap objects and filter-chain entry to each secondary route that needs policy enforcement.

The `P1AZDenyHandler` heap object is required in each route that uses `PingAuthorizeFilter`:

```json
{
  "name": "P1AZDenyHandler",
  "type": "StaticResponseHandler",
  "config": {
    "status": 403,
    "headers": { "Content-Type": [ "application/json" ] },
    "entity": "{\"error\":\"access_denied\",\"error_description\":\"Request denied by policy\"}"
  }
}
```

The `PingAuthorizeFilter` inline config is identical across routes — `gatewayServiceUri`, `secretsProvider`, `gatewayCredentialSecretId`, and `includeBodyContentTypes` are the same values. Only the route position (after `McpValidationFilter`, before the backend hop) differs between primary and secondary routes.

# Localhost deployment rules

Use Docker for localhost unless the repo already uses another local runtime.

Preferred local pattern:
- one PingGateway container
- one mounted config directory
- environment variables for secrets
- backend MCP server reachable by container DNS name or host networking strategy that already exists in the project

Use mounted files, not image rebuilds, for iterative config work.

Minimum local assets:
- admin.json
- route JSON
- optional logback.xml
- optional .env or environment variable instructions

If using Docker Compose:
- mount config into the gateway instance directory used by the image
- wire secrets with environment variables
- expose gateway port for local testing
- ensure streaming/SSE is enabled

# Kubernetes deployment rules

Prefer mounted config and secrets, not baked-in config.

Use:
- ConfigMap for non-secret files
- Secret for credentials and any value you want to change in one place, including non-secret URLs such as token endpoints and introspection endpoints
- Deployment mounts for config files
- Service and Ingress updates as needed

Do not split related configuration across both a Secret and a plain `value:` env var. If a value is already in the Secret, reference it with `secretKeyRef` in the Deployment so there is one place to change it.

## PingGateway image

There is no public PingGateway container image. The image must be built from the downloaded PingGateway distribution using the Dockerfile provided in the distribution's `docker/` directory, then pushed to a registry accessible by the deployment target. Do not invent or guess an image reference — ask the user for the image they have built and pushed, or check the existing Deployment for the image already in use.

Always detect the actual PingGateway instance directory used by the image from runtime or existing manifests. Do not assume `.openig` if the container clearly uses another instance directory.

If the image uses `/var/gateway`, keep everything there consistently.

Typical mounted files:
- config/admin.json
- config/routes/<route>.json
- config/logback.xml when debugging
- scripts only if a script is truly required

## gateway-instance EmptyDir volume

The standard PingGateway image requires a writable instance directory at runtime. Always add an `emptyDir` volume mounted at the instance directory root, typically `/var/gateway`, in addition to the ConfigMap mounts for individual files.

The ConfigMap mounts for specific files are placed inside this directory, so both volumes must be present:

```yaml
volumeMounts:
- name: gateway-instance
  mountPath: /var/gateway
- name: gateway-config
  mountPath: /var/gateway/config/admin.json
  subPath: admin.json
- name: gateway-config
  mountPath: /var/gateway/config/routes/<route>.json
  subPath: <route>.json
volumes:
- name: gateway-instance
  emptyDir: {}
- name: gateway-config
  configMap:
    name: ping-gateway-config
```

Omitting the `gateway-instance` EmptyDir can cause the gateway to fail on startup because it cannot write to its instance directory.

## Kubernetes Deployment required fields

A Deployment missing `spec.selector` or `spec.template.metadata.labels` will be rejected by the API server or will create pods it cannot manage. Always include:

```yaml
spec:
  selector:
    matchLabels:
      app: ping-gateway
  template:
    metadata:
      labels:
        app: ping-gateway
```

The label value in `selector.matchLabels` and `template.metadata.labels` must match exactly.

## Backend target rule in Kubernetes

For gateway-to-MCP-server proxying in k8s, prefer the internal Service DNS name over the public ingress hostname.

Good:
- `http://notflux-mcp-server`
- `http://notflux-mcp-server.<namespace>.svc.cluster.local`

Avoid using the public MCP hostname as the backend target when an internal Service exists.

Reason:
- it avoids ingress loops
- it avoids accidental host-header routing back to the gateway
- it simplifies TLS and timeout behavior inside the cluster

If a loop is suspected, inspect:
- `Host`
- `X-Forwarded-Host`
- `X-Original-Forwarded-For`

Strip or normalize outbound forwarded headers when needed.

# Optional Authorize integration

Support optional Authorize integration without forcing it.

`PingAuthorizeFilter` requires **PingGateway 2026 or later**. It is not present in 2025.11. If the deployed image is older than 2026, this integration is not available without upgrading.

If the user wants policy decisions from Authorize:
- keep PingGateway as the enforcement point
- add `PingAuthorizeFilter` to the route between `McpValidationFilter` and `OAuth2TokenExchangeFilter`
- configure it against the customer's actual Authorize deployment model

`PingAuthorizeFilter` works with both P1AZ (cloud) and PAZ (standalone) via the Sideband API. The only difference is the `gatewayServiceUri` and how the credential is provisioned. The filter sends the full request context and the inbound access token to the Sideband API and enforces the ALLOW/DENY/MODIFY decision before token exchange occurs.

### PingAuthorizeFilter config pattern

```json
{
  "name": "AuthorizePolicyDecision",
  "type": "PingAuthorizeFilter",
  "config": {
    "gatewayServiceUri": "&{P1AZ_GATEWAY_SERVICE_URI}",
    "secretsProvider": "SecretsStore",
    "gatewayCredentialSecretId": "p1az.gateway.credential",
    "includeBodyContentTypes": [ "application/json" ]
  }
}
```

**Important**: `gatewayServiceUri` must use `&{VARNAME}` (property substitution), not `${env['VARNAME']}` (runtime EL). PingAuthorizeFilter validates this field as a `java.net.URI` at route build time — before runtime EL is evaluated — so the literal expression string causes a `URISyntaxException`. `&{VARNAME}` is substituted before URI parsing and reads directly from environment variables.

Other fields (`clientId`, `endpoint` in other heaplets) tolerate `${env['...']}` because their implementations parse the value lazily or as a plain string.

The filter takes the access token from the `Authorization` header by default, which is correct after `McpProtectionFilter` has already validated it.

### includeBodyContentTypes for MCP tool visibility

Without `includeBodyContentTypes`, P1AZ/PAZ only sees the HTTP path and the validated token claims. It has no visibility into what the agent is actually trying to do.

MCP uses JSON-RPC 2.0 over HTTP POST with `Content-Type: application/json`. Setting:

```json
"includeBodyContentTypes": [ "application/json" ]
```

causes the full request body to be forwarded to P1AZ/PAZ with each Sideband call. For MCP tool invocations, the body looks like:

```json
{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "params": {
    "name": "delete_profile",
    "arguments": { "profile_id": "abc-123" }
  },
  "id": 1
}
```

This gives P1AZ/PAZ access to:
- `method` — the JSON-RPC method (`tools/call`, `tools/list`, `initialize`)
- `params.name` — the specific MCP tool being invoked (e.g. `delete_profile`, `get_media_content`)
- `params.arguments` — the full tool arguments, enabling attribute-based decisions on resource IDs, scopes, or any argument value the policy cares about

With this, P1AZ/PAZ policies can make decisions like:
- allow `tools/list` and `initialize` for any authenticated user
- allow `get_*` tools but deny `delete_*` tools for users without elevated scope
- allow `delete_profile` only when `params.arguments.profile_id` matches the subject's own profile
- deny any `tools/call` outside business hours

Without body inclusion, the policy can only evaluate the token claims and the URL path — it cannot distinguish a read tool call from a destructive one.

**Latency tradeoff**: Including the body requires PingGateway to buffer the full request body before forwarding it to the Sideband API, which adds latency proportional to body size. For typical MCP tool calls (small JSON payloads) this is negligible. Do not enable body inclusion on routes where large binary payloads are expected.

**GET requests (SSE stream) have no body** — `includeBodyContentTypes` has no effect on the GET `/mcp` stream endpoint. Only POST requests carry a JSON-RPC body.

For PAZ standalone, replace `gatewayServiceUri` with the PAZ host/port and base path. The `sharedSecretHeaderName` defaults to `CLIENT-TOKEN` and is correct for both P1AZ and PAZ unless a custom header was configured.

### Required values from the Authorize console

For P1AZ:
- `gatewayServiceUri` — P1AZ console: Authorization > API gateways > Service URL
- Sideband credential — P1AZ console: Authorization > API gateways > select gateway > add credential

For PAZ standalone:
- `gatewayServiceUri` — `http://<paz-host>:<paz-sideband-port>` (default sideband port is 6080)
- Shared secret — configured in the PAZ sideband API policy

### Placement in the filter chain

```
McpProtectionFilter
  → PingAuthorizeFilter   ← before McpValidationFilter
    → McpValidationFilter
      → OAuth2TokenExchangeFilter
        → HeaderFilter
          → ReverseProxyHandler
```

**`PingAuthorizeFilter` must run before `McpValidationFilter`**, not after. `McpValidationFilter` reads the request body to validate the JSON-RPC structure, which consumes the body stream. If `PingAuthorizeFilter` runs after it, the body is already exhausted and `includeBodyContentTypes` will forward an empty body to P1AZ — the policy sees no tool name and no arguments.

Placing `PingAuthorizeFilter` before `McpValidationFilter` ensures P1AZ receives the full body. The token has already been validated by `McpProtectionFilter` (or `rsFilter` on secondary routes) at this point, so P1AZ is making decisions on a validated identity with a complete request body.

### Failure pattern

If `PingAuthorizeFilter` returns 403 unexpectedly:
- Check the Sideband API URL and credential are correct
- Check the P1AZ/PAZ API gateway is configured to recognize this gateway instance
- Check what attributes P1AZ/PAZ received (enable debug logging in PAZ or check P1AZ audit logs)
- Verify the inbound token carries the claims the policy expects

Support:
- P1AZ
- standalone PAZ

Do not assume hybrid support unless the user explicitly confirms that architecture and wants to test it.

Keep Authorize policy checks additive to the core MCP gateway flow:
- authenticate
- optionally call Authorize
- exchange token if needed
- proxy to backend MCP server

# Logging and troubleshooting rules

When debugging:
- add a mounted `logback.xml`
- raise logging level through config, not image rebuild
- restart or roll the container or deployment after logging config changes
- use route capture only temporarily
- remove sensitive capture once debugging is done

Never leave full bearer tokens in long-term logs.

`capture: "all"` must not be present in production route config. It logs full request and response bodies including Authorization headers. Treat any committed manifest or route file containing `capture: "all"` as a credentials leak risk and remove it before deploying to any non-development environment.

When isolating failures, distinguish among:
1. inbound token validation failure
2. token exchange failure
3. backend MCP server rejection
4. routing loop or host-header problem
5. SSE timeout or proxy timeout issue

# Common failure patterns

## Inbound token rejected
Check:
- audience matches the gateway resource
- scope matches the gateway scope
- validation mode matches the issuer
- introspection credentials are configured correctly
- secret IDs are labels, not raw secret values

## Token exchange returns 400
Check:
- subject token type
- requested token type
- scope
- audience
- token endpoint client authentication method
- whether the provider expects built-in filter config instead of custom script behavior

## Backend returns 401 with gateway metadata
Suspect a routing loop or host-header issue.
Check whether the gateway is proxying to a public hostname and sending the wrong `Host` header.

## SSE breaks
Check:
- `streamingEnabled`
- reverse proxy socket timeout
- ingress idle/read/send timeouts
- any buffering at the ingress layer

# Implementation workflow

## Step 1: inspect existing architecture
Read:
- existing Deployment or Docker Compose
- existing Services and Ingress
- current PingGateway image and mounted config paths
- MCP server service names or hostnames
- token provider details
- whether the backend server already performs its own downstream exchange

## Step 2: choose the route pattern
Pick:
- single route for one MCP server
- one route per MCP server for multiple backends

## Step 3: choose inbound auth
Pick introspection or stateless validation based on the actual provider and architecture.

## Step 4: choose backend hop auth
Determine how the backend MCP server expects to be called:
- **Bearer token**: use `OAuth2TokenExchangeFilter` to exchange the gateway token for a backend-scoped token. Use a script only if a hard provider limitation prevents the built-in filter.
- **API key**: skip token exchange entirely. Use `HeaderFilter` to remove `Authorization` and inject the API key (e.g. `X-Api-Key`) from an env var backed by a Kubernetes Secret. Do not perform token exchange when the backend uses static key auth.

## Step 5: choose backend target
- Docker localhost: use the local container/service target
- k8s: use the internal Service DNS name

## Step 6: add deployable config
Generate the exact files and environment variables needed.

## Step 7: add validation steps
Include:
- startup log checks
- curl or Postman checks
- rollout commands
- expected success and failure signals

# Output requirements

When using this skill, output:
1. architecture summary
2. assumptions
3. exact files to create or modify
4. full contents for each file
5. environment variables and secrets required
6. deploy commands
7. validation commands
8. troubleshooting notes for the chosen topology

If a required value is unknown, leave a clear placeholder rather than guessing.

# Style rules

- Be implementation-first
- Prefer exact config over explanation
- Use the existing architecture and naming where possible
- Keep changes minimal and reversible
- Avoid speculative redesigns
- Call out risky assumptions explicitly

# Trigger examples

Use this skill for requests like:
- build a PingGateway config in front of my MCP server
- deploy PingGateway locally with Docker for MCP testing
- wire PingGateway to multiple MCP servers in k8s
- switch this MCP gateway from script-based token exchange to product-native config
- add optional PingOne Authorize or PingAuthorize policy checks to the MCP gateway
- troubleshoot why my PingGateway MCP route is looping or failing token exchange

# References

Use the existing repo architecture first. Use official Ping documentation only to confirm exact filter syntax, required properties, and deployment constraints.

When looking up filter syntax, use the reference docs for the **exact version deployed**. Filter availability varies by version — `PingAuthorizeFilter` is 2026+ only and does not appear in 2025.11 docs. If a filter URL returns 404, check the What's New page for the deployed version to confirm whether the filter exists in that release.

URL pattern for versioned docs:
- Reference index: `https://docs.pingidentity.com/pinggateway/<version>/reference/index.html`
- What's New: `https://docs.pingidentity.com/pinggateway/release-notes/whats-new.html`
- Specific filter: `https://docs.pingidentity.com/pinggateway/<version>/reference/<FilterName>.html`

Recommended references:
- MCP security gateway: https://docs.pingidentity.com/pinggateway/2026/mcp/index.html
- McpProtectionFilter reference: https://docs.pingidentity.com/pinggateway/2026/reference/McpProtectionFilter.html
- Validate access tokens with introspection: https://docs.pingidentity.com/pinggateway/2026/gateway-guide/oauth2-rs-introspect.html
- OAuth 2.0 token exchange: https://docs.pingidentity.com/pinggateway/2026/gateway-guide/token-exchange.html
- PingGateway as a microgateway: https://docs.pingidentity.com/pinggateway/2026/about/about-microgateway.html
- PingAuthorizeFilter (2026+): https://docs.pingidentity.com/pinggateway/2026/reference/PingAuthorizeFilter.html
- What's New (filter discovery): https://docs.pingidentity.com/pinggateway/release-notes/whats-new.html