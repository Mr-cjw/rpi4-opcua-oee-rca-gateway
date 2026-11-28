"use strict";

const fs = require("node:fs");
const path = require("node:path");

function readInlineOrFileSecret(
  env,
  {
    valueName,
    fileName,
    trim = false,
    allowEmpty = false
  }
) {
  const inlineValue = env[valueName];
  const configuredFile = env[fileName];
  const hasInlineValue = inlineValue !== undefined && inlineValue !== "";
  const hasFile = configuredFile !== undefined && configuredFile !== "";

  if (hasInlineValue && hasFile) {
    throw new Error(`${valueName} and ${fileName} cannot be configured together`);
  }

  let value = hasInlineValue ? inlineValue : "";
  if (hasFile) {
    const secretPath = path.resolve(configuredFile);
    try {
      value = fs.readFileSync(secretPath, "utf8");
    } catch (error) {
      throw new Error(`${fileName} is not readable: ${error.message}`);
    }
    value = value.replace(/\r?\n$/, "");
  }

  if (trim) {
    value = value.trim();
  }
  if (/[\r\n]/.test(value)) {
    throw new Error(`${valueName} must not contain line breaks`);
  }
  if (!allowEmpty && value === "") {
    throw new Error(`${valueName} must not be empty`);
  }
  return value;
}

function resolveCredentialPair(
  env,
  {
    usernameName,
    passwordName,
    usernameFileName,
    passwordFileName
  }
) {
  const usernameConfigured =
    (env[usernameName] !== undefined && env[usernameName] !== "") ||
    (env[usernameFileName] !== undefined && env[usernameFileName] !== "");
  const passwordConfigured =
    (env[passwordName] !== undefined && env[passwordName] !== "") ||
    (env[passwordFileName] !== undefined && env[passwordFileName] !== "");

  if (usernameConfigured !== passwordConfigured) {
    throw new Error(`${usernameName} and ${passwordName} must be configured together`);
  }
  if (!usernameConfigured) {
    return { username: "", password: "" };
  }

  return {
    username: readInlineOrFileSecret(env, {
      valueName: usernameName,
      fileName: usernameFileName,
      trim: true
    }),
    password: readInlineOrFileSecret(env, {
      valueName: passwordName,
      fileName: passwordFileName
    })
  };
}

module.exports = {
  readInlineOrFileSecret,
  resolveCredentialPair
};
