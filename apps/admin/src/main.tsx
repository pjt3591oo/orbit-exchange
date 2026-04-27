import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import './styles/globals.css';
import { App } from './App';
import { initAuth } from './lib/keycloak';

// Block rendering until Keycloak finishes init — otherwise components mount
// without an access token and trigger a flash of unauthenticated state.
initAuth()
  .then((authenticated) => {
    if (!authenticated) {
      // login-required mode would have redirected already; defensive only.
      document.body.innerText = '인증이 필요합니다. 다시 시도해주세요.';
      return;
    }
    const qc = new QueryClient({
      defaultOptions: {
        queries: { staleTime: 5_000, refetchOnWindowFocus: false, retry: 1 },
      },
    });
    createRoot(document.getElementById('root')!).render(
      <StrictMode>
        <QueryClientProvider client={qc}>
          <BrowserRouter>
            <App />
          </BrowserRouter>
        </QueryClientProvider>
      </StrictMode>,
    );
  })
  .catch((err) => {
    document.body.innerText = `Keycloak init 실패: ${(err as Error).message}`;
  });
