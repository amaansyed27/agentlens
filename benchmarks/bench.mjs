/**
 * Repeatable benchmark: builds a synthetic repo in the temp dir and times
 * scan / tokens-equivalent / duplicates / conflicts.
 *
 * Run:  node benchmarks/bench.mjs [scale]
 * Scale presets: small (default) | large
 */
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const scale = process.argv[2] === "large"
  ? { dirs: 120, skills: 60, dupGroups: 12, bigKb: 512 }
  : { dirs: 40, skills: 16, dupGroups: 5, bigKb: 96 };

const BLOCK = [
  "Always use pnpm for package management.",
  "Use TypeScript with strict mode enabled.",
  "Run the full test suite before committing.",
  "Keep functions small and well named.",
  "Document every public API surface.",
  "Never commit without running the linter.",
].join("\n");

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "instrace-bench-"));
  await fs.mkdir(path.join(root, ".git"), { recursive: true });

  // Nested instruction files, some sharing the duplicated block.
  for (let i = 0; i < scale.dirs; i++) {
    const d = path.join(root, `pkg${i}`, "src");
    await fs.mkdir(d, { recursive: true });
    const dup = i % Math.max(1, Math.floor(scale.dirs / scale.dupGroups)) === 0;
    await fs.writeFile(
      path.join(d, "AGENTS.md"),
      `# Pkg ${i} rules\n\n${dup ? BLOCK : `Rule set ${i}: prefer explicit imports and typed boundaries.`}\n`,
    );
  }
  await fs.writeFile(path.join(root, "AGENTS.md"), `# Root\n\n${BLOCK}\n`);

  // Skills, half duplicated.
  for (let i = 0; i < scale.skills; i++) {
    const d = path.join(root, "skills", `skill-${i}`);
    await fs.mkdir(d, { recursive: true });
    await fs.writeFile(
      path.join(d, "SKILL.md"),
      `# Skill ${i}\n\n${i % 2 === 0 ? BLOCK : `Skill ${i} handles area ${i} with care.`}\n`,
    );
  }

  // One large context file.
  await fs.writeFile(
    path.join(root, "docs", "big.md").replace(/\\/g, "/"),
    "# Big\n\n" + "Follow the style guide. Prefer small modules. Write tests first.\n".repeat(scale.bigKb * 16),
  ).catch(async () => {
    await fs.mkdir(path.join(root, "docs"), { recursive: true });
    await fs.writeFile(path.join(root, "docs", "big.md"), "# Big\n\n" + "Follow the style guide.\n".repeat(scale.bigKb * 16));
  });

  const core = await import("../packages/core/dist/index.js");
  const home = path.join(root, "no-home");

  async function time(label, fn) {
    const t0 = process.hrtime.bigint();
    const out = await fn();
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    console.log(`${label}: ${ms.toFixed(0)} ms`);
    return out;
  }

  console.log(`synthetic repo: ${scale.dirs} dirs, ${scale.skills} skills, big=${scale.bigKb}KB  (${root})`);
  const report = await time("scanProject      ", () => core.scanProject({ cwd: root, homeDir: home }));
  await time("duplicates only  ", async () => {
    const docs = [];
    for (const a of report.agents)
      for (const s of [...a.loaded, ...a.notLoaded]) {
        if (!s.path || s.kind === "mcp" || !s.exists) continue;
        const t = await fs.readFile(s.path, "utf8").catch(() => null);
        if (t && t.trim()) docs.push({ path: s.path, text: t });
      }
    return core.findDuplicates(docs);
  });
  await time("conflicts only   ", () => core.resolveAgent(root, "opencode", home).then(() => {
    const docs = [{ path: "x", text: BLOCK }];
    return core.findConflicts(docs);
  }));
  console.log(`findings: ${report.duplicates.length} duplicates, ${report.conflicts.length} conflicts`);

  await fs.rm(root, { recursive: true, force: true });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
