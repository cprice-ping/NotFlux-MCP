/*
 * PingGateway ScriptableFilter — RFC 8693 Token Exchange (Gateway → MCP Server hop)
 *
 * Args injected by ScriptableFilter config (never read directly from env here):
 *   tokenEndpoint   — PingOne /token endpoint
 *   clientId        — TE client id     (from k8s Secret PINGONE_TE_CLIENT_ID)
 *   clientSecret    — TE client secret (from k8s Secret PINGONE_TE_CLIENT_SECRET)
 *   requestedScope  — Scope for the backend MCP token (e.g. use_mcp)
 *
 * Fails closed: 401 if exchange fails. Never forwards the original inbound token.
 */
import org.forgerock.http.protocol.*

def clientId       = args.clientId       as String
def clientSecret   = args.clientSecret   as String
def tokenEndpoint  = args.tokenEndpoint  as String
def requestedScope = args.requestedScope as String

if (!clientId || !clientSecret) {
    logger.warn('TokenExchange: PINGONE_TE_CLIENT_ID/SECRET not set — returning 401')
    return new Response(Status.UNAUTHORIZED)
}

def incomingAuth = request.headers['Authorization']?.firstValue
if (!incomingAuth?.startsWith('Bearer ')) {
    logger.warn('TokenExchange: no Bearer token on request — returning 401')
    return new Response(Status.UNAUTHORIZED)
}
def subjectToken = incomingAuth.substring(7)

def credentials = "${clientId}:${clientSecret}".bytes.encodeBase64().toString()

def teRequest = new Request()
teRequest.method = 'POST'
teRequest.uri = new URI(tokenEndpoint)
teRequest.headers.put('Authorization', "Basic ${credentials}")
teRequest.headers.put('Content-Type', 'application/x-www-form-urlencoded')
teRequest.entity.setString(
    "grant_type=${URLEncoder.encode('urn:ietf:params:oauth:grant-type:token-exchange', 'UTF-8')}" +
    "&subject_token=${URLEncoder.encode(subjectToken, 'UTF-8')}" +
    "&subject_token_type=${URLEncoder.encode('urn:ietf:params:oauth:token-type:access_token', 'UTF-8')}" +
    "&requested_token_type=${URLEncoder.encode('urn:ietf:params:oauth:token-type:access_token', 'UTF-8')}" +
    "&scope=${URLEncoder.encode(requestedScope, 'UTF-8')}"
)

logger.debug("TokenExchange: POST ${tokenEndpoint} scope=${requestedScope}")
def teResponse = http.send(teRequest).get()
if (teResponse.status.code != 200) {
    logger.error("TokenExchange: PingOne returned ${teResponse.status.code}")
    return new Response(Status.UNAUTHORIZED)
}

def json = teResponse.entity.json
// Overwrite — do NOT forward the original inbound token to the backend
request.headers.put('Authorization', "Bearer ${json['access_token']}")
logger.debug('TokenExchange: ok — outbound Authorization replaced')
return next.handle(context, request)
