'use strict';

/**
 * server/install.js
 *
 * One-shot setup wizard. Run once after cloning:
 *   node server/install.js
 *
 * Steps:
 *   1. Copy config.example.js → config.js (if not already present)
 *   2. Run npm install inside server/
 *   3. Prompt for password → hash → write into config.js
 *   4. Run build.js to produce dist/
 */

const path      = require('path');
const fs        = require('fs');
const readline  = require('readline');
const { execSync } = require('child_process');

const SERVER_DIR  = __dirname;
const CONFIG_PATH = path.join(SERVER_DIR, 'config.js');
const CONFIG_EXAMPLE = path.join(SERVER_DIR, 'config.example.js');

function ask(rl, question) {
  return new Promise(resolve => rl.question(question, resolve));
}

async function main() {
  console.log('\n=== Atlas Explorer Server — Setup ===\n');

  // Step 1: Copy config example
  if (!fs.existsSync(CONFIG_PATH)) {
    console.log('Creating config.js from config.example.js...');
    fs.copyFileSync(CONFIG_EXAMPLE, CONFIG_PATH);
    console.log('  Created config.js — edit it to change port, dataDir, etc.\n');
  } else {
    console.log('config.js already exists — skipping copy.\n');
  }

  // Step 2: npm install
  console.log('Installing server dependencies (npm install)...');
  try {
    execSync('npm install', { cwd: SERVER_DIR, stdio: 'inherit' });
    console.log('  Dependencies installed.\n');
  } catch (err) {
    console.error('npm install failed:', err.message);
    process.exit(1);
  }

  // Step 3: Set password
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const password = await ask(rl, 'Set login password: ');
  rl.close();

  if (!password || !password.trim()) {
    console.error('Password cannot be empty. Run `node server/hash-password.js <password>` to set it later.');
  } else {
    try {
      execSync(`node hash-password.js "${password.replace(/"/g, '\\"')}"`, {
        cwd: SERVER_DIR,
        stdio: 'inherit',
      });
    } catch (err) {
      console.error('hash-password.js failed:', err.message);
      process.exit(1);
    }
  }

  // Step 4: Build
  console.log('\nBuilding renderer (node server/build.js)...');
  try {
    execSync('node build.js', { cwd: SERVER_DIR, stdio: 'inherit' });
    console.log('  Build complete.\n');
  } catch (err) {
    console.error('Build failed:', err.message);
    process.exit(1);
  }

  console.log('=== Setup complete ===');
  console.log('Start the server with:  node server/run.js');
  console.log('Or from repo root:      npm run server\n');
}

main().catch(err => {
  console.error('Unexpected error:', err.message);
  process.exit(1);
});
