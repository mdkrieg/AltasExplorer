const fs = require('fs');
const path = require('path');
const os = require('os');
const logger = require('./logger');
const db = require('./db');

const CATEGORIES_DIR = path.join(os.homedir(), '.atlasexplorer', 'categories');
const SETTINGS_PATH = path.join(os.homedir(), '.atlasexplorer', 'settings.json');
const HOTKEYS_PATH = path.join(os.homedir(), '.atlasexplorer', 'hotkeys.json');
const SOURCE_HOTKEYS_PATH = path.join(__dirname, '..', 'assets', 'hotkeys.json');

class CategoryService {
  constructor() {
    this.ensureDirectories();
    this.ensureHotkeysFile();
    this.migrateSettingsToDatabase();
  }

  /**
   * Ensure hotkeys.json exists with default hotkeys
   */
  ensureHotkeysFile() {
    if (!fs.existsSync(HOTKEYS_PATH)) {
      try {
        // Try to read from the source hotkeys file in assets
        if (fs.existsSync(SOURCE_HOTKEYS_PATH)) {
          const hotkeyContent = fs.readFileSync(SOURCE_HOTKEYS_PATH, 'utf8');
          fs.writeFileSync(HOTKEYS_PATH, hotkeyContent);
          logger.info('Created hotkeys.json from assets');
        } else {
          logger.warn(`Source hotkeys file not found at ${SOURCE_HOTKEYS_PATH}`);
        }
      } catch (err) {
        logger.error('Error reading source hotkeys file:', err.message);
      }
    }
  }

  /**
   * Ensure directories and default category exist
   */
  ensureDirectories() {
    // Create categories directory
    if (!fs.existsSync(CATEGORIES_DIR)) {
      fs.mkdirSync(CATEGORIES_DIR, { recursive: true });
    }

    // Create default category if it doesn't exist
    const defaultCategoryPath = path.join(CATEGORIES_DIR, 'Default.json');
    if (!fs.existsSync(defaultCategoryPath)) {
      const defaultCategory = {
        name: 'Default',
        bgColor: 'rgb(239, 228, 176)',
        textColor: 'rgb(0, 0, 0)',
        patterns: [],
        description: '',
        enableChecksum: false
      };
      fs.writeFileSync(defaultCategoryPath, JSON.stringify(defaultCategory, null, 2));
    }
  }

  /**
   * Migrate directory assignments from settings.json to database
   */
  migrateSettingsToDatabase() {
    try {
      const settings = this.getSettings();
      
      // Check if there are any directoryPaths to migrate
      if (settings.directoryPaths && Object.keys(settings.directoryPaths).length > 0) {
        logger.info('Migrating directory assignments from settings.json to database...');
        
        // Migrate each path
        for (const [dirPath, categoryName] of Object.entries(settings.directoryPaths)) {
          try {
            db.setCategoryForDirectory(dirPath, categoryName);
            logger.info(`Migrated assignment: ${dirPath} => ${categoryName}`);
          } catch (err) {
            logger.warn(`Failed to migrate assignment for ${dirPath}:`, err.message);
          }
        }
        
        // Remove directoryPaths from settings.json
        delete settings.directoryPaths;
        this.saveSettings(settings);
        
        logger.info('Migration completed: directoryPaths removed from settings.json');
      }
    } catch (err) {
      logger.warn('Error during settings migration:', err.message);
    }
  }

  /**
   * Load all category files from the categories directory
   */
  loadCategories() {
    const categories = {};

    try {
      const files = fs.readdirSync(CATEGORIES_DIR);

      for (const file of files) {
        if (file.endsWith('.json')) {
          const filePath = path.join(CATEGORIES_DIR, file);
          const content = fs.readFileSync(filePath, 'utf8');
          const category = JSON.parse(content);
          // Ensure backward compatibility: add description if missing
          if (!category.description) {
            category.description = '';
          }
          // Ensure backward compatibility: add enableChecksum if missing
          if (category.enableChecksum === undefined) {
            category.enableChecksum = false;
          }
          categories[category.name] = category;
        }
      }
    } catch (err) {
      logger.error('Error loading categories:', err.message);
    }

    return categories;
  }

  /**
   * Get a single category by name
   */
  getCategory(name) {
    const categories = this.loadCategories();
    return categories[name] || null;
  }

  /**
   * Create a new category
   */
  createCategory(name, bgColor, textColor, patterns = [], description = '', enableChecksum = false) {
    if (name === 'Default') {
      throw new Error('Cannot create a category named "Default" - it already exists');
    }

    const category = {
      name,
      bgColor,
      textColor,
      patterns,
      description,
      enableChecksum
    };

    const filePath = path.join(CATEGORIES_DIR, `${name}.json`);
    fs.writeFileSync(filePath, JSON.stringify(category, null, 2));

    return category;
  }

  /**
   * Update an existing category
   */
  updateCategory(name, bgColor, textColor, patterns = [], description = '', enableChecksum = null) {
    // Get existing category to preserve enableChecksum if not specified
    const existingCategory = this.getCategory(name);
    const checksumSetting = enableChecksum !== null ? enableChecksum : (existingCategory?.enableChecksum || false);

    const category = {
      name,
      bgColor,
      textColor,
      patterns,
      description,
      enableChecksum: checksumSetting
    };

    const filePath = path.join(CATEGORIES_DIR, `${name}.json`);
    fs.writeFileSync(filePath, JSON.stringify(category, null, 2));

    return category;
  }

  /**
   * Delete a category (prevent deletion of Default)
   */
  deleteCategory(name) {
    if (name === 'Default') {
      throw new Error('Cannot delete the Default category');
    }

    const filePath = path.join(CATEGORIES_DIR, `${name}.json`);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    // Note: Directories that had this category assigned will remain in the database with that category name.
    // On next scan, if the category doesn't exist in the category files, the directory will fall back
    // to pattern matching or the Default category.
  }

  /**
   * Get settings object (load from settings.json)
   */
  getSettings() {
    try {
      const content = fs.readFileSync(SETTINGS_PATH, 'utf8');
      const settings = JSON.parse(content);
      // Ensure home_directory exists
      if (!settings.home_directory) {
        settings.home_directory = os.homedir();
      }
      // Ensure notes_format exists with default
      if (!settings.notes_format) {
        settings.notes_format = 'Markdown';
      }
      return settings;
    } catch {
      return { 
        home_directory: os.homedir(),
        notes_format: 'Markdown'
      };
    }
  }

  /**
   * Save settings object
   */
  saveSettings(settings) {
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
  }

  /**
   * Get hotkeys object (load from hotkeys.json)
   */
  getHotkeys() {
    try {
      const content = fs.readFileSync(HOTKEYS_PATH, 'utf8');
      return JSON.parse(content);
    } catch (err) {
      logger.error('Error loading hotkeys:', err.message);
      // Return defaults if file cannot be read
      return {
        'Panel Navigation': {
          'navigate_back': { label: 'Navigate Back', key: 'Alt+Left', default: 'Alt+Left' },
          'navigate_forward': { label: 'Navigate Forward', key: 'Alt+Right', default: 'Alt+Right' },
          'navigate_up': { label: 'Go to Parent', key: 'Alt+Up', default: 'Alt+Up' },
          'add_panel': { label: 'Add Panel', key: 'Ctrl+T', default: 'Ctrl+T' },
          'enter_path': { label: 'Enter Path', key: 'Enter', default: 'Enter' },
          'cancel_path': { label: 'Cancel Path', key: 'Escape', default: 'Escape' }
        },
        'Notes': {
          'edit_notes': { label: 'Edit Notes', key: 'F2', default: 'F2' },
          'save_notes': { label: 'Save Notes', key: 'Ctrl+S', default: 'Ctrl+S' }
        }
      };
    }
  }

  /**
   * Save hotkeys object with validation (no duplicates within context)
   */
  saveHotkeys(hotkeyData) {
    try {
      // Validate no duplicates within each context
      for (const context of Object.values(hotkeyData)) {
        const usedKeys = {};
        for (const [actionId, actionData] of Object.entries(context)) {
          const key = actionData.key;
          if (usedKeys[key]) {
            throw new Error(`Duplicate hotkey '${key}' within context: assigned to both '${usedKeys[key]}' and '${actionId}'`);
          }
          usedKeys[key] = actionId;
        }
      }
      fs.writeFileSync(HOTKEYS_PATH, JSON.stringify(hotkeyData, null, 2));
      logger.info('Hotkeys saved successfully');
    } catch (err) {
      logger.error('Error saving hotkeys:', err.message);
      throw err;
    }
  }

  /**
   * Set category assignment for a directory in the database
   */
  setCategoryForDirectory(dirPath, categoryName) {
    db.setCategoryForDirectory(dirPath, categoryName);
  }

  /**
   * Get category assignment for a directory from the database
   */
  getCategoryFromDatabase(dirPath) {
    return db.getCategoryForDirectory(dirPath);
  }

  /**
   * Check if a directory path matches a pattern (regex)
   */
  matchesPattern(dirPath, pattern) {
    try {
      const regex = new RegExp(pattern);
      const dirName = path.basename(dirPath);
      return regex.test(dirName);
    } catch {
      return false;
    }
  }

  /**
   * Get the applicable category for a directory
   * Priority: 1) Per-directory assignment (from database), 2) Pattern matching, 3) Default
   */
  getCategoryForDirectory(dirPath) {
    const categories = this.loadCategories();

    // 1. Check per-directory assignment in database
    const assignment = this.getCategoryFromDatabase(dirPath);
    if (assignment && categories[assignment]) {
      return categories[assignment];
    }

    // 2. Check pattern-based assignments
    for (const [categoryName, category] of Object.entries(categories)) {
      if (category.patterns && Array.isArray(category.patterns)) {
        for (const pattern of category.patterns) {
          if (this.matchesPattern(dirPath, pattern)) {
            return category;
          }
        }
      }
    }

    // 3. Fall back to Default
    return categories['Default'] || this.createDefaultCategory();
  }

  /**
   * Create the Default category if it doesn't exist
   */
  createDefaultCategory() {
    return {
      name: 'Default',
      bgColor: 'rgb(239, 228, 176)',
      textColor: 'rgb(0, 0, 0)',
      patterns: []
    };
  }
}

module.exports = new CategoryService();
