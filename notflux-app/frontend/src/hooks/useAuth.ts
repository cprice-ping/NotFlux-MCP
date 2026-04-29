import { useState, useEffect, useCallback } from 'react';
import type { User } from 'oidc-client-ts';
import { userManager, signIn, signOut } from '../auth/oidc';

export interface AuthState {
  user: User | null;
  loading: boolean;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
  /** person_token — aud=notflux-api, scope=get_media.
   *  Used for direct NotFlux API calls AND sent to the backend for
   *  Vertex Agent sessions (backend performs Token Exchange RFC 8693). */
  accessToken: string | null;
}

export function useAuth(): AuthState {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    userManager.getUser().then((u) => {
      setUser(u);
      setLoading(false);
    });

    const onLoaded   = (u: User) => setUser(u);
    const onUnloaded = () => setUser(null);
    const onExpired  = () => setUser(null);

    userManager.events.addUserLoaded(onLoaded);
    userManager.events.addUserUnloaded(onUnloaded);
    userManager.events.addAccessTokenExpired(onExpired);

    return () => {
      userManager.events.removeUserLoaded(onLoaded);
      userManager.events.removeUserUnloaded(onUnloaded);
      userManager.events.removeAccessTokenExpired(onExpired);
    };
  }, []);

  const handleSignIn  = useCallback(async () => { await signIn(); }, []);
  const handleSignOut = useCallback(async () => { await signOut(); }, []);

  return {
    user,
    loading,
    signIn: handleSignIn,
    signOut: handleSignOut,
    accessToken: user?.access_token ?? null,
  };
}
