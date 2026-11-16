import {
  createHash,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
import bcrypt from "bcrypt";

const SCRYPT_N = 32768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEY_LENGTH = 64;
const SCRYPT_MAX_MEMORY = 64 * 1024 * 1024;

function deriveKey(
  password: string,
  salt: Buffer,
  length: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(
      password,
      salt,
      length,
      {
        N: SCRYPT_N,
        r: SCRYPT_R,
        p: SCRYPT_P,
        maxmem: SCRYPT_MAX_MEMORY,
      },
      (error, key) => (error ? reject(error) : resolve(key)),
    );
  });
}

export const DUMMY_PASSWORD_HASH =
  "scrypt$32768$8$1$b74a4f8f075d87a4a96a8c23344ab640$54eddb3b282edffb9db2e5e351903c4560b0e06fc00477067e67dc8d0921f87a4a52061005046e44e28fd1ea31d178387b8ed5c45cdf26e9986e539a21564a82";

function codePointLength(value: string): number {
  return Array.from(value).length;
}

export function assertPasswordPolicy(password: string): void {
  const length = codePointLength(password);
  if (length < 8) throw new Error("Password must be at least 8 characters");
  if (length > 128)
    throw new Error("Password must be no more than 128 characters");
  if (!/[A-Z]/.test(password))
    throw new Error("Password must include an uppercase letter");
  if (!/[a-z]/.test(password))
    throw new Error("Password must include a lowercase letter");
  if (!/[0-9]/.test(password))
    throw new Error("Password must include a number");
  if (!/[^A-Za-z0-9\s]/.test(password))
    throw new Error("Password must include a special character");
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await deriveKey(password, salt, SCRYPT_KEY_LENGTH);
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("hex")}$${key.toString("hex")}`;
}

export async function verifyPassword(
  password: string,
  encoded: string,
): Promise<boolean> {
  if (encoded.startsWith("$2")) return bcrypt.compare(password, encoded);

  const [algorithm, nText, rText, pText, saltHex, keyHex] = encoded.split("$");
  if (
    algorithm !== "scrypt" ||
    Number(nText) !== SCRYPT_N ||
    Number(rText) !== SCRYPT_R ||
    Number(pText) !== SCRYPT_P ||
    !/^[0-9a-f]{32}$/i.test(saltHex ?? "") ||
    !/^[0-9a-f]{128}$/i.test(keyHex ?? "")
  ) {
    return false;
  }

  const expected = Buffer.from(keyHex, "hex");
  const actual = await deriveKey(
    password,
    Buffer.from(saltHex, "hex"),
    expected.length,
  );
  return timingSafeEqual(actual, expected);
}

export function passwordHashNeedsUpgrade(encoded: string): boolean {
  return !encoded.startsWith(`scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$`);
}
