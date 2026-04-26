// Build a store-ready zip of the extension.
//
// The list of files to ship is derived from manifest.json — Chrome's view of
// the extension is the single source of truth. Add a new content script,
// HTML page, or icon to the manifest and `npm run package` picks it up with
// no further edits here.
//
// We resolve paths the manifest itself names, plus, for any HTML page
// referenced by the manifest, the local <script src=…> and <link href=…>
// URLs found inside it. That's a deliberately shallow one-level scan —
// enough for a vanilla-JS extension, not a real bundler. Remote URLs
// (http/https/protocol-relative/data:) are skipped.
//
// Implemented with `zip` (the BSD/Info-ZIP CLI) because Node's stdlib has no
// zip writer. macOS, Linux, and Git-Bash on Windows all ship it.

import { readFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = resolve(ROOT, 'dist');

const manifest = JSON.parse(readFileSync(resolve(ROOT, 'manifest.json'), 'utf8'));

// Collect every local file path Chrome will load. Posix paths throughout
// (extensions ship with forward slashes regardless of host OS).
const files = new Set(['manifest.json']);

const isRemote = (p) => /^(?:https?:)?\/\//i.test(p) || p.startsWith('data:');
const add = (p) => {
    if (!p || typeof p !== 'string' || isRemote(p)) return;
    files.add(p.replace(/^\.?\//, ''));
};

// --- direct manifest references --------------------------------------------
if (manifest.icons) Object.values(manifest.icons).forEach(add);
if (manifest.action?.default_icon) {
    // default_icon is either a string or a {size: path} map.
    const di = manifest.action.default_icon;
    if (typeof di === 'string') add(di);
    else Object.values(di).forEach(add);
}
add(manifest.action?.default_popup);
add(manifest.background?.service_worker);
add(manifest.side_panel?.default_path);
add(manifest.options_ui?.page);
add(manifest.devtools_page);
for (const cs of manifest.content_scripts ?? []) {
    (cs.js ?? []).forEach(add);
    (cs.css ?? []).forEach(add);
}
for (const wa of manifest.web_accessible_resources ?? []) {
    (wa.resources ?? []).forEach(add);
}

// --- one-level scan of any HTML pages we just collected --------------------
// Pull <script src="..."> and <link ... href="..."> with local URLs.
const SRC_RE = /<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi;
const HREF_RE = /<link\b[^>]*\bhref\s*=\s*["']([^"']+)["']/gi;

const htmlPages = [...files].filter(f => f.endsWith('.html'));
for (const page of htmlPages) {
    const pagePath = resolve(ROOT, page);
    // Defer the missing-file complaint to the unified existence check below
    // so the user sees one tidy "Manifest references files that do not exist"
    // message instead of a raw ENOENT stack trace.
    if (!existsSync(pagePath)) continue;
    const html = readFileSync(pagePath, 'utf8');
    const baseDir = posix.dirname(page);
    for (const re of [SRC_RE, HREF_RE]) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(html))) {
            const ref = m[1];
            if (isRemote(ref)) continue;
            // Resolve relative to the HTML page, normalised to a posix path.
            add(posix.normalize(posix.join(baseDir, ref)));
        }
    }
}

const FILES = [...files].sort();

// --- sanity checks ---------------------------------------------------------
if (FILES.length === 0) {
    console.error('No files resolved from manifest.json — refusing to build empty zip.');
    process.exit(1);
}
const missing = FILES.filter(f => !existsSync(resolve(ROOT, f)));
if (missing.length) {
    console.error('Manifest references files that do not exist:\n  ' + missing.join('\n  '));
    process.exit(1);
}

// --- build -----------------------------------------------------------------
const version = manifest.version;
const zipName = `gpu-mem-extension-${version}.zip`;
const zipPath = resolve(DIST, zipName);

mkdirSync(DIST, { recursive: true });
// Remove any prior zip with the same version so the build is reproducible.
rmSync(zipPath, { force: true });

// `-j` flattens stored paths so Chrome sees a flat layout when the zip is
// unpacked, matching how the extension lives on disk.
execFileSync('zip', ['-j', zipPath, ...FILES], { cwd: ROOT, stdio: 'inherit' });

console.log(`\n→ ${zipPath}  (${FILES.length} files)`);
