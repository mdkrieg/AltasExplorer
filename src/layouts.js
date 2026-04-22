const fs = require('fs');
const path = require('path');
const os = require('os');
const AdmZip = require('adm-zip');
const logger = require('./logger');

const LAYOUTS_DIR = path.join(os.homedir(), '.atlasexplorer', 'layouts');

class LayoutService {
  constructor() {
    this.ensureDirectory();
  }

  ensureDirectory() {
    if (!fs.existsSync(LAYOUTS_DIR)) {
      fs.mkdirSync(LAYOUTS_DIR, { recursive: true });
    }
  }

  getDefaultDirectory() {
    return LAYOUTS_DIR;
  }

  saveLayout(filePath, layoutData, screenshotBuffer) {
    const zip = new AdmZip();
    zip.addFile('layout.json', Buffer.from(JSON.stringify(layoutData, null, 2), 'utf8'));
    if (screenshotBuffer) {
      zip.addFile('thumbnail.png', screenshotBuffer);
    }
    zip.writeZip(filePath);
    logger.info(`Layout saved to ${filePath}`);
  }

  listLayouts() {
    this.ensureDirectory();
    const files = fs.readdirSync(LAYOUTS_DIR).filter(f => f.toLowerCase().endsWith('.aly'));
    const results = [];
    for (const file of files) {
      const filePath = path.join(LAYOUTS_DIR, file);
      try {
        const zip = new AdmZip(filePath);
        const layoutEntry = zip.getEntry('layout.json');
        const layoutData = layoutEntry ? JSON.parse(zip.readAsText(layoutEntry)) : null;
        let thumbnailBase64 = null;
        const thumbnailEntry = zip.getEntry('thumbnail.png');
        if (thumbnailEntry) {
          thumbnailBase64 = zip.readFile(thumbnailEntry).toString('base64');
        }
        const stat = fs.statSync(filePath);
        results.push({
          fileName: file,
          filePath,
          savedAt: layoutData?.savedAt || stat.mtime.toISOString(),
          panelCount: layoutData?.layout?.currentLayout || null,
          description: layoutData?.description || null,
          thumbnailBase64,
        });
      } catch (err) {
        logger.warn(`Skipping corrupt layout file: ${file} - ${err.message}`);
      }
    }
    // Sort by most recent first
    results.sort((a, b) => new Date(b.savedAt) - new Date(a.savedAt));
    return results;
  }

  deleteLayout(filePath) {
    if (!fs.existsSync(filePath)) {
      throw new Error(`Layout file not found: ${filePath}`);
    }
    // Only allow deleting files within the layouts directory
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(path.resolve(LAYOUTS_DIR))) {
      throw new Error('Cannot delete files outside the layouts directory');
    }
    fs.unlinkSync(filePath);
    logger.info(`Layout deleted: ${filePath}`);
  }

  loadLayout(filePath) {
    if (!fs.existsSync(filePath)) {
      throw new Error(`Layout file not found: ${filePath}`);
    }

    const zip = new AdmZip(filePath);
    const layoutEntry = zip.getEntry('layout.json');
    if (!layoutEntry) {
      throw new Error('Invalid .aly file: missing layout.json');
    }

    const layoutData = JSON.parse(zip.readAsText(layoutEntry));
    if (!layoutData.version) {
      throw new Error('Invalid .aly file: missing version field');
    }
    if (layoutData.version > 1) {
      throw new Error('This layout file was created with a newer version of AtlasExplorer');
    }

    let thumbnailBase64 = null;
    const thumbnailEntry = zip.getEntry('thumbnail.png');
    if (thumbnailEntry) {
      thumbnailBase64 = zip.readFile(thumbnailEntry).toString('base64');
    }

    return { layoutData, thumbnailBase64, description: layoutData.description || null };
  }
}

module.exports = new LayoutService();
