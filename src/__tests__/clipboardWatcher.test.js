const { EventEmitter } = require('events');
const { Readable } = require('stream');

describe('clipboardWatcher', () => {
  let normalizePayload;
  let createClipboardWatcher;
  let PowerShellClipboardWatcher;
  let NullClipboardWatcher;

  beforeEach(() => {
    jest.resetModules();
    ({
      normalizePayload,
      createClipboardWatcher,
      PowerShellClipboardWatcher,
      NullClipboardWatcher,
    } = require('../clipboardWatcher'));
  });

  describe('normalizePayload', () => {
    test('passes through a files array', () => {
      expect(normalizePayload({ type: 'files', data: ['C:\\a.txt', 'C:\\b.txt'], seq: 5 }))
        .toEqual({ type: 'files', data: ['C:\\a.txt', 'C:\\b.txt'], seq: 5 });
    });

    test('wraps a single file path string into an array', () => {
      expect(normalizePayload({ type: 'files', data: 'C:\\only.txt' }))
        .toEqual({ type: 'files', data: ['C:\\only.txt'] });
    });

    test('empty files collapse to empty (preserving seq)', () => {
      expect(normalizePayload({ type: 'files', data: [], seq: 9 }))
        .toEqual({ type: 'empty', seq: 9 });
    });

    test('text and image pass through', () => {
      expect(normalizePayload({ type: 'text', data: 'hi' })).toEqual({ type: 'text', data: 'hi' });
      expect(normalizePayload({ type: 'image', data: 'b64' })).toEqual({ type: 'image', data: 'b64' });
    });

    test('blank text/image collapse to empty', () => {
      expect(normalizePayload({ type: 'text', data: '' })).toEqual({ type: 'empty' });
      expect(normalizePayload({ type: 'image', data: null })).toEqual({ type: 'empty' });
    });

    test('garbage becomes empty', () => {
      expect(normalizePayload(null)).toEqual({ type: 'empty' });
      expect(normalizePayload({})).toEqual({ type: 'empty' });
    });
  });

  describe('createClipboardWatcher factory', () => {
    const realPlatform = process.platform;
    afterEach(() => {
      Object.defineProperty(process, 'platform', { value: realPlatform });
    });

    test('returns a PowerShell backend on win32', () => {
      Object.defineProperty(process, 'platform', { value: 'win32' });
      const w = createClipboardWatcher();
      expect(w).toBeInstanceOf(PowerShellClipboardWatcher);
    });

    test('returns a Null backend on non-win32', () => {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      const w = createClipboardWatcher();
      expect(w).toBeInstanceOf(NullClipboardWatcher);
      expect(w.isAvailable).toBe(false);
    });
  });

  describe('PowerShellClipboardWatcher line parsing', () => {
    let fakeProc;
    let spawnMock;

    beforeEach(() => {
      jest.resetModules();
      fakeProc = new EventEmitter();
      fakeProc.stdout = new Readable({ read() {} });
      fakeProc.stderr = new Readable({ read() {} });
      fakeProc.kill = jest.fn();
      spawnMock = jest.fn(() => fakeProc);
      jest.doMock('child_process', () => ({ spawn: spawnMock }));
      ({ PowerShellClipboardWatcher } = require('../clipboardWatcher'));
      Object.defineProperty(process, 'platform', { value: 'win32' });
    });

    test('parses a JSON change line, normalizes, emits, and caches last', () => {
      const w = new PowerShellClipboardWatcher();
      const changes = [];
      w.on('change', (p) => changes.push(p));
      w.start();

      fakeProc.stdout.push(JSON.stringify({ event: 'change', type: 'files', data: ['C:\\x.txt'], seq: 1 }) + '\n');

      return new Promise((resolve) => setImmediate(() => {
        expect(changes).toEqual([{ type: 'files', data: ['C:\\x.txt'], seq: 1 }]);
        expect(w.last).toEqual({ type: 'files', data: ['C:\\x.txt'], seq: 1 });
        w.stop();
        resolve();
      }));
    });

    test('deduplicates consecutive lines with the same seq', () => {
      const w = new PowerShellClipboardWatcher();
      const changes = [];
      w.on('change', (p) => changes.push(p));
      w.start();

      const line = JSON.stringify({ event: 'change', type: 'text', data: 'dup', seq: 42 }) + '\n';
      fakeProc.stdout.push(line);
      fakeProc.stdout.push(line);
      fakeProc.stdout.push(line);

      return new Promise((resolve) => setImmediate(() => {
        expect(changes).toEqual([{ type: 'text', data: 'dup', seq: 42 }]);
        w.stop();
        resolve();
      }));
    });

    test('ignores malformed lines', () => {
      const w = new PowerShellClipboardWatcher();
      const changes = [];
      w.on('change', (p) => changes.push(p));
      w.start();

      fakeProc.stdout.push('not json\n');
      fakeProc.stdout.push('\n');

      return new Promise((resolve) => setImmediate(() => {
        expect(changes).toEqual([]);
        w.stop();
        resolve();
      }));
    });

    test('readNow resolves the cached payload', async () => {
      const w = new PowerShellClipboardWatcher();
      w.start();
      fakeProc.stdout.push(JSON.stringify({ event: 'change', type: 'text', data: 'hello' }) + '\n');
      await new Promise((r) => setImmediate(r));
      await expect(w.readNow()).resolves.toEqual({ type: 'text', data: 'hello' });
      w.stop();
    });

    test('stop kills the process and prevents restart on exit', () => {
      const w = new PowerShellClipboardWatcher();
      w.start();
      w.stop();
      expect(fakeProc.kill).toHaveBeenCalled();
      // Simulate exit after stop: should not respawn.
      spawnMock.mockClear();
      fakeProc.emit('exit', 0, null);
      expect(spawnMock).not.toHaveBeenCalled();
    });
  });
});
