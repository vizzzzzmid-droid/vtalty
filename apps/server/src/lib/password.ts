import argon2 from "argon2";

// argon2.hash defaults to argon2id, the recommended variant for passwords.
export function hashPassword(password: string): Promise<string> {
  return argon2.hash(password);
}

/** Returns false for wrong passwords and for malformed hashes. */
export async function verifyPassword(
  hash: string,
  password: string,
): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}
