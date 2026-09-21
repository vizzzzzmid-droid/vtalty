import argon2 from "argon2";

// argon2.hash defaults to argon2id; parameters are pinned explicitly so a
// library upgrade cannot silently weaken password hashing.
export function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, {
    memoryCost: 65536,
    timeCost: 3,
    parallelism: 4,
  });
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
