/**
 * Shared test helpers.
 *
 * Fixture repos are built in temp dirs (with their own `.git/HEAD`) so tests
 * are hermetic: they never depend on whether the checkout itself sits inside
 * a git repository, which would otherwise change project-root resolution.
 */
import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const testsDir = path.dirname(fileURLToPath(import.meta.url));
/**
 * Repo root, robust to tests running from source (`tests/`) or compiled
 * output (`tests/dist/`): whichever ancestor contains `fixtures/home` wins.
 */
function findRoot(): string {
  for (const cand of [path.join(testsDir, ".."), path.join(testsDir, "..", "..")]) {
    if (existsSync(path.join(cand, "fixtures", "home"))) return cand;
  }
  return path.join(testsDir, "..", "..");
}
export const REPO_ROOT = findRoot();
export const fx = (...p: string[]): string => path.join(REPO_ROOT, "fixtures", ...p);
/** Fake home with global configs for all three agents. */
export const HOME = fx("home");

/** Create an isolated repo: temp dir + `.git/HEAD` + the given files. */
export async function mkRepo(files: Record<string, string | Buffer>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "instrace-repo-"));
  await fs.mkdir(path.join(dir, ".git"), { recursive: true });
  await fs.writeFile(path.join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content);
  }
  return dir;
}
