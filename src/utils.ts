import fs from "fs/promises";

export async function fileExists(path: string) {
  try {
    await fs.stat(path);
  } catch {
    return false;
  }

  return true;
}
