import path from 'path';
import { analyzeMissionOutcomes } from '../src/intelligence/mission-outcome-analytics';
import { ensureDir, writeFileAtomic } from '../src/utils/fs';

async function main(): Promise<void> {
  const repoRoot = process.cwd();
  const backlogPath = path.join(repoRoot, 'cmos', 'missions', 'backlog.yaml');
  const sessionsPath = path.join(repoRoot, 'SESSIONS.jsonl');
  const outputDir = path.join(repoRoot, 'artifacts', 'mission-outcomes');
  const outputPath = path.join(outputDir, 'latest.json');

  const analytics = await analyzeMissionOutcomes({
    backlogFile: backlogPath,
    sessionsFile: sessionsPath,
  });

  await ensureDir(outputDir);
  await writeFileAtomic(outputPath, JSON.stringify(analytics, null, 2));

  console.log(`Mission outcome analytics written to ${path.relative(repoRoot, outputPath)}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
