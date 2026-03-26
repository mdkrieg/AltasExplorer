const fs = require('fs');
const path = require('path');
const os = require('os');

const CATEGORIES_DIR = path.join(os.homedir(), '.bestexplorer', 'categories');
const SETTINGS_PATH = path.join(os.homedir(), '.bestexplorer', 'settings.json');

class CategoryService {
  constructor() {
    this.ensureDirectories();
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
      console.error('Error loading categories:', err.message);
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

    // Remove from per-directory assignments if present
    this.removeDirectoryAssignments(name);
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
      return settings;
    } catch {
      return { 
        directoryPaths: {},
        home_directory: os.homedir()
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
   * Assign a category to a directory
   */
  assignCategoryToDirectory(dirPath, categoryName) {
    const settings = this.getSettings();
    if (!settings.directoryPaths) {
      settings.directoryPaths = {};
    }

    settings.directoryPaths[dirPath] = categoryName;
    this.saveSettings(settings);
  }

  /**
   * Get category assignment for a directory
   */
  getDirectoryAssignment(dirPath) {
    const settings = this.getSettings();
    return settings.directoryPaths?.[dirPath] || null;
  }

  /**
   * Get all per-directory assignments
   */
  getAllDirectoryAssignments() {
    const settings = this.getSettings();
    return settings.directoryPaths || {};
  }

  /**
   * Remove a directory assignment
   */
  removeDirectoryAssignment(dirPath) {
    const settings = this.getSettings();
    if (settings.directoryPaths?.[dirPath]) {
      delete settings.directoryPaths[dirPath];
      this.saveSettings(settings);
    }
  }

  /**
   * Remove all assignments for a category
   */
  removeDirectoryAssignments(categoryName) {
    const settings = this.getSettings();
    if (settings.directoryPaths) {
      for (const [dirPath, catName] of Object.entries(settings.directoryPaths)) {
        if (catName === categoryName) {
          delete settings.directoryPaths[dirPath];
        }
      }
      this.saveSettings(settings);
    }
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
   * Priority: 1) Per-directory assignment, 2) Pattern matching, 3) Default
   */
  getCategoryForDirectory(dirPath) {
    const categories = this.loadCategories();

    // 1. Check per-directory assignment
    const assignment = this.getDirectoryAssignment(dirPath);
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
