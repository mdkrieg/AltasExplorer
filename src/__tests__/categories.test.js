/**
 * Unit Tests for CategoryService
 * 
 * This test suite demonstrates testing FILE I/O operations with JSON.
 * 
 * KEY CONCEPTS:
 * - Mocking file read/write operations
 * - Testing validation logic (can't create "Default" category)
 * - Testing backward compatibility
 * - Testing directory creation
 * 
 * PATTERN: We mock fs operations so the service never touches real files.
 */

jest.mock('fs');
jest.mock('../logger');
jest.mock('../db', () => ({
  setCategoryForDirectory: jest.fn(),
  getCategoryForDirectory: jest.fn(),
  getDirectoryCategoryAssignment: jest.fn(),
  clearCategoryForDirectory: jest.fn()
}));

// We need to mock path.join since the service uses it to build file paths
// But we don't want to mock the entire 'path' module (we want real path logic)
// So we'll mock it selectively when needed
const fs = require('fs');
const path = require('path');
const db = require('../db');
const CategoryService = require('../categories');

function createCategoryDefinition(name, autoAssignCategory = null) {
  return {
    name,
    bgColor: 'rgb(100, 100, 100)',
    textColor: 'rgb(255, 255, 255)',
    patterns: [],
    description: '',
    enableChecksum: false,
    attributes: [],
    autoAssignCategory
  };
}

/**
 * TEST SUITE 1: ensureDirectories()
 * 
 * This method runs during construction. It should:
 * 1. Check if categories directory exists
 * 2. Create it if missing
 * 3. Create Default.json if missing
 */
describe('CategoryService - ensureDirectories()', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Re-create the instance for each test to trigger ensureDirectories() again
    // But we need to be careful - CategoryService is a singleton in the real code
    // For testing, we might need to reload it... for now we'll just verify mock calls
  });

  /**
   * TEST: Should create directories if they don't exist
   * 
   * This tests the defensive programming pattern:
   * "Check if exists before creating"
   */
  it('should create categories directory if it does not exist', () => {
    // Mock fs.existsSync to return false (directory doesn't exist)
    fs.existsSync.mockReturnValue(false);
    fs.mkdirSync.mockImplementation(() => {}); // Mock directory creation
    fs.writeFileSync.mockImplementation(() => {}); // Mock file write

    // Manually call ensureDirectories() to verify behavior
    CategoryService.ensureDirectories();

    // VERIFY fs.mkdirSync was called to create the directory
    expect(fs.mkdirSync).toHaveBeenCalled();
  });

  /**
   * TEST: Should skip directory creation if it already exists
   * 
   * Optimization: Don't try to create if it's already there.
   */
  it('should not create directory if it already exists', () => {
    // Mock fs.existsSync to return true (directory exists)
    fs.existsSync.mockReturnValue(true);

    CategoryService.ensureDirectories();

    // VERIFY fs.mkdirSync was NOT called
    expect(fs.mkdirSync).not.toHaveBeenCalled();
  });

  /**
   * TEST: Should create Default category JSON file
   * 
   * The Default category is special - it always exists.
   */
  it('should create Default.json with correct structure', () => {
    fs.existsSync.mockReturnValue(false);
    fs.mkdirSync.mockImplementation(() => {});
    fs.writeFileSync.mockImplementation(() => {});

    CategoryService.ensureDirectories();

    // VERIFY fs.writeFileSync was called
    expect(fs.writeFileSync).toHaveBeenCalled();

    // GET the arguments passed to writeFileSync
    const writeCall = fs.writeFileSync.mock.calls[0];
    const filePath = writeCall[0];
    const fileContent = writeCall[1];

    // VERIFY it's a Default.json file
    expect(filePath).toContain('Default.json');

    // VERIFY the JSON content has expected structure
    const parsedContent = JSON.parse(fileContent);
    expect(parsedContent.name).toBe('Default');
    expect(parsedContent.bgColor).toBeDefined();
    expect(parsedContent.textColor).toBeDefined();
    expect(parsedContent.patterns).toEqual([]);
    expect(parsedContent.enableChecksum).toBe(false);
  });
});

/**
 * TEST SUITE 2: createCategory()
 * 
 * Tests the category creation logic, especially validation.
 */
describe('CategoryService - createCategory()', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    fs.existsSync.mockReturnValue(true);  // Assume directory exists
    fs.mkdirSync.mockImplementation(() => {});
  });

  /**
   * TEST: Should successfully create a new category
   */
  it('should create a new category with provided values', () => {
    fs.writeFileSync.mockImplementation(() => {});

    const category = CategoryService.createCategory(
      'Work',
      'rgb(100, 150, 200)',
      'rgb(255, 255, 255)',
      ['*.pdf', '*.docx'],
      'Work-related files'
    );

    // VERIFY the returned object has correct structure
    expect(category.name).toBe('Work');
    expect(category.bgColor).toBe('rgb(100, 150, 200)');
    expect(category.textColor).toBe('rgb(255, 255, 255)');
    expect(category.patterns).toEqual(['*.pdf', '*.docx']);
    expect(category.description).toBe('Work-related files');

    // VERIFY fs.writeFileSync was called to persist the category
    expect(fs.writeFileSync).toHaveBeenCalled();
  });

  /**
   * TEST: Should reject creation of "Default" category
   * 
   * VALIDATION: "Default" is reserved and can't be created.
   * This should throw an error.
   */
  it('should throw error when trying to create "Default" category', () => {
    // EXPECT the function to throw
    expect(() => {
      CategoryService.createCategory('Default', 'rgb(0,0,0)', 'rgb(255,255,255)');
    }).toThrow('Cannot create a category named "Default"');
  });

  /**
   * TEST: Should use default values for optional parameters
   */
  it('should use default values for optional parameters', () => {
    fs.writeFileSync.mockImplementation(() => {});

    // Call with only required parameters
    const category = CategoryService.createCategory(
      'Photos',
      'rgb(200, 200, 200)',
      'rgb(50, 50, 50)'
    );

    // VERIFY optional fields got defaults
    expect(category.patterns).toEqual([]);
    expect(category.description).toBe('');
    expect(category.enableChecksum).toBe(false);
  });
});

/**
 * TEST SUITE 3: loadCategories()
 * 
 * Tests reading multiple category files and parsing them.
 */
describe('CategoryService - loadCategories()', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  /**
   * TEST: Should load multiple categories from files
   */
  it('should load all .json files from categories directory', () => {
    // Mock the directory listing
    fs.readdirSync.mockReturnValue(['Default.json', 'Work.json', 'Personal.json']);

    // Mock file reading - different content for each file
    fs.readFileSync.mockImplementation((filePath) => {
      if (filePath.includes('Default.json')) {
        return JSON.stringify({
          name: 'Default',
          bgColor: 'rgb(239, 228, 176)',
          textColor: 'rgb(0, 0, 0)',
          patterns: [],
          description: '',
          enableChecksum: false
        });
      } else if (filePath.includes('Work.json')) {
        return JSON.stringify({
          name: 'Work',
          bgColor: 'rgb(100, 150, 200)',
          textColor: 'rgb(255, 255, 255)',
          patterns: ['*.doc', '*.pdf'],
          description: 'Work files'
        });
      } else if (filePath.includes('Personal.json')) {
        return JSON.stringify({
          name: 'Personal',
          bgColor: 'rgb(255, 200, 100)',
          textColor: 'rgb(0, 0, 0)',
          patterns: ['*.jpg', '*.png'],
          description: 'Personal photos'
        });
      }
    });

    const categories = CategoryService.loadCategories();

    // VERIFY we got all 3 categories
    expect(Object.keys(categories)).toHaveLength(3);
    expect(categories.Default).toBeDefined();
    expect(categories.Work).toBeDefined();
    expect(categories.Personal).toBeDefined();

    // VERIFY content is correct
    expect(categories.Work.bgColor).toBe('rgb(100, 150, 200)');
    expect(categories.Work.patterns).toEqual(['*.doc', '*.pdf']);
  });

  /**
   * TEST: Should skip non-JSON files
   * 
   * REALISTIC: Directory might have other files (backups, temp files, etc.)
   * We should ignore anything that's not .json
   */
  it('should ignore non-json files', () => {
    // Directory contains mix of JSON and other files
    fs.readdirSync.mockReturnValue([
      'Default.json',
      'Work.json',
      'backup.bak',
      'settings.txt',
      '.DS_Store'
    ]);

    fs.readFileSync.mockImplementation((filePath) => {
      if (filePath.includes('Default.json')) {
        return JSON.stringify({
          name: 'Default',
          bgColor: 'rgb(239, 228, 176)',
          textColor: 'rgb(0, 0, 0)',
          patterns: []
        });
      } else if (filePath.includes('Work.json')) {
        return JSON.stringify({
          name: 'Work',
          bgColor: 'rgb(100, 150, 200)',
          textColor: 'rgb(255, 255, 255)',
          patterns: []
        });
      }
    });

    const categories = CategoryService.loadCategories();

    // VERIFY only 2 categories loaded (JSON files only)
    expect(Object.keys(categories)).toHaveLength(2);
    expect(categories.Default).toBeDefined();
    expect(categories.Work).toBeDefined();
  });

  /**
   * TEST: Should handle backward compatibility
   * 
   * REAL SCENARIO: User upgrades from older version that didn't have
   * certain fields (like 'description' or 'enableChecksum').
   * The code should add default values for missing fields.
   */
  it('should add missing fields for backward compatibility', () => {
    fs.readdirSync.mockReturnValue(['OldCategory.json']);

    // Simulate old category file missing new fields
    fs.readFileSync.mockReturnValue(JSON.stringify({
      name: 'OldCategory',
      bgColor: 'rgb(100, 100, 100)',
      textColor: 'rgb(255, 255, 255)',
      patterns: []
      // Missing: description, enableChecksum
    }));

    const categories = CategoryService.loadCategories();
    const oldCat = categories.OldCategory;

    // VERIFY missing fields were added with defaults
    expect(oldCat.description).toBe('');
    expect(oldCat.enableChecksum).toBe(false);
  });

  /**
   * TEST: Should handle read errors gracefully
   * 
   * EDGE CASE: Directory listing succeeds but file read fails
   * (e.g., permission denied on one file)
   */
  it('should log error and continue if reading a file fails', () => {
    fs.readdirSync.mockReturnValue(['Good.json', 'Bad.json']);

    fs.readFileSync.mockImplementation((filePath) => {
      if (filePath.includes('Bad.json')) {
        throw new Error('Permission denied');
      }
      return JSON.stringify({
        name: 'Good',
        bgColor: 'rgb(100, 100, 100)',
        textColor: 'rgb(255, 255, 255)',
        patterns: []
      });
    });

    // Get the logger mock to verify error logging
    const logger = require('../logger');

    const categories = CategoryService.loadCategories();

    // VERIFY only the good category was loaded
    expect(categories.Good).toBeDefined();
    expect(categories.Bad).toBeUndefined();

    // VERIFY error was logged
    expect(logger.error).toHaveBeenCalled();
  });
});

/**
 * TEST SUITE 4: getCategory()
 * 
 * Simple lookup test.
 */
describe('CategoryService - getCategory()', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  /**
   * TEST: Should return existing category
   */
  it('should return category if it exists', () => {
    fs.readdirSync.mockReturnValue(['TestCat.json']);
    fs.readFileSync.mockReturnValue(JSON.stringify({
      name: 'TestCat',
      bgColor: 'rgb(100, 100, 100)',
      textColor: 'rgb(255, 255, 255)',
      patterns: [],
      description: 'Test'
    }));

    const category = CategoryService.getCategory('TestCat');

    expect(category).not.toBeNull();
    expect(category.name).toBe('TestCat');
  });

  /**
   * TEST: Should return null if category doesn't exist
   */
  it('should return null if category does not exist', () => {
    fs.readdirSync.mockReturnValue([]);
    fs.readFileSync.mockReturnValue(JSON.stringify({}));

    const category = CategoryService.getCategory('Nonexistent');

    expect(category).toBeNull();
  });
});

describe('CategoryService - auto-assign categories', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should persist autoAssignCategory when creating a category', () => {
    fs.writeFileSync.mockImplementation(() => {});

    const category = CategoryService.createCategory(
      'Project',
      'rgb(100, 150, 200)',
      'rgb(255, 255, 255)',
      [],
      'Project folders',
      false,
      [],
      'Default'
    );

    expect(category.autoAssignCategory).toBe('Default');
    const fileContent = JSON.parse(fs.writeFileSync.mock.calls[0][1]);
    expect(fileContent.autoAssignCategory).toBe('Default');
  });

  it('should inherit the parent auto-assign category for subdirectories', () => {
    const loadCategoriesSpy = jest.spyOn(CategoryService, 'loadCategories').mockReturnValue({
      Default: createCategoryDefinition('Default'),
      Project: createCategoryDefinition('Project', 'Archive'),
      Archive: createCategoryDefinition('Archive')
    });

    db.getDirectoryCategoryAssignment.mockImplementation(dirPath => {
      if (dirPath === path.resolve('C:\\root')) {
        return { category: 'Project', isForced: true };
      }
      return null;
    });

    const resolution = CategoryService.getCategoryResolutionForDirectory('C:\\root\\child');

    expect(resolution.categoryName).toBe('Archive');
    expect(resolution.explicitCategoryName).toBe('Default');
    expect(resolution.isForced).toBe(false);
    expect(resolution.isAutoAssigned).toBe(true);
    expect(resolution.inheritedFromPath).toBe(path.resolve('C:\\root'));
    expect(resolution.inheritedFromCategoryName).toBe('Project');

    loadCategoriesSpy.mockRestore();
  });

  it('should resolve chained auto-assign categories across generations', () => {
    const loadCategoriesSpy = jest.spyOn(CategoryService, 'loadCategories').mockReturnValue({
      Default: createCategoryDefinition('Default'),
      Project: createCategoryDefinition('Project', 'Archive'),
      Archive: createCategoryDefinition('Archive', 'Review'),
      Review: createCategoryDefinition('Review')
    });

    db.getDirectoryCategoryAssignment.mockImplementation(dirPath => {
      if (dirPath === path.resolve('C:\\root')) {
        return { category: 'Project', isForced: true };
      }
      return null;
    });

    const childResolution = CategoryService.getCategoryResolutionForDirectory('C:\\root\\child');
    const grandchildResolution = CategoryService.getCategoryResolutionForDirectory('C:\\root\\child\\grandchild');

    expect(childResolution.categoryName).toBe('Archive');
    expect(grandchildResolution.categoryName).toBe('Review');
    expect(grandchildResolution.inheritedFromCategoryName).toBe('Archive');

    loadCategoriesSpy.mockRestore();
  });
});
