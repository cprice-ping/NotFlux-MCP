// ---------------------------------------------------------------------------
// PingOne OIDC configuration using oidc-client-ts (PKCE / Authorization Code)
//
// The browser acquires a single person_token via PKCE login:
//   aud=notflux-api, scope=get_media
//
// This token is used for:
//   1. Direct NotFlux API calls (Kong validates aud + scope)
//   2. Vertex Agent sessions — the backend performs Token Exchange (RFC 8693)
//      person_token → mcp_token [aud=notflux-mcp] before injecting into
//      Vertex session state.  The MCP Server rejects any token that doesn't
//      carry aud=notflux-mcp, so the person_token can never reach it.
// ---------------------------------------------------------------------------
import { UserManager, WebStorageStateStore } from 'oidc-client-ts';

const ENV_ID =
  import.meta.env.VITE_PINGONE_ENV_ID ??
  '59bb6a66-e76e-490c-b83a-884c50423da4';
const CLIENT_ID =
  import.meta.env.VITE_PINGONE_CLIENT_ID ??
  '5d24d1a9-851e-4cfb-8f94-d23d4b8b5be2';

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

export async function signIn() {
  await userManager.signinRedirect();
}

export async function handleCallback() {
  return userManager.signinRedirectCallback();
}

export async function signOut() {
  await userManager.signoutRedirect();
}
