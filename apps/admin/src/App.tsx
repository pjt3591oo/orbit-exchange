import { Navigate, Route, Routes } from 'react-router-dom';
import { AdminShell } from './components/AdminShell';
import { Protected } from './components/Protected';
import { DashboardPage } from './pages/DashboardPage';
import { UsersPage } from './pages/UsersPage';
import { UserDetailPage } from './pages/UserDetailPage';
import { MarketsPage } from './pages/MarketsPage';
import { MarketDetailPage } from './pages/MarketDetailPage';
import { OrdersPage } from './pages/OrdersPage';
import { TradesPage } from './pages/TradesPage';
import { AssetsPage } from './pages/AssetsPage';
import { AuditPage } from './pages/AuditPage';
import { DlqPage } from './pages/DlqPage';

export function App() {
  return (
    <Routes>
      <Route element={<AdminShell />}>
        <Route index element={<Navigate to="/dashboard" replace />} />
        <Route path="/dashboard" element={<DashboardPage />} />

        <Route
          path="/users"
          element={
            <Protected roles={['SUPPORT_READ']}>
              <UsersPage />
            </Protected>
          }
        />
        <Route
          path="/users/:id"
          element={
            <Protected roles={['SUPPORT_READ']}>
              <UserDetailPage />
            </Protected>
          }
        />
        <Route
          path="/markets"
          element={
            <Protected roles={['SUPPORT_READ']}>
              <MarketsPage />
            </Protected>
          }
        />
        <Route
          path="/markets/:symbol"
          element={
            <Protected roles={['SUPPORT_READ']}>
              <MarketDetailPage />
            </Protected>
          }
        />
        <Route
          path="/orders"
          element={
            <Protected roles={['SUPPORT_READ']}>
              <OrdersPage />
            </Protected>
          }
        />
        <Route
          path="/trades"
          element={
            <Protected roles={['SUPPORT_READ']}>
              <TradesPage />
            </Protected>
          }
        />
        <Route
          path="/assets"
          element={
            <Protected roles={['MARKET_OPS']}>
              <AssetsPage />
            </Protected>
          }
        />
        <Route
          path="/dlq"
          element={
            <Protected roles={['SUPPORT_READ', 'MARKET_OPS']}>
              <DlqPage />
            </Protected>
          }
        />
        <Route
          path="/audit"
          element={
            <Protected roles={['AUDITOR', 'SUPPORT_READ']}>
              <AuditPage />
            </Protected>
          }
        />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}

function NotFound() {
  return <div style={{ padding: 20, color: 'var(--text-3)' }}>페이지가 없습니다.</div>;
}
