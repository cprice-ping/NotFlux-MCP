import { useState, useEffect, useRef } from 'react';
import type { User } from 'oidc-client-ts';
import { signOut } from '../auth/oidc';

interface Props {
  user: User;
  onToggleAgent: () => void;
  agentOpen: boolean;
}

export default function Header({ user, onToggleAgent, agentOpen }: Props) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const displayName =
    (user.profile.given_name as string | undefined) ??
    (user.profile.name as string | undefined) ??
    (user.profile.email as string | undefined) ??
    'User';

  // Close menu when clicking outside
  useEffect(() => {
    if (!menuOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [menuOpen]);

  return (
    <header 
      className="fixed top-0 inset-x-0 z-40 flex items-center justify-between px-6 h-16 bg-gradient-to-b from-black/80 to-transparent backdrop-blur-sm border-b border-white/5"
      role="banner"
    >
      {/* Logo */}
      <h1 className="notflux-logo text-2xl select-none" aria-label="NotFlux">
        NotFlux
      </h1>

      {/* Nav */}
      <nav className="hidden md:flex items-center gap-6 text-sm text-text-secondary" role="navigation" aria-label="Main navigation">
        <a href="/" className="text-text-primary font-medium cursor-default" aria-current="page">Home</a>
        <a href="#" className="hover:text-text-primary cursor-pointer transition-colors">TV Shows</a>
        <a href="#" className="hover:text-text-primary cursor-pointer transition-colors">Movies</a>
        <a href="#" className="hover:text-text-primary cursor-pointer transition-colors">New &amp; Popular</a>
      </nav>

      {/* Right controls */}
      <div className="flex items-center gap-3">
        {/* AI Agent toggle */}
        <button
          onClick={onToggleAgent}
          title="Open NotFlux AI"
          aria-pressed={agentOpen}
          className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border text-sm font-medium transition-all duration-150 ${
            agentOpen
              ? 'bg-accent border-accent text-white shadow-lg shadow-accent/30'
              : 'bg-bg-surface border-white/10 text-text-secondary hover:text-text-primary hover:border-accent/50'
          }`}
        >
          <SparkleIcon />
          <span className="hidden sm:inline">AI</span>
        </button>

        {/* Profile menu */}
        <div className="relative" ref={menuRef}>
          <button
            onClick={() => setMenuOpen((v) => !v)}
            className="w-8 h-8 rounded-full bg-gradient-to-br from-ping-blue to-ping-purple flex items-center justify-center text-white text-xs font-bold select-none hover:opacity-90 transition-opacity"
            aria-label="User menu"
            aria-expanded={menuOpen}
            aria-haspopup="true"
          >
            {displayName[0]?.toUpperCase() ?? 'U'}
          </button>

          {menuOpen && (
            <div className="absolute right-0 mt-2 w-52 bg-bg-surface border border-white/10 rounded-xl shadow-xl shadow-black/50 overflow-hidden animate-fade-in">
              <div className="px-4 py-3 border-b border-white/5">
                <p className="text-sm font-medium text-text-primary truncate">{displayName}</p>
                {user.profile.email && (
                  <p className="text-xs text-text-muted truncate mt-0.5">
                    {user.profile.email as string}
                  </p>
                )}
              </div>
              <button
                onClick={() => { setMenuOpen(false); signOut(); }}
                className="w-full text-left px-4 py-3 text-sm text-text-secondary hover:text-text-primary hover:bg-bg-card transition-colors"
              >
                Sign out
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}

function SparkleIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 2l2.4 7.4H22l-6.2 4.5 2.4 7.4L12 17l-6.2 4.3 2.4-7.4L2 9.4h7.6z" />
    </svg>
  );
}
