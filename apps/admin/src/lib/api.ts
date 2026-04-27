import axios, { type InternalAxiosRequestConfig } from 'axios';
import { kc } from './keycloak';

/**
 * Admin REST client. Targets /api/v1/admin/* (proxied to apps/api in dev).
 * Every request gets the current Keycloak access token; on 401 we attempt one
 * silent refresh + retry, then bail to login.
 */
export const api = axios.create({
  baseURL: '/api/v1/admin',
});

api.interceptors.request.use((cfg: InternalAxiosRequestConfig) => {
  if (kc.token) {
    cfg.headers = cfg.headers ?? {};
    cfg.headers['Authorization'] = `Bearer ${kc.token}`;
  }
  return cfg;
});

api.interceptors.response.use(
  (r) => r,
  async (err) => {
    if (err.response?.status === 401 && err.config && !err.config.__retried) {
      err.config.__retried = true;
      try {
        await kc.updateToken(-1); // force refresh
        err.config.headers['Authorization'] = `Bearer ${kc.token}`;
        return api.request(err.config);
      } catch {
        kc.login();
      }
    }
    return Promise.reject(err);
  },
);
