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
      path.join(__dirname, '..', 'resources', 'icons'),
      path.join(__dirname, '..', 'assets', 'icons')
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
   * 1. Tinting folder-inside.png (white mask) with bgColor → fills the folder interior
   * 2. Tinting folder.png (black outline) with outlineColor → the folder outline
   * 3. Optionally rendering 1–2 initials as SVG text in the textColor over the icon
   * 4. Compositing all layers, preserving transparency throughout
   * 5. Resizing to 64x64 (standard Electron taskbar)
   */
  async generateWindowIcon(bgColor, outlineColor, initials = null) {
    try {
      const insideSource = path.join(USER_ICONS_DIR, 'folder-inside.png');
      const outlineSource = ICON_SOURCE; // folder.png

      if (!fs.existsSync(outlineSource)) {
        logger.warn('Icon source file not found:', outlineSource);
        return null;
      }
      if (!fs.existsSync(insideSource)) {
        logger.warn('folder-inside.png not found:', insideSource);
        return null;
      }

      const bgRGB = this.parseRGB(bgColor);
      const outlineRGB = this.parseRGB(outlineColor);

      // --- folder-inside.png: replace all visible pixels with bgColor ---
      const { data: insideData, info: insideInfo } = await sharp(insideSource)
        .raw().toBuffer({ resolveWithObject: true });

      for (let i = 0; i < insideData.length; i += 4) {
        if (insideData[i + 3] > 10) {
          insideData[i]     = bgRGB.r;
          insideData[i + 1] = bgRGB.g;
          insideData[i + 2] = bgRGB.b;
          // preserve alpha for smooth anti-aliased edges
        }
      }

      const insideColored = await sharp(insideData, {
        raw: { width: insideInfo.width, height: insideInfo.height, channels: insideInfo.channels }
      }).png().toBuffer();

      // --- folder.png: replace dark pixels with outlineColor ---
      const { data: outlineData, info: outlineInfo } = await sharp(outlineSource)
        .raw().toBuffer({ resolveWithObject: true });

      for (let i = 0; i < outlineData.length; i += 4) {
        const brightness = (outlineData[i] + outlineData[i + 1] + outlineData[i + 2]) / 3;
        if (outlineData[i + 3] > 10 && brightness < 128) {
          outlineData[i]     = outlineRGB.r;
          outlineData[i + 1] = outlineRGB.g;
          outlineData[i + 2] = outlineRGB.b;
        }
      }

      const outlineColored = await sharp(outlineData, {
        raw: { width: outlineInfo.width, height: outlineInfo.height, channels: outlineInfo.channels }
      }).png().toBuffer();

      // --- Build composite layers array ---
      const compositeLayers = [{ input: outlineColored, blend: 'over' }];

      // --- Optionally overlay initials as SVG text ---
      // Render at 2× native canvas size for crisp text, then downscale
      if (initials && initials.trim().length > 0) {
        const label = initials.trim().slice(0, 2).toUpperCase();
        const w = insideInfo.width;
        const h = insideInfo.height;
        const scale = 2;
        const sw = w * scale;
        const sh = h * scale;
        // Font size: ~40% of scaled height, positioned in the lower folder body area
        const fontSize = Math.round(sh * 0.40);
        const cx = Math.round(sw / 2);
        const cy = Math.round(sh * 0.68);
        const textHex = `#${outlineRGB.r.toString(16).padStart(2,'0')}${outlineRGB.g.toString(16).padStart(2,'0')}${outlineRGB.b.toString(16).padStart(2,'0')}`;
        // Use Impact/Arial Black for dense, pixel-friendly rendering
        const svgText = Buffer.from(
          `<svg xmlns="http://www.w3.org/2000/svg" width="${sw}" height="${sh}">` +
          `<text x="${cx}" y="${cy}" text-anchor="middle" dominant-baseline="middle"` +
          ` font-family="Verdana, Tahoma, 'Segoe UI', sans-serif" font-size="${fontSize}" font-weight="700"` +
          ` fill="${textHex}" letter-spacing="-1">${label}</text>` +
          `</svg>`
        );
        // Render text at 2× then downscale to native size for sharpness
        const textLayer = await sharp(svgText)
          .resize(w, h, { fit: 'fill', kernel: 'lanczos3' })
          .png()
          .toBuffer();
        compositeLayers.push({ input: textLayer, blend: 'over' });
      }

      // --- Composite: fill (bgColor) as base, then outline, then optional text ---
      const iconPng = await sharp(insideColored)
        .composite(compositeLayers)
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
