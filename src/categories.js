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
        enableChecksum: false,
        attributes: [],
        autoAssignCategory: null,
        displayMode: 'details'
      };
      fs.writeFileSync(defaultCategoryPath, JSON.stringify(defaultCategory, null, 2));
    }
  }

  normalizeAutoAssignCategory(autoAssignCategory) {
    if (autoAssignCategory === undefined || autoAssignCategory === null) {
      return null;
    }

    const normalizedValue = String(autoAssignCategory).trim();
    if (!normalizedValue || normalizedValue.toLowerCase() === 'none') {
      return null;
    }

    return normalizedValue;
  }

  validateAutoAssignCategory(name, autoAssignCategory, existingCategories = null) {
    const normalizedTarget = this.normalizeAutoAssignCategory(autoAssignCategory);
    if (!normalizedTarget) {
      return null;
    }

    if (name === 'Default') {
      throw new Error('Default category cannot auto-assign subdirectories');
    }

    const categories = existingCategories || this.loadCategories();
    const validCategoryNames = new Set(Object.keys(categories));
    validCategoryNames.add(name);
    validCategoryNames.add('Default');

    if (!validCategoryNames.has(normalizedTarget)) {
      throw new Error(`Auto-assign category "${normalizedTarget}" does not exist`);
    }

    return normalizedTarget;
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
          // Ensure backward compatibility: add attributes if missing
          if (!category.attributes) {
            category.attributes = [];
          }
          // Ensure backward compatibility: add displayMode if missing
          if (category.displayMode === undefined) {
            category.displayMode = 'details';
          }
          category.autoAssignCategory = this.normalizeAutoAssignCategory(category.autoAssignCategory);
          if (category.name === 'Default') {
            category.autoAssignCategory = null;
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
  createCategory(name, bgColor, textColor, patterns = [], description = '', enableChecksum = false, attributes = [], autoAssignCategory = null, displayMode = 'details') {
    if (name === 'Default') {
      throw new Error('Cannot create a category named "Default" - it already exists');
    }

    const normalizedAutoAssignCategory = this.validateAutoAssignCategory(name, autoAssignCategory);

    const category = {
      name,
      bgColor,
      textColor,
      patterns,
      description,
      enableChecksum,
      attributes,
      autoAssignCategory: normalizedAutoAssignCategory,
      displayMode: displayMode || 'details'
    };

    const filePath = path.join(CATEGORIES_DIR, `${name}.json`);
    fs.writeFileSync(filePath, JSON.stringify(category, null, 2));

    return category;
  }

  /**
   * Update an existing category
   */
  updateCategory(name, bgColor, textColor, patterns = [], description = '', enableChecksum = null, attributes = null, autoAssignCategory = undefined, displayMode = null) {
    // Get existing category to preserve fields if not specified
    const existingCategory = this.getCategory(name);
    const checksumSetting = enableChecksum !== null ? enableChecksum : (existingCategory?.enableChecksum || false);
    const attributesSetting = attributes !== null ? attributes : (existingCategory?.attributes || []);
    const autoAssignSetting = autoAssignCategory !== undefined
      ? this.validateAutoAssignCategory(name, autoAssignCategory)
      : this.validateAutoAssignCategory(name, existingCategory?.autoAssignCategory || null);
    const displayModeSetting = displayMode !== null ? displayMode : (existingCategory?.displayMode || 'details');

    const category = {
      name,
      bgColor,
      textColor,
      patterns,
      description,
      enableChecksum: checksumSetting,
      attributes: attributesSetting,
      autoAssignCategory: autoAssignSetting,
      displayMode: displayModeSetting
    };

    // Preserve extra fields that aren't part of the standard update schema
    if (existingCategory && existingCategory.defaultGridLayout) {
      category.defaultGridLayout = existingCategory.defaultGridLayout;
    }

    const filePath = path.join(CATEGORIES_DIR, `${name}.json`);
    fs.writeFileSync(filePath, JSON.stringify(category, null, 2));

    return category;
  }

  /**
   * Set or clear the default grid layout for a category. Stored on the category
   * JSON file so directories using this category can fall back to it when no
   * per-directory layout exists.
   */
  setCategoryDefaultGridLayout(name, columns, sortData) {
    const existing = this.getCategory(name);
    if (!existing) {
      throw new Error(`Category "${name}" not found`);
    }
    if (columns == null) {
      delete existing.defaultGridLayout;
    } else {
      existing.defaultGridLayout = {
        columns: Array.isArray(columns) ? columns : [],
        sortData: Array.isArray(sortData) ? sortData : []
      };
    }
    const filePath = path.join(CATEGORIES_DIR, `${name}.json`);
    fs.writeFileSync(filePath, JSON.stringify(existing, null, 2));
    return existing.defaultGridLayout || null;
  }

  /**
   * Get the default grid layout previously saved for a category, or null.
   */
  getCategoryDefaultGridLayout(name) {
    const existing = this.getCategory(name);
    return existing?.defaultGridLayout || null;
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
      // Ensure file_format exists with default
      if (!settings.file_format) {
        settings.file_format = 'Markdown';
      }
      // Set defaults for new settings if they don't exist
      if (typeof settings.hide_dot_directory === 'undefined') {
        settings.hide_dot_directory = false;
      }
      if (typeof settings.hide_dot_dot_directory === 'undefined') {
        settings.hide_dot_dot_directory = false;
      }
      if (typeof settings.show_folder_name_with_dot_entries === 'undefined') {
        settings.show_folder_name_with_dot_entries = false;
      }
      if (typeof settings.pin_meta_dirs === 'undefined') {
        settings.pin_meta_dirs = false;
      }
      if (typeof settings.record_height === 'undefined') {
        settings.record_height = 30;
      }
      if (typeof settings.background_refresh_enabled === 'undefined') {
        settings.background_refresh_enabled = false;
      }
      if (typeof settings.background_refresh_interval === 'undefined') {
        settings.background_refresh_interval = 30;
      }
      if (typeof settings.checksum_max_concurrent === 'undefined') {
        settings.checksum_max_concurrent = 1;
      }
      if (typeof settings.title_default_format === 'undefined') {
        settings.title_default_format = 'folder-name';
      }
      if (typeof settings.title_display_name_format === 'undefined') {
        settings.title_display_name_format = 'name-relative-path';
      }
      if (typeof settings.monitoring_enabled === 'undefined') {
        settings.monitoring_enabled = false;
      }
      if (typeof settings.monitoring_scheduler_interval === 'undefined') {
        settings.monitoring_scheduler_interval = 15;
      }
      if (typeof settings.monitoring_max_dirs_per_pass === 'undefined') {
        settings.monitoring_max_dirs_per_pass = 10;
      }
      if (typeof settings.monitoring_inter_scan_delay_ms === 'undefined') {
        settings.monitoring_inter_scan_delay_ms = 50;
      }
      if (typeof settings.monitoring_observation_dead_time_value === 'undefined') {
        settings.monitoring_observation_dead_time_value = 1;
      }
      if (typeof settings.monitoring_observation_dead_time_unit === 'undefined') {
        settings.monitoring_observation_dead_time_unit = 'hours';
      }
      if (typeof settings.auto_update_check_enabled === 'undefined') {
        settings.auto_update_check_enabled = true;
      }
      if (typeof settings.auto_update_check_interval_hours === 'undefined') {
        settings.auto_update_check_interval_hours = 24;
      }
      return settings;
    } catch {
      return { 
        home_directory: os.homedir(),
        file_format: 'Markdown',
        hide_dot_directory: false,
        hide_dot_dot_directory: false,
        show_folder_name_with_dot_entries: false,
        pin_meta_dirs: false,
        record_height: 30,
        background_refresh_enabled: false,
        background_refresh_interval: 30,
        checksum_max_concurrent: 1,
        title_default_format: 'folder-name',
        title_display_name_format: 'name-relative-path',
        monitoring_enabled: false,
        monitoring_scheduler_interval: 15,
        monitoring_max_dirs_per_pass: 10,
        monitoring_inter_scan_delay_ms: 50,
        monitoring_observation_dead_time_value: 1,
        monitoring_observation_dead_time_unit: 'hours',
        auto_update_check_enabled: true,
        auto_update_check_interval_hours: 24
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
   * Get hotkeys object (load from hotkeys.json).
   * Any actions present in the source defaults but missing from the user file
   * are merged in automatically, so new hotkeys are picked up after updates.
   */
  getHotkeys() {
    let userHotkeys;
    try {
      const content = fs.readFileSync(HOTKEYS_PATH, 'utf8');
      userHotkeys = JSON.parse(content);
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
          'edit_file': { label: 'Edit Notes', key: 'F2', default: 'F2' },
          'save_file': { label: 'Save Notes', key: 'Ctrl+S', default: 'Ctrl+S' }
        }
      };
    }

    // Merge any new actions from the source defaults that aren't in the user file
    try {
      if (fs.existsSync(SOURCE_HOTKEYS_PATH)) {
        const sourceContent = fs.readFileSync(SOURCE_HOTKEYS_PATH, 'utf8');
        const sourceHotkeys = JSON.parse(sourceContent);
        let changed = false;
        for (const [context, actions] of Object.entries(sourceHotkeys)) {
          if (!userHotkeys[context]) {
            userHotkeys[context] = {};
          }
          for (const [actionId, actionData] of Object.entries(actions)) {
            if (!userHotkeys[context][actionId]) {
              userHotkeys[context][actionId] = actionData;
              changed = true;
            }
          }
        }
        if (changed) {
          fs.writeFileSync(HOTKEYS_PATH, JSON.stringify(userHotkeys, null, 2));
        }
      }
    } catch (mergeErr) {
      logger.warn('Could not merge hotkey defaults:', mergeErr.message);
    }

    return userHotkeys;
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
  setCategoryForDirectory(dirPath, categoryName, isForced = true) {
    db.setCategoryForDirectory(dirPath, categoryName, isForced);
  }

  /**
   * Clear explicit category assignment for a directory in the database
   */
  clearCategoryForDirectory(dirPath) {
    db.clearCategoryForDirectory(dirPath);
  }

  /**
   * Get category assignment for a directory from the database
   */
  getCategoryFromDatabase(dirPath) {
    return db.getCategoryForDirectory(dirPath);
  }

  /**
   * Get explicit category assignment metadata for a directory from the database
   */
  getCategoryAssignmentForDirectory(dirPath) {
    return db.getDirectoryCategoryAssignment(dirPath);
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
  getPatternMatchedCategory(dirPath, categories) {
    for (const category of Object.values(categories)) {
      if (category.patterns && Array.isArray(category.patterns)) {
        for (const pattern of category.patterns) {
          if (this.matchesPattern(dirPath, pattern)) {
            return category;
          }
        }
      }
    }

    return null;
  }

  getCategoryResolutionForDirectory(dirPath) {
    const categories = this.loadCategories();
    const defaultCategory = categories.Default || this.createDefaultCategory();
    const resolutionCache = new Map();

    const resolveForPath = (currentPath) => {
      const normalizedPath = path.resolve(currentPath);
      if (resolutionCache.has(normalizedPath)) {
        return resolutionCache.get(normalizedPath);
      }

      const assignment = this.getCategoryAssignmentForDirectory(normalizedPath);
      const explicitCategoryName = assignment?.category || defaultCategory.name;
      const explicitCategory = categories[explicitCategoryName] || null;

      if (assignment?.isForced && explicitCategory) {
        const forcedResolution = {
          category: explicitCategory,
          categoryName: explicitCategory.name,
          explicitCategoryName,
          isForced: true,
          isAutoAssigned: false,
          inheritedFromPath: null,
          inheritedFromCategoryName: null
        };
        resolutionCache.set(normalizedPath, forcedResolution);
        return forcedResolution;
      }

      const parentPath = path.dirname(normalizedPath);
      if (parentPath !== normalizedPath) {
        const parentResolution = resolveForPath(parentPath);
        const inheritedCategoryName = this.normalizeAutoAssignCategory(parentResolution.category?.autoAssignCategory);
        if (inheritedCategoryName && categories[inheritedCategoryName]) {
          const inheritedResolution = {
            category: categories[inheritedCategoryName],
            categoryName: inheritedCategoryName,
            explicitCategoryName,
            isForced: false,
            isAutoAssigned: true,
            inheritedFromPath: parentPath,
            inheritedFromCategoryName: parentResolution.category.name
          };
          resolutionCache.set(normalizedPath, inheritedResolution);
          return inheritedResolution;
        }
      }

      const patternCategory = this.getPatternMatchedCategory(normalizedPath, categories);
      if (patternCategory) {
        const patternResolution = {
          category: patternCategory,
          categoryName: patternCategory.name,
          explicitCategoryName,
          isForced: false,
          isAutoAssigned: false,
          inheritedFromPath: null,
          inheritedFromCategoryName: null
        };
        resolutionCache.set(normalizedPath, patternResolution);
        return patternResolution;
      }

      const defaultResolution = {
        category: defaultCategory,
        categoryName: defaultCategory.name,
        explicitCategoryName,
        isForced: false,
        isAutoAssigned: false,
        inheritedFromPath: null,
        inheritedFromCategoryName: null
      };
      resolutionCache.set(normalizedPath, defaultResolution);
      return defaultResolution;
    };

    return resolveForPath(dirPath);
  }

  /**
   * Get the applicable category for a directory
   * Priority: 1) Forced per-directory assignment, 2) Parent auto-assign, 3) Pattern matching, 4) Default
   */
  getCategoryForDirectory(dirPath) {
    return this.getCategoryResolutionForDirectory(dirPath).category;
  }

  /**
   * Create the Default category if it doesn't exist
   */
  createDefaultCategory() {
    return {
      name: 'Default',
      bgColor: 'rgb(239, 228, 176)',
      textColor: 'rgb(0, 0, 0)',
      patterns: [],
      description: '',
      enableChecksum: false,
      attributes: [],
      autoAssignCategory: null
    };
  }
}

module.exports = new CategoryService();
