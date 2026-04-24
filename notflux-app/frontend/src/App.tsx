import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './hooks/useAuth';
import LoginPage from './pages/LoginPage';
import CallbackPage from './pages/CallbackPage';
import HomePage from './pages/HomePage';

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-bg gap-3">
        <span className="notflux-logo text-3xl">NotFlux</span>
        <svg className="animate-spin w-5 h-5 text-accent" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
        </svg>
      </div>
    );
  }

  if (!user || user.expired) {
    return <Navigate to="/login" replace />;
  }

  return <>{children}</>;
}

export default function App() {
  const { user, agentToken } = useAuth();

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={user && !user.expired ? <Navigate to="/" replace /> : <LoginPage />} />
        <Route path="/callback" element={<CallbackPage />} />
        {/* Silent OIDC renew — minimal iframe page */}
        <Route path="/silent-callback" element={<SilentCallback />} />
        <Route
          path="/*"
          element={
            <ProtectedRoute>
              {user ? <HomePage user={user} agentToken={agentToken} /> : null}
            </ProtectedRoute>
          }
        />
      </Routes>
    </BrowserRouter>
  );
}

function SilentCallback() {
  // oidc-client-ts handles this automatically; just render nothing
  return null;
}
