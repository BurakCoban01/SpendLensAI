import { lstat, readdir, rm } from "node:fs/promises";
import path from "node:path";

export type TempCleanupInput = {
  subdir?: string;
  maxAgeMs: number;
  dryRun?: boolean;
  now?: Date;
};

export type TempCleanupResult = {
  target: string;
  dryRun: boolean;
  scannedFiles: number;
  retainedFiles: number;
  deletedFiles: number;
  deletedBytes: number;
  deletedPaths: string[];
  removedEmptyDirectories: number;
};

export class TempCleanupService {
  private readonly rootDir: string;

  constructor(rootDir = path.resolve(process.cwd(), "artifacts", "tmp")) {
    this.rootDir = path.resolve(rootDir);
  }

  async cleanup(input: TempCleanupInput): Promise<TempCleanupResult> {
    const dryRun = input.dryRun === true;
    const targetDir = this.resolveTarget(input.subdir);
    const target = this.relativeToRoot(targetDir) || ".";
    const cutoffMs = (input.now ?? new Date()).getTime() - input.maxAgeMs;
    const result: TempCleanupResult = {
      target,
      dryRun,
      scannedFiles: 0,
      retainedFiles: 0,
      deletedFiles: 0,
      deletedBytes: 0,
      deletedPaths: [],
      removedEmptyDirectories: 0
    };

    if (!(await exists(targetDir))) return result;

    const directories: string[] = [];
    await this.scanDirectory(targetDir, cutoffMs, dryRun, result, directories);
    if (!dryRun) {
      result.removedEmptyDirectories = await this.removeEmptyDirectories(directories);
    }
    return result;
  }

  private async scanDirectory(
    directory: string,
    cutoffMs: number,
    dryRun: boolean,
    result: TempCleanupResult,
    directories: string[]
  ): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        directories.push(entryPath);
        await this.scanDirectory(entryPath, cutoffMs, dryRun, result, directories);
        continue;
      }
      if (!entry.isFile()) continue;

      result.scannedFiles += 1;
      const metadata = await lstat(entryPath);
      if (metadata.mtimeMs > cutoffMs) {
        result.retainedFiles += 1;
        continue;
      }

      result.deletedFiles += 1;
      result.deletedBytes += metadata.size;
      if (result.deletedPaths.length < 100) {
        result.deletedPaths.push(this.relativeToRoot(entryPath));
      }
      if (!dryRun) {
        await rm(entryPath, { force: true });
      }
    }
  }

  private async removeEmptyDirectories(directories: string[]): Promise<number> {
    let removed = 0;
    for (const directory of directories.sort((left, right) => right.length - left.length)) {
      if (!(await exists(directory))) continue;
      const entries = await readdir(directory);
      if (entries.length > 0) continue;
      await rm(directory, { force: true, recursive: false });
      removed += 1;
    }
    return removed;
  }

  private resolveTarget(subdir = ""): string {
    const target = path.resolve(this.rootDir, subdir);
    const relative = path.relative(this.rootDir, target);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("TEMP_CLEANUP_TARGET_OUTSIDE_ROOT");
    }
    return target;
  }

  private relativeToRoot(filePath: string): string {
    return path.relative(this.rootDir, filePath).replace(/\\/g, "/");
  }
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}
