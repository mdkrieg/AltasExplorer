const fs = require('fs');
const path = require('path');
const os = require('os');

const src = path.join(__dirname, '..', 'assets', 'icons');
const destinations = [
  path.join(os.homedir(), '.atlasexplorer', 'icons'),
  path.join(__dirname, '..', 'public', 'assets', 'icons'),
];

function copyDir(srcDir, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const entries = fs.readdirSync(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

for (const dest of destinations) {
  copyDir(src, dest);
  console.log(`Synced assets/icons -> ${dest}`);
}
