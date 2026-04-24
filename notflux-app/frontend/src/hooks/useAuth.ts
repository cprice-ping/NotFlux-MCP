import { useState, useEffect, useCallback } from 'react';
import type { User } from 'oidc-client-ts';
import { userManager, signIn, signOut, getAgentToken } from '../auth/oidc';

export interface AuthState {
  user: User | null;
  loading: boolean;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
  /** person_token — aud=notflux-api, scope=get_media. Use for direct NotFlux API calls. */
  accessToken: string | null;
  /**
   * agent_token — aud=google-agent, scope=agent-use.
   * Acquired silently after login (prompt=none).
   * Use for /api/sessions and /api/chat — the backend exchanges this for an
   * MCP-audience token before injecting into the Vertex session state.
   *
   * Falls back to accessToken when VITE_PINGONE_AGENT_RESOURCE is not set.
   */
  agentToken: string | null;
}

export function useAuth(): AuthState {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [agentToken, setAgentToken] = useState<string | null>(null);

  useEffect(() => {
    // Restore stored user on mount
    userManager.getUser().then((u) => {
      setUser(u);
      setLoading(false);
    });

    const onLoaded = (u: User) => {
      setUser(u);
      // Silently acquire the agent-scoped token after the person_token loads.
      // Falls back to person_token if agent resource is not configured.
      getAgentToken().then((t) => setAgentToken(t ?? u.access_token));
    };
    const onUnloaded = () => { setUser(null); setAgentToken(null); };
    const onExpired  = () => { setUser(null); setAgentToken(null); };

    userManager.events.addUserLoaded(onLoaded);
    userManager.events.addUserUnloaded(onUnloaded);
    userManager.events.addAccessTokenExpired(onExpired);

    return () => {
      userManager.events.removeUserLoaded(onLoaded);
      userManager.events.removeUserUnloaded(onUnloaded);
      userManager.events.removeAccessTokenExpired(onExpired);
    };
  }, []);

  // Also attempt agent token on initial user load (mount)
  useEffect(() => {
    if (user && !user.expired) {
      getAgentToken().then((t) => setAgentToken(t ?? user.access_token));
    }
  }, [user]);

  const handleSignIn  = useCallback(async () => { await signIn(); }, []);
  const handleSignOut = useCallback(async () => { await signOut(); }, []);

  return {
    user,
    loading,
    signIn: handleSignIn,
    signOut: handleSignOut,
    accessToken: user?.access_token ?? null,
    agentToken,
  };
}
