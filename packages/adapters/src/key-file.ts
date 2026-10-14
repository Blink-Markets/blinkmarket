import { open } from "node:fs/promises";

/**
 * Reads a private key from a file only the owner can touch. A key file readable or writable by
 * group or others, or executable, is refused before its contents are read. Errors carry a code
 * only, never the path contents or key material.
 */
export async function readKeyFile(path: string): Promise<`0x${string}`> {
  let handle;
  try {
    handle = await open(path, "r");
  } catch {
    throw new Error("KEY_FILE_UNREADABLE");
  }
  try {
    // fstat on the open descriptor: the checked file is the file that is read.
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("KEY_FILE_INVALID");
    if ((info.mode & 0o777 & ~0o600) !== 0)
      throw new Error("KEY_FILE_PERMISSIONS");
    const key = (await handle.readFile("utf8")).trim();
    if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("KEY_FILE_INVALID");
    return key as `0x${string}`;
  } finally {
    await handle.close();
  }
}
