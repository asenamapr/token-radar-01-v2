// main.ts — radar-3 entrypoint (program/v1, Node 22 stdlib only).
//
// Reads the sealed snapshot, fits the radar-3 model, writes the ranked board to
// <output>/board.json, the dashboard data to <output>/data.js, copies
// dashboard/ and screenshots/ to <output>, and writes <output>/dossier.json with
// buildDossier from vendor/makefun-board.ts.
//
// The snapshot path defaults to /input/snapshot.json and takes --input <path>.
// The output directory is MAKEFUN_OUTPUT_DIR, default /output.
//
// The run is deterministic: no clock, no Math.random — the model's only
// randomness is a seeded PRNG — so two runs write byte-identical trees.
//
// The run refuses to finish (exit 1) when screenshots/ does not hold exactly the
// three required screenshots — but only after board.json, data.js and dashboard/
// are written, so the screenshots can be rendered from the output and the run
// repeated to completion.

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-board.ts';
import { buildAll, gateCheck } from './lib/model.ts';
import type { Snapshot } from './lib/model.ts';

const REPO_ROOT = dirname(fileURLToPath(import.meta.url));
const REQUIRED_SHOTS = ['1-board.png', '2-detail.png', '3-filtered.png'];

function parseArgs(argv: string[]): { input: string } {
  let input = '/input/snapshot.json';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--input' && i + 1 < argv.length) input = argv[++i];
  }
  return { input };
}

function main(): void {
  const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
  const { input } = parseArgs(process.argv.slice(2));

  const snap = JSON.parse(readFileSync(input, 'utf8')) as Snapshot;
  const { board, data, summary } = buildAll(snap);
  gateCheck(board, snap);

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'board.json'), JSON.stringify(board, null, 2) + '\n', 'utf8');
  writeFileSync(join(outDir, 'data.js'), `window.RADAR = ${JSON.stringify(data)};\n`, 'utf8');
  cpSync(join(REPO_ROOT, 'dashboard'), join(outDir, 'dashboard'), { recursive: true });
  const shotsSrc = join(REPO_ROOT, 'screenshots');
  if (existsSync(shotsSrc)) cpSync(shotsSrc, join(outDir, 'screenshots'), { recursive: true });

  const shotsDir = join(outDir, 'screenshots');
  const have = existsSync(shotsDir)
    ? readdirSync(shotsDir).filter((n) => !n.startsWith('.')).sort()
    : [];
  if (have.length !== REQUIRED_SHOTS.length || !REQUIRED_SHOTS.every((n, i) => have[i] === n)) {
    console.error(
      `radar-3: screenshots/ does not hold exactly the 3 required screenshots ` +
        `(found: ${have.join(', ') || 'none'}). board.json, data.js and dashboard/ are written; ` +
        `render the screenshots from the output dashboard and re-run.`,
    );
    process.exit(1);
  }
  // Each screenshot must be a whole PNG before the dossier is built from it.
  const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (const name of REQUIRED_SHOTS) {
    const bytes = readFileSync(join(shotsDir, name));
    if (bytes.length < 8 || !PNG_MAGIC.every((b, i) => bytes[i] === b)) {
      console.error(`radar-3: screenshots/${name} is not a whole PNG; re-render it and re-run.`);
      process.exit(1);
    }
    if (bytes.length > 512 * 1024) {
      console.error(`radar-3: screenshots/${name} is ${bytes.length} bytes, over the 512 KiB cap; re-render it smaller and re-run.`);
      process.exit(1);
    }
  }

  const dossier = buildDossier(outDir, { text_max_bytes: 65536 });
  writeFileSync(join(outDir, 'dossier.json'), dossier);
  // Verify the written outputs by re-reading them: the board must parse with
  // the same row count, and the dossier must be inside its size cap.
  const writtenBoard = JSON.parse(readFileSync(join(outDir, 'board.json'), 'utf8')) as { rows: unknown[] };
  if (writtenBoard.rows.length !== board.rows.length) {
    console.error('radar-3: board.json re-read with a different row count; refusing to finish.');
    process.exit(1);
  }
  if (dossier.length > 1.5 * 1024 * 1024) {
    console.error(`radar-3: dossier.json is ${dossier.length} bytes, over the 1.5 MiB cap.`);
    process.exit(1);
  }
  console.log(
    `radar-3: ${summary.boardRows} rows (${summary.watchlistCount} watchlist, ` +
      `${summary.aboveFloorRankable} above the floor, ${summary.belowFloorRankable} below), ` +
      `${summary.liveCount} live tokens; top ${summary.topSlug} $${summary.topImplied} implied; ` +
      `OOS ensemble MAE-log ${summary.oos.ensemble.maeLog.toFixed(3)} ` +
      `(+${summary.oos.ensemble.improvementPct.toFixed(1)}% vs baseline); ` +
      `bootstrap median +${summary.bootstrap.medianImprovementPct.toFixed(1)}%; ` +
      `growth-tilt weight ${summary.growthTilt.weight.toFixed(2)}; ` +
      `dossier ${dossier.length} bytes.`,
  );
}

main();
