"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const readline = require("node:readline");

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_FILES = 3;

class JsonlLog {
  constructor(filePath, options = {}) {
    this.filePath = filePath || null;
    this.logger = options.logger || null;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
    this._writeQueue = Promise.resolve();
    this._size = null;
  }

  get enabled() {
    return Boolean(this.filePath);
  }

  append(record) {
    if (!this.filePath) {
      return;
    }
    const line = `${JSON.stringify(record)}\n`;
    const lineBytes = Buffer.byteLength(line, "utf8");
    if (this.filePath === "stdout") {
      process.stdout.write(line);
      return;
    }

    this._writeQueue = this._writeQueue
      .then(async () => {
        await fsp.mkdir(path.dirname(this.filePath), { recursive: true });
        await this._rotateIfNeeded(lineBytes);
        await fsp.appendFile(this.filePath, line, "utf8");
        this._size += lineBytes;
      })
      .catch((error) => {
        this._log("error", "Unable to append JSONL record", {
          path: this.filePath,
          error: error.message
        });
      });
  }

  async flush() {
    await this._writeQueue;
  }

  async read(onRecord) {
    if (!this.filePath || this.filePath === "stdout") {
      return { records: 0, corrupt: 0 };
    }
    let result = { records: 0, corrupt: 0 };
    const files = [];
    for (let index = this.maxFiles; index >= 1; index -= 1) {
      files.push(`${this.filePath}.${index}`);
    }
    files.push(this.filePath);
    for (const filePath of files) {
      const fileResult = await this._readFile(filePath, onRecord);
      result = {
        records: result.records + fileResult.records,
        corrupt: result.corrupt + fileResult.corrupt
      };
    }
    return result;
  }

  async _readFile(filePath, onRecord) {
    let stream;
    try {
      stream = fs.createReadStream(filePath, { encoding: "utf8" });
    } catch (error) {
      if (error.code === "ENOENT") {
        return { records: 0, corrupt: 0 };
      }
      throw error;
    }

    const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
    let records = 0;
    let corrupt = 0;
    try {
      for await (const line of lines) {
        if (!line.trim()) {
          continue;
        }
        let record;
        try {
          record = JSON.parse(line);
        } catch (error) {
          corrupt += 1;
          this._log("warn", "Skipping corrupt JSONL record", {
            path: filePath,
            error: error.message
          });
          continue;
        }
        records += 1;
        onRecord(record);
      }
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    } finally {
      lines.close();
      stream.destroy?.();
    }
    return { records, corrupt };
  }

  async _rotateIfNeeded(lineBytes) {
    if (this.maxBytes <= 0 || this.maxFiles <= 0) {
      return;
    }
    if (this._size === null) {
      try {
        this._size = (await fsp.stat(this.filePath)).size;
      } catch (error) {
        if (error.code === "ENOENT") {
          this._size = 0;
        } else {
          throw error;
        }
      }
    }
    if (this._size === 0 || this._size + lineBytes <= this.maxBytes) {
      return;
    }

    await fsp.rm(`${this.filePath}.${this.maxFiles}`, { force: true });
    for (let index = this.maxFiles - 1; index >= 1; index -= 1) {
      await this._renameIfExists(`${this.filePath}.${index}`, `${this.filePath}.${index + 1}`);
    }
    await this._renameIfExists(this.filePath, `${this.filePath}.1`);
    this._size = 0;
  }

  async _renameIfExists(from, to) {
    try {
      await fsp.rename(from, to);
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
  }

  _log(level, message, data = {}) {
    if (!this.logger) {
      return;
    }
    const method = this.logger[level] || this.logger.info;
    if (typeof method === "function") {
      method({
        timestamp: new Date().toISOString(),
        level,
        module: "jsonl",
        message,
        ...data
      });
    }
  }
}

module.exports = {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_FILES,
  JsonlLog
};
