import React from 'react';
import { signIn } from '../auth/oidc';

export default function LoginPage() {
  const [loading, setLoading] = React.useState(false);

  async function handleLogin() {
    setLoading(true);
    await signIn();
  }

  return (
    <div
      className="relative flex flex-col items-center justify-center min-h-screen bg-bg overflow-hidden"
      role="main"
    >
      {/* Background gradient blobs */}
      <div
        className="absolute inset-0 pointer-events-none"
        aria-hidden="true"
      >
        <div className="absolute -top-40 -left-40 w-96 h-96 rounded-full bg-ping-purple/10 blur-3xl" />
        <div className="absolute -bottom-40 -right-40 w-96 h-96 rounded-full bg-ping-blue/10 blur-3xl" />
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] rounded-full bg-accent/5 blur-3xl" />
      </div>

      {/* Card */}
      <div className="relative z-10 flex flex-col items-center gap-10 px-8 max-w-md w-full text-center">
        {/* Logo */}
        <div className="flex flex-col items-center gap-3">
          <span className="notflux-logo text-5xl tracking-tight">NotFlux</span>
          <span className="text-text-secondary text-sm font-medium uppercase tracking-widest">
            AI-Powered Streaming
          </span>
        </div>

        {/* Divider line */}
        <div className="w-full h-px bg-gradient-to-r from-transparent via-white/10 to-transparent" />

        {/* Description */}
        <div className="space-y-3">
          <h1 className="text-2xl font-bold text-text-primary">
            Stream smarter with AI
          </h1>
          <p className="text-text-secondary text-sm leading-relaxed">
            Sign in with your PingOne account to access your personalised
            content library. Your NotFlux AI agent will help you discover
            what&apos;s available based on your account permissions.
          </p>
        </div>

        {/* Sign-in button */}
        <button
          onClick={handleLogin}
          disabled={loading}
          className="w-full flex items-center justify-center gap-3 bg-gradient-to-r from-ping-blue to-ping-purple hover:opacity-90 disabled:opacity-50 text-white font-semibold py-3.5 px-8 rounded-xl transition-all duration-150 shadow-lg shadow-accent/20"
        >
          {loading ? (
            <>
              <LoadingSpinner />
              Redirecting to PingOne&hellip;
            </>
          ) : (
            <>
              <PingIcon />
              Sign in with PingOne
            </>
          )}
        </button>

        {/* Footer note */}
        <p className="text-text-muted text-xs">
          Secured by{' '}
          <span className="text-accent font-medium">PingIdentity</span>
          {' · '}
          AI by{' '}
          <span className="text-accent font-medium">Vertex AI</span>
        </p>
      </div>
    </div>
  );
}

function LoadingSpinner() {
  return (
    <svg
      className="animate-spin w-5 h-5"
      fill="none"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <circle
        className="opacity-25"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="4"
      />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8v8z"
      />
    </svg>
  );
}

function PingIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className="shrink-0"
    >
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M8 12a4 4 0 1 1 8 0 4 4 0 0 1-8 0"
        fill="currentColor"
        opacity="0.4"
      />
      <circle cx="12" cy="12" r="2" fill="currentColor" />
    </svg>
  );
}
