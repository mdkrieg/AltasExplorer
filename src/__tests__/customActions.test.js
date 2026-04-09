const fs = require('fs');
const path = require('path');
const os = require('os');

describe('customActions service', () => {
  let tempHome;
  let customActions;

  function writeActionsFile(actions) {
    const configDir = path.join(tempHome, '.atlasexplorer');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'custom-actions.json'),
      JSON.stringify(actions, null, 2),
      'utf8'
    );
  }

  beforeEach(() => {
    jest.resetModules();
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-custom-actions-'));

    jest.doMock('os', () => ({
      ...jest.requireActual('os'),
      homedir: () => tempHome
    }));

    customActions = require('../customActions');
  });

  afterEach(() => {
    jest.dontMock('os');
    jest.resetModules();
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  test('normalizes legacy actions with default execution settings', () => {
    writeActionsFile([
      {
        id: 'legacy-action',
        label: 'Legacy Action',
        executable: 'C:\\Tools\\legacy.exe',
        args: ['--flag'],
        filePatterns: ['*.txt']
      }
    ]);

    const [action] = customActions.getCustomActions();

    expect(action.executionMode).toBe('silent');
    expect(action.timeoutSeconds).toBe(60);
    expect(action.args).toEqual(['--flag']);
    expect(action.filePatterns).toEqual(['*.txt']);
  });

  test('persists terminal execution mode and normalizes invalid silent timeout values', () => {
    const executablePath = path.join(tempHome, 'tool.exe');
    fs.writeFileSync(executablePath, 'binary-placeholder', 'utf8');

    customActions.saveCustomAction({
      id: 'terminal-action',
      label: 'Terminal Action',
      executable: executablePath,
      args: ['--inspect'],
      filePatterns: ['*.json'],
      executionMode: 'terminal',
      timeoutSeconds: 0
    });

    const [action] = customActions.getCustomActions();

    expect(action.executionMode).toBe('terminal');
    expect(action.timeoutSeconds).toBe(60);
    expect(action.args).toEqual(['--inspect']);
    expect(action.filePatterns).toEqual(['*.json']);
    expect(action.checksum).toBeNull();
  });
});