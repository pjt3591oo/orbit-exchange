import Keycloak, { type KeycloakProfile } from 'keycloak-js';

/**
 * Singleton Keycloak instance for the admin SPA.
 *
 * The admin app uses Authorization Code + PKCE — Keycloak redirects to its
 * own login page, then back to /silent-check-sso.html which forwards the
 * resulting tokens to keycloak-js. We never see or store passwords.
 *
 * Tokens are kept in-memory (NOT localStorage) — refresh happens silently
 * via the Keycloak iframe / refresh-token round-trip.
 */
export const kc = new Keycloak({
  url: import.meta.env.VITE_KEYCLOAK_URL ?? 'http://localhost:8081',
  realm: import.meta.env.VITE_KEYCLOAK_REALM ?? 'orbit',
  clientId: import.meta.env.VITE_KEYCLOAK_CLIENT_ID ?? 'orbit-admin-web',
});

let initPromise: Promise<boolean> | null = null;

export function initAuth(): Promise<boolean> {
  if (initPromise) return initPromise;
  initPromise = kc
    .init({
      onLoad: 'login-required', // No anonymous browsing of admin routes
      pkceMethod: 'S256',
      checkLoginIframe: false, // Cleaner local dev (no iframe spam in console)
      silentCheckSsoRedirectUri: `${window.location.origin}/silent-check-sso.html`,
    })
    .then((authenticated) => {
      if (authenticated) {
        // Refresh the access token 30s before expiry, every 30s.
        setInterval(() => {
          kc.updateToken(60).catch(() => {
            // Refresh failed — session probably expired. Force re-login.
            kc.login();
          });
        }, 30_000);
      }
      return authenticated;
    });
  return initPromise;
}

export function logout(): Promise<void> {
  return kc.logout({ redirectUri: window.location.origin });
}

export function realmRoles(): string[] {
  const parsed = kc.tokenParsed as { realm_access?: { roles?: string[] } } | undefined;
  return parsed?.realm_access?.roles ?? [];
}

export function hasRole(role: string): boolean {
  return realmRoles().includes(role);
}

export function hasAnyRole(roles: string[]): boolean {
  const have = realmRoles();
  return roles.some((r) => have.includes(r));
}

export interface AdminProfile extends KeycloakProfile {
  realmRoles: string[];
}

export function profile(): AdminProfile {
  return {
    username: kc.tokenParsed?.preferred_username,
    email: kc.tokenParsed?.email,
    firstName: kc.tokenParsed?.given_name,
    lastName: kc.tokenParsed?.family_name,
    realmRoles: realmRoles(),
  };
}
