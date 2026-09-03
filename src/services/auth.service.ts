import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_jwt_key_v1';
const JWT_EXPIRES_IN = '24h';

export class AuthService {
  static async hashPassword(password: string): Promise<string> {
    const salt = await bcrypt.genSalt(10);
    return bcrypt.hash(password, salt);
  }

  static async comparePassword(password: string, hash: string): Promise<boolean> {
    return bcrypt.compare(password, hash);
  }

  static generateToken(payload: { userId: string; clientId: string }): string {
    const jwtPayload = {
      sub: payload.userId,
      clientId: payload.clientId,
      iss: 'scal_easy_auth',
      aud: 'scal_easy_inventory',
    };
    return jwt.sign(jwtPayload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
  }

  static verifyToken(token: string): any {
    return jwt.verify(token, JWT_SECRET, {
      issuer: 'scal_easy_auth',
      audience: 'scal_easy_inventory'
    });
  }

  // Platform Admin tokens are deliberately a distinct iss/aud pair so a leaked/misused
  // client token can never be mistaken for (or replayed as) a platform-admin one, and
  // vice versa -- verifyToken() above will reject a platform admin token outright.
  static generatePlatformAdminToken(payload: { platformAdminId: string }): string {
    const jwtPayload = {
      sub: payload.platformAdminId,
      iss: 'scal_easy_platform_admin',
      aud: 'scal_easy_platform_console',
    };
    return jwt.sign(jwtPayload, JWT_SECRET, { expiresIn: '8h' });
  }

  static verifyPlatformAdminToken(token: string): any {
    return jwt.verify(token, JWT_SECRET, {
      issuer: 'scal_easy_platform_admin',
      audience: 'scal_easy_platform_console'
    });
  }
}
