"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const SKIP_DIRS = new Set([".git", "node_modules", "data", "coverage"]);

async function markdownFiles(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".") && entry.name !== ".github") {
      continue;
    }
    if (SKIP_DIRS.has(entry.name)) {
      continue;
    }
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await markdownFiles(fullPath)));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(fullPath);
    }
  }
  return files;
}

function localLinks(markdown) {
  const withoutFences = markdown.replace(/```[\s\S]*?```/g, "");
  const links = [];
  const pattern = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  for (const match of withoutFences.matchAll(pattern)) {
    const target = match[1];
    if (
      target.startsWith("#") ||
      target.startsWith("/") ||
      target.startsWith("http://") ||
      target.startsWith("https://") ||
      target.startsWith("mailto:") ||
      target.startsWith("opc.tcp://")
    ) {
      continue;
    }
    links.push(target.split("#", 1)[0].split("?", 1)[0]);
  }
  return links.filter(Boolean);
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const files = await markdownFiles(ROOT);
  const failures = [];
  let linkCount = 0;
  for (const file of files) {
    const markdown = await fs.readFile(file, "utf8");
    for (const link of localLinks(markdown)) {
      linkCount += 1;
      const target = path.resolve(path.dirname(file), decodeURIComponent(link));
      if (!(await pathExists(target))) {
        failures.push(`${path.relative(ROOT, file)} -> ${link}`);
      }
    }
  }

  if (failures.length > 0) {
    console.error("Broken local documentation links:");
    for (const failure of failures) {
      console.error(`  ${failure}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log(`Documentation link check passed (${files.length} files, ${linkCount} local links).`);
}

main().catch((error) => {
  console.error(`Documentation link check failed: ${error.message}`);
  process.exitCode = 1;
});
