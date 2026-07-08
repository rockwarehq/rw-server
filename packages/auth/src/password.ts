import bcrypt from "bcrypt";

// Single source of truth for password hashing. Cost 10 (~100ms) is the
// established value across the codebase; bcrypt.compare is constant-time.
const SALT_ROUNDS = 10;

export function hashPassword(plainText: string): Promise<string> {
  return bcrypt.hash(plainText, SALT_ROUNDS);
}

export function comparePassword(plainText: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plainText, hash);
}
