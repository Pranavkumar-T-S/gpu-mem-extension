// Cut a milestone:
//   1. Refuse to release on a dirty working tree (lost work risk).
//   2. Refuse if the v<version> tag already exists (double-release risk).
//   3. Build the zip via package.mjs.
//   4. Create an annotated git tag matching the manifest version.
//
// Pushing the tag is left manual on purpose, so a bad tag is easy to delete
// locally before it's published. After this script runs, do:
//   git push --follow-tags

import { readFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function git(args, opts = {}) {
    return execFileSync('git', args, {
        cwd: ROOT,
        encoding: 'utf8',
        ...opts,
    }).trim();
}

// 1. Working tree must be clean. `status --porcelain` prints nothing iff there
// are no uncommitted changes (tracked or untracked).
const dirty = git(['status', '--porcelain']);
if (dirty) {
    console.error('Working tree is dirty. Commit or stash before releasing:\n');
    console.error(dirty);
    process.exit(1);
}

const manifest = JSON.parse(readFileSync(resolve(ROOT, 'manifest.json'), 'utf8'));
const tag = `v${manifest.version}`;

// 2. Don't clobber an existing tag — annotated tags should be unique milestones.
const tagExists = spawnSync(
    'git',
    ['rev-parse', '--verify', '--quiet', `refs/tags/${tag}`],
    { cwd: ROOT },
).status === 0;
if (tagExists) {
    console.error(`Tag ${tag} already exists. Bump the version first (npm run bump:patch).`);
    process.exit(1);
}

// 3. Build the zip. Inheriting stdio so the user sees zip's progress output.
execFileSync('node', [resolve(ROOT, 'scripts/package.mjs')], {
    cwd: ROOT,
    stdio: 'inherit',
});

// 4. Annotated tag, message = "Release v0.1.1".
git(['tag', '-a', tag, '-m', `Release ${tag}`]);
console.log(`\n✓ tagged ${tag}`);
console.log(`  publish with: git push --follow-tags`);
