const fs = require('fs');
const path = require('path');
const os = require('os');
const logger = require('./logger');

const TAGS_DIR = path.join(os.homedir(), '.atlasexplorer', 'tags');

class TagService {
  constructor() {
    this.ensureDirectories();
  }

  /**
   * Ensure tags directory exists
   */
  ensureDirectories() {
    if (!fs.existsSync(TAGS_DIR)) {
      fs.mkdirSync(TAGS_DIR, { recursive: true });
    }
  }

  /**
   * Load all tag files from the tags directory
   */
  loadTags() {
    const tags = {};

    try {
      const files = fs.readdirSync(TAGS_DIR);

      for (const file of files) {
        if (file.endsWith('.json')) {
          const filePath = path.join(TAGS_DIR, file);
          const content = fs.readFileSync(filePath, 'utf8');
          const tag = JSON.parse(content);
          // Ensure backward compatibility: add description if missing
          if (!tag.description) {
            tag.description = '';
          }
          tags[tag.name] = tag;
        }
      }
    } catch (err) {
      logger.error('Error loading tags:', err.message);
    }

    return tags;
  }

  /**
   * Get a single tag by name
   */
  getTag(name) {
    const tags = this.loadTags();
    return tags[name] || null;
  }

  /**
   * Create a new tag
   */
  createTag(name, bgColor, textColor, description = '') {
    const tag = {
      name,
      bgColor,
      textColor,
      description
    };

    const filePath = path.join(TAGS_DIR, `${name}.json`);
    fs.writeFileSync(filePath, JSON.stringify(tag, null, 2));

    return tag;
  }

  /**
   * Update an existing tag
   */
  updateTag(name, bgColor, textColor, description = '') {
    const tag = {
      name,
      bgColor,
      textColor,
      description
    };

    const filePath = path.join(TAGS_DIR, `${name}.json`);
    fs.writeFileSync(filePath, JSON.stringify(tag, null, 2));

    return tag;
  }

  /**
   * Delete a tag
   */
  deleteTag(name) {
    const filePath = path.join(TAGS_DIR, `${name}.json`);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }
}

module.exports = new TagService();
