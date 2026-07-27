// Copyright (c) 2026 Alden Lougee. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification,
// distribution, reverse-engineering, or derivative use is prohibited.

// Records a release's build hash to transparency/release-hashes.json.
// Run after exporting an .ipa in Xcode, then commit + push the result —
// the git history is the transparency log, not the running server.
//
// Usage:
//   node scripts/record-release-hash.mjs <tonelayer|clarity> <version> <build> <path-to-ipa>

import { createHash } from 'crypto';
import { readFileSync, writeFileSync } from 'fs';
import path from 'path';

const [app, version, build, artifactPath] = process.argv.slice(2);

if (!app || !version || !build || !artifactPath) {
  console.error('Usage: node scripts/record-release-hash.mjs <tonelayer|clarity> <version> <build> <path-to-ipa>');
  process.exit(1);
}

const fileBuffer = readFileSync(artifactPath);
const sha256 = createHash('sha256').update(fileBuffer).digest('hex');
const date = new Date().toISOString().slice(0, 10);

const logPath = path.join(process.cwd(), 'transparency', 'release-hashes.json');
const entries = JSON.parse(readFileSync(logPath, 'utf8'));

entries.push({ app, version, build, sha256, date });
writeFileSync(logPath, JSON.stringify(entries, null, 2) + '\n');

console.log('Recorded:', entries[entries.length - 1]);
console.log('Now commit and push transparency/release-hashes.json');
