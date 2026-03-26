/**
 * Unit Tests for ChecksumService
 * 
 * This test suite demonstrates testing ASYNCHRONOUS operations and STREAMS.
 * 
 * KEY COMPLEXITY:
 * - calculateMD5() returns a Promise (async operation)
 * - Uses fs.createReadStream() which emits events (data, end, error)
 * - We need to mock both the stream object AND its event emitter
 * 
 * TESTING STRATEGY:
 * - Mock fs.createReadStream() to return a fake stream object
 * - Manually trigger the stream events that our code listens for
 * - Verify the Promise resolves with correct values
 */

jest.mock('fs');
jest.mock('crypto');

const fs = require('fs');
const crypto = require('crypto');
const ChecksumService = require('../checksum');

/**
 * TEST SUITE 1: calculateMD5()
 * 
 * The calculateMD5() method:
 * 1. Creates a read stream for the file
 * 2. Pipes chunks through a hash function
 * 3. Returns the final hash as hex string via a Promise
 */
describe('ChecksumService - calculateMD5()', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  /**
   * TEST: Should successfully calculate MD5 hash
   * 
   * This is the happy path - everything works normally.
   * 
   * TECHNIQUE: We use a fake stream object that the code can interact with.
   * When our code calls stream.on('data', ...), we store that callback.
   * Then we manually call those callbacks to simulate the stream events.
   */
  it('should calculate MD5 checksum for a valid file', async () => {
    // Create a fake stream object
    // EventEmitter pattern: code calls .on() to listen for events
    const fakeStream = {
      on: jest.fn(),  // Mock the .on() method
    };

    // Make fs.createReadStream() return our fake stream
    fs.createReadStream.mockReturnValue(fakeStream);

    // Mock the crypto hash object
    const fakeHash = {
      update: jest.fn(),  // Called when stream sends data chunks
      digest: jest.fn(() => 'abc123def456'),  // Returns the final hash
    };
    crypto.createHash.mockReturnValue(fakeHash);

    // CALL THE METHOD (it will set up event listeners on fakeStream)
    const resultPromise = ChecksumService.calculateMD5('/test/file.txt');

    // EXTRACT the event handlers that were registered
    // When our code does stream.on('end', callback), we capture that callback
    const onCalls = fakeStream.on.mock.calls;
    const endCallback = onCalls.find(call => call[0] === 'end')[1];

    // SIMULATE the stream ending (success case)
    // This triggers the callback our code registered
    endCallback();

    // WAIT for the Promise to resolve
    const result = await resultPromise;

    // VERIFY the result
    expect(result.value).toBe('abc123def456');
    expect(result.error).toBeNull();
  });

  /**
   * TEST: Should handle stream errors gracefully
   * 
   * REAL-WORLD SCENARIO: User tries to calculate checksum for a file
   * they don't have permission to read.
   * 
   * Expected behavior: Return error object instead of throwing
   */
  it('should catch stream errors and return error object', async () => {
    const fakeStream = {
      on: jest.fn(),
    };

    fs.createReadStream.mockReturnValue(fakeStream);

    // Start the calculation
    const resultPromise = ChecksumService.calculateMD5('/inaccessible/file.txt');

    // EXTRACT the error handler callback
    const onCalls = fakeStream.on.mock.calls;
    const errorCallback = onCalls.find(call => call[0] === 'error')[1];

    // SIMULATE a stream error
    const testError = new Error('Permission denied');
    errorCallback(testError);

    // WAIT for resolve
    const result = await resultPromise;

    // VERIFY we got an error result (not a thrown exception)
    expect(result.value).toBeNull();
    expect(result.error).toBe('Permission denied');
  });

  /**
   * TEST: Should pass chunkSize parameter to stream
   * 
   * The calculateMD5() method accepts a chunkSize parameter for optimization.
   * We verify it's passed correctly to createReadStream's highWaterMark option.
   */
  it('should use custom chunk size when provided', async () => {
    const fakeStream = {
      on: jest.fn(),
    };

    fs.createReadStream.mockReturnValue(fakeStream);

    const customChunkSize = 131072; // 128KB
    const resultPromise = ChecksumService.calculateMD5('/test/file.txt', customChunkSize);

    // Trigger the end event to complete the Promise
    const endCallback = fakeStream.on.mock.calls.find(call => call[0] === 'end')[1];
    endCallback();

    await resultPromise;

    // VERIFY createReadStream was called with the custom chunk size
    expect(fs.createReadStream).toHaveBeenCalledWith(
      '/test/file.txt',
      { highWaterMark: customChunkSize }
    );
  });

  /**
   * TEST: Should update hash with each data chunk
   * 
   * The stream emits multiple 'data' events. Each chunk should be
   * passed to hash.update().
   */
  it('should call hash.update() for each data chunk', async () => {
    const fakeStream = {
      on: jest.fn(),
    };

    fs.createReadStream.mockReturnValue(fakeStream);

    const fakeHash = {
      update: jest.fn(),
      digest: jest.fn(() => 'final_hash'),
    };
    crypto.createHash.mockReturnValue(fakeHash);

    const resultPromise = ChecksumService.calculateMD5('/test/file.txt');

    // EXTRACT callbacks from the mock
    const onCalls = fakeStream.on.mock.calls;
    const dataCallback = onCalls.find(call => call[0] === 'data')[1];
    const endCallback = onCalls.find(call => call[0] === 'end')[1];

    // SIMULATE multiple data chunks
    const chunk1 = Buffer.from('Hello ');
    const chunk2 = Buffer.from('World');
    dataCallback(chunk1);
    dataCallback(chunk2);
    endCallback();

    await resultPromise;

    // VERIFY hash.update was called for each chunk
    expect(fakeHash.update).toHaveBeenCalledTimes(2);
    expect(fakeHash.update).toHaveBeenNthCalledWith(1, chunk1);
    expect(fakeHash.update).toHaveBeenNthCalledWith(2, chunk2);
  });
});

/**
 * TEST SUITE 2: compareChecksum()
 * 
 * This method:
 * 1. Calls calculateMD5() to get new checksum
 * 2. Compares it to a previous value
 * 3. Returns whether they match
 */
describe('ChecksumService - compareChecksum()', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  /**
   * TEST: Should detect when checksums match
   */
  it('should return changed=false when checksums match', async () => {
    const fakeStream = {
      on: jest.fn(),
    };

    fs.createReadStream.mockReturnValue(fakeStream);

    const fakeHash = {
      update: jest.fn(),
      digest: jest.fn(() => 'abc123'),  // Same as previous
    };
    crypto.createHash.mockReturnValue(fakeHash);

    const resultPromise = ChecksumService.compareChecksum('/test/file.txt', 'abc123');

    // Trigger completion
    const endCallback = fakeStream.on.mock.calls.find(call => call[0] === 'end')[1];
    endCallback();

    const result = await resultPromise;

    expect(result.value).toBe('abc123');
    expect(result.changed).toBe(false);  // No change detected
    expect(result.error).toBeNull();
  });

  /**
   * TEST: Should detect when checksums differ
   */
  it('should return changed=true when checksums differ', async () => {
    const fakeStream = {
      on: jest.fn(),
    };

    fs.createReadStream.mockReturnValue(fakeStream);

    const fakeHash = {
      update: jest.fn(),
      digest: jest.fn(() => 'new_hash_xyz'),  // Different!
    };
    crypto.createHash.mockReturnValue(fakeHash);

    const resultPromise = ChecksumService.compareChecksum('/test/file.txt', 'old_hash_123');

    const endCallback = fakeStream.on.mock.calls.find(call => call[0] === 'end')[1];
    endCallback();

    const result = await resultPromise;

    expect(result.value).toBe('new_hash_xyz');
    expect(result.changed).toBe(true);  // Change detected!
    expect(result.error).toBeNull();
  });

  /**
   * TEST: Should handle errors in comparison
   */
  it('should return error if checksum calculation fails', async () => {
    const fakeStream = {
      on: jest.fn(),
    };

    fs.createReadStream.mockReturnValue(fakeStream);

    const resultPromise = ChecksumService.compareChecksum('/test/file.txt', 'previous_value');

    // Simulate stream error
    const errorCallback = fakeStream.on.mock.calls.find(call => call[0] === 'error')[1];
    errorCallback(new Error('Read failed'));

    const result = await resultPromise;

    expect(result.value).toBeNull();
    expect(result.changed).toBe(false);  // Error case defaults to unchanged
    expect(result.error).toBe('Read failed');
  });
});
