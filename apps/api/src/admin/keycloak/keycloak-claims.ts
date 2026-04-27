/**
 * Subset of Keycloak access-token claims we actually use. Keycloak puts a lot
 * more in the token but we never need most of it; ignore unknown fields.
 */
export interface KeycloakClaims {
  sub: string; // UUID — the admin's Keycloak user id
  email?: string;
  preferred_username?: string;
  name?: string;
  realm_access?: { roles: string[] };
  resource_access?: Record<string, { roles: string[] }>;
  exp: number;
  iat: number;
  iss: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      admin?: KeycloakClaims;
    }
  }
}
