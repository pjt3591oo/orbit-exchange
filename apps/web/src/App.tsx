import { Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from './components/AppShell';
import { LoginPage } from './pages/LoginPage';
import { MarketsPage } from './pages/MarketsPage';
import { TradePage } from './pages/TradePage';
import { PortfolioPage } from './pages/PortfolioPage';
import { DepositWithdrawPage } from './pages/DepositWithdrawPage';
import { StakingPage } from './pages/StakingPage';
import { NoticesPage } from './pages/NoticesPage';
import { useAuthStore } from './store/auth';

function Protected({ children }: { children: React.ReactNode }) {
  const token = useAuthStore((s) => s.accessToken);
  if (!token) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<AppShell />}>
        <Route path="/" element={<Navigate to="/trade/BTC-KRW" replace />} />
        <Route path="/markets" element={<MarketsPage />} />
        <Route path="/trade/:symbol" element={<TradePage />} />
        <Route
          path="/portfolio"
          element={
            <Protected>
              <PortfolioPage />
            </Protected>
          }
        />
        <Route
          path="/deposit"
          element={
            <Protected>
              <DepositWithdrawPage />
            </Protected>
          }
        />
        <Route path="/staking" element={<StakingPage />} />
        <Route path="/notices" element={<NoticesPage />} />
        {/* Legacy alias */}
        <Route path="/account" element={<Navigate to="/portfolio" replace />} />
      </Route>
    </Routes>
  );
}
