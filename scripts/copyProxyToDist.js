const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const proxyDir = path.join(projectRoot, 'proxy');
const targetDir = path.join(projectRoot, 'dist', 'proxy');

if (!fs.existsSync(proxyDir)) {
  console.warn('Proxy directory not found; skipping copy.');
  process.exit(0);
}

function copyDirectory(src, dest) {
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }

  const skip = new Set(['osm-cache', 'cache.json', 'proxy.log']);

  for (const entry of fs.readdirSync(src)) {
    if (skip.has(entry)) {
      continue;
    }
    const srcPath = path.join(src, entry);
    const destPath = path.join(dest, entry);
    const stats = fs.statSync(srcPath);

    if (stats.isDirectory()) {
      copyDirectory(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

copyDirectory(proxyDir, targetDir);
process.exit(0);


