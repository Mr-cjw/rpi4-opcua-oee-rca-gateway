"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const readline = require("node:readline");

class JsonlLog {
  constructor(filePath, options = {}) {
    this.filePath = filePath || null;
    this.logger = options.logger || null;
    this._writeQueue = Promise.resolve();
  }

  get enabled() {
    return Boolean(this.filePath);
  }

  append(record) {
    if (!this.filePath) {
      return;
    }
    const line = `${JSON.stringify(record)}\n`;
    if (this.filePath === "stdout") {
      process.stdout.write(line);
      return;
    }

    this._writeQueue = this._writeQueue
      .then(async () => {
        await fsp.mkdir(path.dirname(this.filePath), { recursive: true });
        await fsp.appendFile(this.filePath, line, "utf8");
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
    let stream;
    try {
      stream = fs.createReadStream(this.filePath, { encoding: "utf8" });
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
            path: this.filePath,
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
  JsonlLog
};
