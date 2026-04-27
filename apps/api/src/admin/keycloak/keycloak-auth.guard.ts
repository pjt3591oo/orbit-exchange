import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { KeycloakClaims } from './keycloak-claims';

/**
 * Bearer-token auth guard for admin routes.
 *
 * Validates the access token issued by Keycloak by:
 *   1. fetching the realm's JWKS (cached by jose, refetched on key rotation)
 *   2. verifying RS256 signature
 *   3. checking issuer matches our realm
 *   4. checking audience contains our admin API client id (`orbit-admin-api`)
 *
 * Customer routes still use JwtAuthGuard with our own JWT secret — the two
 * coexist by guard placement, NOT by inspecting the token. Each route declares
 * which guard applies.
 */
@Injectable()
export class KeycloakAuthGuard implements CanActivate {
  private readonly log = new Logger(KeycloakAuthGuard.name);
  private readonly jwks: JWTVerifyGetKey;
  private readonly issuer: string;
  private readonly audience: string;

  constructor(cfg: ConfigService) {
    const url = cfg.getOrThrow<string>('KEYCLOAK_URL');
    const realm = cfg.getOrThrow<string>('KEYCLOAK_REALM');
    this.issuer =
      cfg.get<string>('KEYCLOAK_ISSUER') ?? `${url}/realms/${realm}`;
    this.audience =
      cfg.get<string>('KEYCLOAK_CLIENT_ID_ADMIN') ?? 'orbit-admin-api';

    // jose caches the JWKS internally. The 1st request fetches; subsequent
    // requests reuse. On `kid` miss (key rotation), it refetches automatically.
    this.jwks = createRemoteJWKSet(
      new URL(`${this.issuer}/protocol/openid-connect/certs`),
      { cooldownDuration: 30_000 },
    );
  }

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    const auth = req.headers['authorization'] as string | undefined;
    if (!auth || !auth.startsWith('Bearer ')) {
      throw new UnauthorizedException('missing bearer token');
    }
    const token = auth.slice('Bearer '.length).trim();
    if (!token) throw new UnauthorizedException('empty bearer token');

    try {
      const { payload } = await jwtVerify(token, this.jwks, {
        issuer: this.issuer,
        audience: this.audience,
      });
      req.admin = payload as unknown as KeycloakClaims;
      return true;
    } catch (err) {
      const msg = (err as Error).message;
      this.log.warn(`token verification failed: ${msg}`);
      throw new UnauthorizedException(`invalid token: ${msg}`);
    }
  }
}
