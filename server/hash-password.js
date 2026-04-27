'use strict';

/**
 * server/hash-password.js
 *
 * One-time setup: hash a plaintext password and write it into config.js.
 *
 * Usage:
 *   node server/hash-password.js <yourpassword>
 */

const path   = require('path');
const fs     = require('fs');
const bcrypt = require('bcrypt');

const SALT_ROUNDS = 12;

async function main() {
  const password = process.argv[2];
  if (!password) {
    console.error('Usage: node server/hash-password.js <yourpassword>');
    process.exit(1);
  }

  console.log('Hashing password...');
  const hash = await bcrypt.hash(password, SALT_ROUNDS);

  const configPath = path.join(__dirname, 'config.js');
  if (!fs.existsSync(configPath)) {
    console.error(`config.js not found at ${configPath}`);
    console.error('Copy config.example.js to config.js first.');
    process.exit(1);
  }

  let content = fs.readFileSync(configPath, 'utf8');

  // Replace passwordHash: '' or passwordHash: 'anything'
  if (content.includes('passwordHash:')) {
    content = content.replace(
      /passwordHash:\s*'[^']*'/,
      `passwordHash: '${hash}'`
    );
    fs.writeFileSync(configPath, content, 'utf8');
    console.log('Password hash written to config.js.');
    console.log('Hash:', hash);
  } else {
    console.error('Could not find passwordHash field in config.js');
    console.log('Add this line manually:');
    console.log(`  passwordHash: '${hash}',`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
