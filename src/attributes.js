const fs = require('fs');
const path = require('path');
const os = require('os');
const logger = require('./logger');

const ATTRIBUTES_DIR = path.join(os.homedir(), '.atlasexplorer', 'attributes');

class AttributeService {
  constructor() {
    this.ensureDirectories();
  }

  ensureDirectories() {
    if (!fs.existsSync(ATTRIBUTES_DIR)) {
      fs.mkdirSync(ATTRIBUTES_DIR, { recursive: true });
    }
  }

  loadAttributes() {
    const attributes = {};
    try {
      const files = fs.readdirSync(ATTRIBUTES_DIR);
      for (const file of files) {
        if (file.endsWith('.json')) {
          const filePath = path.join(ATTRIBUTES_DIR, file);
          const content = fs.readFileSync(filePath, 'utf8');
          const attr = JSON.parse(content);
          if (!attr.description) attr.description = '';
          if (!attr.type) attr.type = 'String';
          if (attr.default === undefined) attr.default = '';
          if (!attr.options) attr.options = [];
          attributes[attr.name] = attr;
        }
      }
    } catch (err) {
      logger.error('Error loading attributes:', err.message);
    }
    return attributes;
  }

  getAttribute(name) {
    const attributes = this.loadAttributes();
    return attributes[name] || null;
  }

  createAttribute(name, description = '', type = 'String', defaultValue = '', options = []) {
    const attr = { name, description, type, default: defaultValue, options };
    const filePath = path.join(ATTRIBUTES_DIR, `${name}.json`);
    fs.writeFileSync(filePath, JSON.stringify(attr, null, 2));
    return attr;
  }

  updateAttribute(name, description = '', type = 'String', defaultValue = '', options = []) {
    const attr = { name, description, type, default: defaultValue, options };
    const filePath = path.join(ATTRIBUTES_DIR, `${name}.json`);
    fs.writeFileSync(filePath, JSON.stringify(attr, null, 2));
    return attr;
  }

  deleteAttribute(name) {
    const filePath = path.join(ATTRIBUTES_DIR, `${name}.json`);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }
}

module.exports = new AttributeService();
