import { useState, useEffect } from 'react';

interface KeyboardShortcut {
  key: string;
  modifier?: string;
  description: string;
}

const SHORTCUTS: KeyboardShortcut[] = [
  { key: 'K', modifier: '⌘', description: 'Toggle AI assistant' },
  { key: 'Esc', description: 'Close modal or panel' },
];

/**
 * Keyboard shortcuts help panel - displays available keyboard shortcuts.
 * Triggered by pressing '?' key.
 */
export default function KeyboardShortcutsHelp() {
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    const handleKeyPress = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      const isEditable = tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement)?.isContentEditable;
      if (e.key === '?' && !e.metaKey && !e.ctrlKey && !isEditable) {
        e.preventDefault();
        setIsOpen(prev => !prev);
      }
      if (e.key === 'Escape' && isOpen) {
        setIsOpen(false);
      }
    };

    window.addEventListener('keydown', handleKeyPress);
    return () => window.removeEventListener('keydown', handleKeyPress);
  }, [isOpen]);

  if (!isOpen) {
    return (
      <button
        onClick={() => setIsOpen(true)}
        className="fixed bottom-6 left-6 z-30 w-10 h-10 rounded-full bg-bg-surface border border-white/10 flex items-center justify-center text-text-muted hover:text-text-primary hover:border-accent/50 transition-all duration-200 text-sm font-medium"
        title="Keyboard shortcuts (Press ? to toggle)"
        aria-label="Show keyboard shortcuts"
      >
        ?
      </button>
    );
  }

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm animate-fade-in"
        onClick={() => setIsOpen(false)}
      />

      {/* Modal */}
      <div
        className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-full max-w-md bg-bg-surface rounded-2xl border border-white/10 shadow-2xl p-6 animate-fade-in"
        role="dialog"
        aria-labelledby="shortcuts-title"
        aria-modal="true"
      >
        <div className="flex items-center justify-between mb-4">
          <h2 id="shortcuts-title" className="text-lg font-bold text-text-primary">
            Keyboard Shortcuts
          </h2>
          <button
            onClick={() => setIsOpen(false)}
            className="w-8 h-8 rounded-lg flex items-center justify-center text-text-muted hover:text-text-primary hover:bg-bg-card transition-colors"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <div className="space-y-2">
          {SHORTCUTS.map((shortcut, index) => (
            <div
              key={index}
              className="flex items-center justify-between py-2 px-3 rounded-lg hover:bg-bg-card transition-colors"
            >
              <span className="text-sm text-text-secondary">{shortcut.description}</span>
              <div className="flex items-center gap-1">
                {shortcut.modifier && (
                  <kbd className="px-2 py-1 text-xs font-semibold text-text-primary bg-bg border border-white/10 rounded">
                    {shortcut.modifier}
                  </kbd>
                )}
                <kbd className="px-2 py-1 text-xs font-semibold text-text-primary bg-bg border border-white/10 rounded">
                  {shortcut.key}
                </kbd>
              </div>
            </div>
          ))}
        </div>

        <div className="mt-4 pt-4 border-t border-white/5">
          <p className="text-xs text-text-muted text-center">
            Press <kbd className="px-1.5 py-0.5 text-[10px] font-semibold bg-bg border border-white/10 rounded">?</kbd> to toggle this panel
          </p>
        </div>
      </div>
    </>
  );
}
