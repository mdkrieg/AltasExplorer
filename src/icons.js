const fs = require('fs');
const sharp = require('sharp');
const path = require('path');
const os = require('os');
const logger = require('./logger');

const USER_ICONS_DIR = path.join(os.homedir(), '.atlasexplorer', 'icons');
const ICON_SOURCE = path.join(USER_ICONS_DIR, 'folder.png');

class IconService {
  constructor() {
    this.ensureIconAssets();
  }

  /**
   * Resolve where bundled icon assets live.
   * Supports both dev mode and packaged Electron builds.
   */
  resolveBundledIconsDir() {
    const candidates = [
      process.resourcesPath ? path.join(process.resourcesPath, 'icons') : null,
      process.resourcesPath ? path.join(process.resourcesPath, 'resources', 'icons') : null,
      path.join(__dirname, '..', 'resources', 'icons')
    ].filter(Boolean);

    for (const dir of candidates) {
      if (!fs.existsSync(dir)) {
        continue;
      }

      const files = fs.readdirSync(dir);
      if (files.length > 0) {
        return dir;
      }
    }

    return null;
  }

  /**
   * Ensure ~/.atlasexplorer/icons exists and contains bundled icon files.
   * Existing user files are preserved; only missing files are copied.
   */
  ensureIconAssets() {
    try {
      const sourceDir = this.resolveBundledIconsDir();
      if (!sourceDir) {
        logger.warn('No bundled icons directory found; skipping icon asset bootstrap');
        return;
      }

      if (!fs.existsSync(USER_ICONS_DIR)) {
        fs.mkdirSync(USER_ICONS_DIR, { recursive: true });
      }

      const sourceEntries = fs.readdirSync(sourceDir, { withFileTypes: true });
      for (const entry of sourceEntries) {
        if (!entry.isFile()) {
          continue;
        }

        const sourcePath = path.join(sourceDir, entry.name);
        const targetPath = path.join(USER_ICONS_DIR, entry.name);

        if (!fs.existsSync(targetPath)) {
          fs.copyFileSync(sourcePath, targetPath);
        }
      }
    } catch (err) {
      logger.error('Error ensuring icon assets:', err.message);
    }
  }

  /**
   * Parse RGB color string to object
   * Input: "rgb(255, 0, 0)" -> { r: 255, g: 0, b: 0 }
   */
  parseRGB(colorString) {
    const match = colorString.match(/rgb\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/);
    if (match) {
      return {
        r: parseInt(match[1]),
        g: parseInt(match[2]),
        b: parseInt(match[3])
      };
    }
    // Default to black if parsing fails
    return { r: 0, g: 0, b: 0 };
  }

  /**
   * Generate a taskbar-ready icon by:
   * 1. Loading folder.png
   * 2. Replacing black pixels with textColor
   * 3. Adding a solid background with bgColor
   * 4. Resizing to 64x64 (standard Electron taskbar)
   */
  async generateWindowIcon(bgColor, textColor) {
    try {
      if (!fs.existsSync(ICON_SOURCE)) {
        logger.warn('Icon source file not found:', ICON_SOURCE);
        return null;
      }

      const bgRGB = this.parseRGB(bgColor);
      const textRGB = this.parseRGB(textColor);

      // Load the source icon
      let image = sharp(ICON_SOURCE);

      // Get metadata to preserve aspect ratio
      const metadata = await image.metadata();
      const size = Math.max(metadata.width, metadata.height);

      // Create a background canvas with bgColor and composite the folder icon on top
      const background = Buffer.alloc(size * size * 4);
      for (let i = 0; i < background.length; i += 4) {
        background[i] = bgRGB.r;     // R
        background[i + 1] = bgRGB.g; // G
        background[i + 2] = bgRGB.b; // B
        background[i + 3] = 255;     // A
      }

      // Composite: convert black pixels to textColor, white/transparent to bgColor
      const iconBuffer = await image
        .raw()
        .toBuffer({ resolveWithObject: true });

      const { data, info } = iconBuffer;

      // Replace colors in the icon
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        const a = data[i + 3];

        // If pixel is black or very dark (folder outline), replace with textColor
        const brightness = (r + g + b) / 3;
        if (brightness < 50 && a > 200) {
          data[i] = textRGB.r;
          data[i + 1] = textRGB.g;
          data[i + 2] = textRGB.b;
          // Keep alpha as is
        }
        // If pixel is transparent, make it background color
        else if (a < 200) {
          data[i] = bgRGB.r;
          data[i + 1] = bgRGB.g;
          data[i + 2] = bgRGB.b;
          data[i + 3] = 255;
        }
      }

      // Resize to 64x64 and return as PNG
      const iconPng = await sharp(data, {
        raw: {
          width: info.width,
          height: info.height,
          channels: info.channels
        }
      })
        .resize(64, 64, { fit: 'contain' })
        .png()
        .toBuffer();

      return iconPng;
    } catch (err) {
      logger.error('Error generating window icon:', err.message);
      return null;
    }
  }
}

module.exports = new IconService();
