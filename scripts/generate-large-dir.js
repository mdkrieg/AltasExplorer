#!/usr/bin/env node
/**
 * generate-large-dir.js
 *
 * Testing helper: creates (or refills) a folder named "large_dir" inside
 * the user's configured AtlasExplorer home directory and populates it with
 * N text files of M bytes each. File contents are random printable ASCII
 * arranged in fixed-width lines separated by CRLF, so they look natural
 * when opened in a text viewer.
 *
 * Usage:
 *   node scripts/generate-large-dir.js [-n <files>] [-m <bytes>] [-y]
 *
 * Defaults: n = 100 files, m = 1000 bytes, line width = 80 chars.
 * The script prompts before clearing an existing large_dir (use -y to skip).
 */

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const readline = require('readline');
const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Resolve AtlasExplorer config dir & home_directory setting
// ---------------------------------------------------------------------------
const CONFIG_DIR = path.join(os.homedir(), '.atlasexplorer');
const SETTINGS_PATH = path.join(CONFIG_DIR, 'settings.json');

function loadHomeDirectory() {
  if (!fs.existsSync(SETTINGS_PATH)) {
    throw new Error(`Settings file not found at ${SETTINGS_PATH}`);
  }
  const raw = fs.readFileSync(SETTINGS_PATH, 'utf8');
  const settings = JSON.parse(raw);
  if (!settings.home_directory || typeof settings.home_directory !== 'string') {
    throw new Error(`home_directory not configured in ${SETTINGS_PATH}`);
  }
  return settings.home_directory;
}

// ---------------------------------------------------------------------------
// Argument parsing (very small, no deps)
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const opts = { n: 100, m: 1000, lineWidth: 80, yes: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-n' || a === '--files')      opts.n = parseInt(argv[++i], 10);
    else if (a === '-m' || a === '--bytes') opts.m = parseInt(argv[++i], 10);
    else if (a === '-w' || a === '--width') opts.lineWidth = parseInt(argv[++i], 10);
    else if (a === '-y' || a === '--yes')   opts.yes = true;
    else if (a === '-h' || a === '--help') {
      console.log('Usage: node scripts/generate-large-dir.js [-n <files>] [-m <bytes>] [-w <lineWidth>] [-y]');
      process.exit(0);
    }
  }
  if (!Number.isFinite(opts.n) || opts.n <= 0)         throw new Error('Invalid -n value');
  if (!Number.isFinite(opts.m) || opts.m <= 0)         throw new Error('Invalid -m value');
  if (!Number.isFinite(opts.lineWidth) || opts.lineWidth <= 0) throw new Error('Invalid -w value');
  return opts;
}

// ---------------------------------------------------------------------------
// Random ASCII content with fixed-width CRLF lines, exact byte length
// ---------------------------------------------------------------------------
// Printable ASCII excluding space/control. Plenty of variety.
const CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

function randomLine(width) {
  const bytes = crypto.randomBytes(width);
  let out = '';
  for (let i = 0; i < width; i++) {
    out += CHARSET[bytes[i] % CHARSET.length];
  }
  return out;
}

/**
 * Build a buffer of exactly `byteCount` bytes laid out as
 *   <lineWidth chars>\r\n<lineWidth chars>\r\n...
 * The final line is truncated (without a trailing CRLF) so the total
 * byte count is exact.
 */
function buildContent(byteCount, lineWidth) {
  const chunks = [];
  let remaining = byteCount;
  const lineWithCrlf = lineWidth + 2; // \r\n

  while (remaining >= lineWithCrlf) {
    chunks.push(randomLine(lineWidth));
    chunks.push('\r\n');
    remaining -= lineWithCrlf;
  }
  // Tail: fill remainder with characters (no CRLF) so the file is exactly
  // byteCount bytes. If remaining is 1 we just write a single char.
  if (remaining > 0) {
    chunks.push(randomLine(remaining));
  }
  return Buffer.from(chunks.join(''), 'ascii');
}

// ---------------------------------------------------------------------------
// Y/n prompt
// ---------------------------------------------------------------------------
function promptYesNo(question, defaultYes = true) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const suffix = defaultYes ? '[Y/n]' : '[y/N]';
    rl.question(`${question} ${suffix} `, answer => {
      rl.close();
      const trimmed = (answer || '').trim().toLowerCase();
      if (trimmed === '') resolve(defaultYes);
      else resolve(trimmed === 'y' || trimmed === 'yes');
    });
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const homeDir = loadHomeDirectory();
  const targetDir = path.join(homeDir, 'large_dir');

  console.log(`AtlasExplorer home_directory : ${homeDir}`);
  console.log(`Target directory             : ${targetDir}`);
  console.log(`Files to create              : ${opts.n}`);
  console.log(`Bytes per file               : ${opts.m}`);
  console.log(`Line width (chars)           : ${opts.lineWidth}`);
  console.log('');

  if (!fs.existsSync(homeDir)) {
    throw new Error(`Configured home_directory does not exist: ${homeDir}`);
  }

  // Ensure target dir exists; ask before clearing
  if (fs.existsSync(targetDir)) {
    const stats = fs.statSync(targetDir);
    if (!stats.isDirectory()) {
      throw new Error(`Target path exists and is not a directory: ${targetDir}`);
    }
    const existingCount = fs.readdirSync(targetDir).length;
    let doClear = opts.yes;
    if (!doClear) {
      doClear = await promptYesNo(
        `large_dir already exists with ${existingCount} entries. Clear it?`,
        true
      );
    }
    if (doClear) {
      console.log('Clearing existing contents...');
      for (const entry of fs.readdirSync(targetDir)) {
        fs.rmSync(path.join(targetDir, entry), { recursive: true, force: true });
      }
    } else {
      console.log('Leaving existing contents in place; new files will be added alongside.');
    }
  } else {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  // Generate files
  const padWidth = String(opts.n).length;
  const startTime = Date.now();
  for (let i = 1; i <= opts.n; i++) {
    const indexStr = String(i).padStart(padWidth, '0');
    const filename = `file_${indexStr}.txt`;
    const filePath = path.join(targetDir, filename);
    const content = buildContent(opts.m, opts.lineWidth);
    fs.writeFileSync(filePath, content);
    if (i % 50 === 0 || i === opts.n) {
      process.stdout.write(`  wrote ${i}/${opts.n}\r`);
    }
  }
  const elapsedMs = Date.now() - startTime;
  console.log('');
  console.log(`Done. Created ${opts.n} files (${opts.m} bytes each) in ${elapsedMs} ms.`);
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
