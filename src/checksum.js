const fs = require('fs');
const crypto = require('crypto');
const logger = require('./logger');

class ChecksumService {
  /**
   * Calculate MD5 checksum for a file
   * Reads file in chunks to handle large files efficiently
   * @param {string} filePath - Path to file
   * @param {number} chunkSize - Chunk size in bytes (default: 64KB)
   * @returns {Promise<{value: string|null, error: string|null}>}
   */
  async calculateMD5(filePath, chunkSize = 65536) {
    return new Promise((resolve) => {
      try {
        const hash = crypto.createHash('md5');
        const stream = fs.createReadStream(filePath, { highWaterMark: chunkSize });

        stream.on('data', (chunk) => {
          hash.update(chunk);
        });

        stream.on('end', () => {
          const checksumValue = hash.digest('hex');
          resolve({ value: checksumValue, error: null });
        });

        stream.on('error', (err) => {
          logger.warn(`Error reading file for checksum: ${filePath}`, err.message);
          resolve({ value: null, error: err.message });
        });
      } catch (err) {
        logger.error(`Error calculating checksum: ${filePath}`, err.message);
        resolve({ value: null, error: err.message });
      }
    });
  }

  /**
   * Calculate checksum and compare with previous value
   * @param {string} filePath - Path to file
   * @param {string} previousChecksum - Previous checksum value to compare against
   * @returns {Promise<{value: string|null, changed: boolean, error: string|null}>}
   */
  async compareChecksum(filePath, previousChecksum) {
    const result = await this.calculateMD5(filePath);

    if (result.error) {
      return { value: null, changed: false, error: result.error };
    }

    const changed = result.value !== previousChecksum;
    return { value: result.value, changed, error: null };
  }
}

module.exports = new ChecksumService();
