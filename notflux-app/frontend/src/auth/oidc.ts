// ---------------------------------------------------------------------------
// PingOne OIDC configuration using oidc-client-ts (PKCE / Authorization Code)
//
// Two tokens are managed:
//
//  1. person_token  — obtained via the primary PKCE login.
//                     aud=notflux-api (or the PingOne NotFlux resource),
//                     scope=get_media.  Used by the App for direct API calls.
//
//  2. agent_token   — obtained silently (prompt=none) after login.
//                     aud=<VITE_PINGONE_AGENT_RESOURCE> (e.g. https://google-agent),
//                     scope=agent-use.  Sent to the backend for Vertex Agent
//                     sessions; the backend exchanges it for an MCP-audience
//                     token via RFC 8693 before injecting into session state.
// ---------------------------------------------------------------------------
import { UserManager, WebStorageStateStore } from 'oidc-client-ts';

const ENV_ID =
  import.meta.env.VITE_PINGONE_ENV_ID ??
  '59bb6a66-e76e-490c-b83a-884c50423da4';
const CLIENT_ID =
  import.meta.env.VITE_PINGONE_CLIENT_ID ??
  '5d24d1a9-851e-4cfb-8f94-d23d4b8b5be2';

// ---------------------------------------------------------------------------
// (1) Primary user manager — person_token for direct API calls
// ---------------------------------------------------------------------------
export const userManager = new UserManager({
  authority: `https://auth.pingone.com/${ENV_ID}/as`,
  client_id: CLIENT_ID,
  redirect_uri: `${window.location.origin}/callback`,
  post_logout_redirect_uri: `${window.location.origin}/`,
  scope: 'openid profile get_media',
  response_type: 'code',
  userStore: new WebStorageStateStore({ store: window.localStorage }),
  loadUserInfo: true,
  automaticSilentRenew: true,
  silent_redirect_uri: `${window.location.origin}/silent-callback`,
});

// ---------------------------------------------------------------------------
// (2) Agent token manager — agent_token for Vertex Agent sessions
//
// Uses the same OIDC client with a different resource (RFC 8707) and scope.
// PingOne will issue a token with aud=<AGENT_RESOURCE> and scope=agent-use.
//
// Requires the PingOne application to be authorised for the agent resource.
// Set VITE_PINGONE_AGENT_RESOURCE and VITE_PINGONE_AGENT_SCOPE in .env to
// activate.  If unset the agent falls back to the person_token (safe default).
// ---------------------------------------------------------------------------
const AGENT_RESOURCE =
  import.meta.env.VITE_PINGONE_AGENT_RESOURCE ?? '';
const AGENT_SCOPE =
  import.meta.env.VITE_PINGONE_AGENT_SCOPE ?? 'openid agent-use';

// Store agent tokens separately so they don't overwrite the person token.
const agentUserManager = AGENT_RESOURCE
  ? new UserManager({
      authority: `https://auth.pingone.com/${ENV_ID}/as`,
      client_id: CLIENT_ID,
      redirect_uri: `${window.location.origin}/callback`,
      silent_redirect_uri: `${window.location.origin}/silent-callback`,
      scope: AGENT_SCOPE,
      response_type: 'code',
      // RFC 8707 resource indicator — PingOne sets this as the `aud` claim
      extraQueryParams: { resource: AGENT_RESOURCE },
      userStore: new WebStorageStateStore({
        store: window.sessionStorage,
        prefix: 'oidc.agent.',
      }),
      loadUserInfo: false,
      automaticSilentRenew: true,
    })
  : null;

/**
 * Silently acquire the agent-scoped token (prompt=none).
 * Should be called once after the primary login completes.
 * Returns null if VITE_PINGONE_AGENT_RESOURCE is not configured —
 * callers fall back to the person_token in that case.
 */
export async function getAgentToken(): Promise<string | null> {
  if (!agentUserManager) return null;

  // Re-use a cached non-expired agent token
  const existing = await agentUserManager.getUser();
  if (existing && !existing.expired && existing.access_token) {
    return existing.access_token;
  }

  try {
    const user = await agentUserManager.signinSilent();
    return user?.access_token ?? null;
  } catch (e) {
    console.warn(
      '[NotFlux] Agent token silent acquisition failed — falling back to person_token.',
      e
    );
    return null;
  }
}

export async function signIn() {
  await userManager.signinRedirect();
}

export async function handleCallback() {
  return userManager.signinRedirectCallback();
}

export async function signOut() {
  await userManager.signoutRedirect();
}
