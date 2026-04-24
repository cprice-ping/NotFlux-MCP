import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { handleCallback } from '../auth/oidc';

/**
 * OIDC redirect callback page.
 * PingOne redirects here after authentication with the auth code.
 * oidc-client-ts exchanges the code for tokens, then we redirect home.
 */
export default function CallbackPage() {
  const navigate = useNavigate();

  useEffect(() => {
    handleCallback()
      .then(() => navigate('/', { replace: true }))
      .catch((err) => {
        console.error('OIDC callback error:', err);
        navigate('/?error=auth_failed', { replace: true });
      });
  }, [navigate]);

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-bg gap-4">
      <span className="notflux-logo text-3xl">NotFlux</span>
      <div className="flex items-center gap-2 text-text-secondary text-sm">
        <svg
          className="animate-spin w-4 h-4 text-accent"
          fill="none"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
        </svg>
        Completing sign-in&hellip;
      </div>
    </div>
  );
}
