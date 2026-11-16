import jwt from "jsonwebtoken";
import { config } from "../config";

export interface AdminTokenPayload {
  sub: number;
  email: string;
  role: "admin";
}

const JWT_EXPIRES_IN = "8h";
const JWT_OPTIONS = {
  algorithms: ["HS256"] as jwt.Algorithm[],
  issuer: "posh-slg-api",
  audience: "posh-slg-admin",
};

export function signAdminToken(payload: AdminTokenPayload): string {
  return jwt.sign(payload, config.jwtSecret, {
    algorithm: "HS256",
    issuer: JWT_OPTIONS.issuer,
    audience: JWT_OPTIONS.audience,
    expiresIn: JWT_EXPIRES_IN,
  });
}

export function verifyAdminToken(token: string): AdminTokenPayload {
  return jwt.verify(
    token,
    config.jwtSecret,
    JWT_OPTIONS,
  ) as unknown as AdminTokenPayload;
}
