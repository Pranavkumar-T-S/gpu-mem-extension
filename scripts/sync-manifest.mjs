// Copy the version from package.json into manifest.json.
//
// `npm version` only knows how to bump package.json, but Chrome reads the
// version from manifest.json — so after every bump we mirror the new value
// across. This keeps a single source of truth (package.json, the file npm
// owns) while satisfying the extension's runtime requirement.

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkgPath = resolve(ROOT, 'package.json');
const manifestPath = resolve(ROOT, 'manifest.json');

const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));

// Read manifest as text so we can preserve its existing 4-space indentation
// rather than re-serialising and risking spurious diffs.
const manifestText = readFileSync(manifestPath, 'utf8');
const newText = manifestText.replace(
    /("version"\s*:\s*")[^"]+(")/,
    `$1${pkg.version}$2`,
);

if (newText === manifestText) {
    console.error('manifest.json: failed to update version field.');
    process.exit(1);
}

writeFileSync(manifestPath, newText);
console.log(`manifest.json version → ${pkg.version}`);
