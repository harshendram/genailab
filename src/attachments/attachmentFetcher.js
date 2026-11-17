/**
 * Attachment Fetcher Module
 * Downloads, syncs and summarises Gmail attachments.
 *
 * Every downloaded file is recorded in a manifest inside the output
 * directory, which lets `syncAttachments` skip files it already has and
 * lets `getAttachmentStats` report on them without hitting the Gmail API.
 */
const fs = require("fs-extra");
const path = require("path");
const chalk = require("chalk");

const MANIFEST_NAME = ".attachments-manifest.json";

// Extensions that should be treated as the same type when filtering.
const TYPE_ALIASES = {
  jpg: ["jpg", "jpeg"],
  jpeg: ["jpg", "jpeg"],
  tif: ["tif", "tiff"],
  tiff: ["tif", "tiff"],
  htm: ["htm", "html"],
  html: ["htm", "html"],
};

/**
 * Format a byte count as a human readable string
 * @param {number} bytes
 * @returns {string}
 */
function formatFileSize(bytes) {
  if (!bytes || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/**
 * Make a filename safe for Windows/macOS/Linux file systems
 * @param {string} name
 * @returns {string}
 */
function sanitizeFilename(name) {
  const cleaned = String(name || "attachment")
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
    .replace(/[. ]+$/, "")
    .trim();
  return cleaned || "attachment";
}

/**
 * Lower-case file extension without the dot ("" if none)
 * @param {string} filename
 * @returns {string}
 */
function getExtension(filename) {
  return path.extname(filename || "").replace(".", "").toLowerCase();
}

/**
 * Build the set of allowed extensions from the user's --types option
 * @param {string[]} fileTypes
 * @returns {Set<string>|null} null means "allow everything"
 */
function buildAllowedTypes(fileTypes) {
  if (!Array.isArray(fileTypes) || fileTypes.length === 0) return null;
  const allowed = new Set();
  fileTypes
    .map((t) => String(t).trim().replace(/^\./, "").toLowerCase())
    .filter(Boolean)
    .forEach((t) => (TYPE_ALIASES[t] || [t]).forEach((a) => allowed.add(a)));
  return allowed.size > 0 ? allowed : null;
}

/**
 * Recursively collect attachment parts from a Gmail message payload
 * @param {Object} part Gmail message part
 * @param {Array} found Accumulator
 * @returns {Array<{filename, mimeType, size, attachmentId, data}>}
 */
function collectAttachmentParts(part, found = []) {
  if (!part) return found;

  if (part.filename && part.body && (part.body.attachmentId || part.body.data)) {
    found.push({
      filename: part.filename,
      mimeType: part.mimeType,
      size: part.body.size || 0,
      attachmentId: part.body.attachmentId || null,
      data: part.body.data || null,
    });
  }

  if (Array.isArray(part.parts)) {
    part.parts.forEach((child) => collectAttachmentParts(child, found));
  }
  return found;
}

/**
 * Read a header value from a Gmail payload
 */
function getHeader(payload, name) {
  const headers = (payload && payload.headers) || [];
  const header = headers.find((h) => h.name.toLowerCase() === name.toLowerCase());
  return header ? header.value : "";
}

/**
 * Get the full Gmail message for an email, using the cached raw copy if present
 * @param {Object} gmail Gmail API client
 * @param {Object} email Parsed email object from emailFetcher
 * @returns {Promise<Object>} Gmail message resource
 */
async function getFullMessage(gmail, email) {
  if (email.raw && email.raw.payload) return email.raw;
  const res = await gmail.users.messages.get({
    userId: "me",
    id: email.id,
    format: "full",
  });
  return res.data;
}

/**
 * Pick a non-colliding path inside a directory
 * @param {string} dir
 * @param {string} filename
 * @returns {Promise<string>}
 */
async function uniquePath(dir, filename) {
  const ext = path.extname(filename);
  const base = path.basename(filename, ext);
  let candidate = path.join(dir, filename);
  let counter = 1;
  while (await fs.pathExists(candidate)) {
    candidate = path.join(dir, `${base} (${counter})${ext}`);
    counter++;
  }
  return candidate;
}

/**
 * Extract a short sender name/address from a From header
 * @param {string} from
 * @returns {string}
 */
function senderLabel(from) {
  if (!from) return "Unknown";
  const match = from.match(/<([^>]+)>/);
  return (match ? match[1] : from).trim();
}

/**
 * Load the download manifest for an output directory
 * @param {string} outputDir
 * @returns {Promise<{lastSync: string|null, files: Object}>}
 */
async function loadManifest(outputDir) {
  const manifestPath = path.join(outputDir, MANIFEST_NAME);
  try {
    if (await fs.pathExists(manifestPath)) {
      const manifest = await fs.readJson(manifestPath);
      return { lastSync: manifest.lastSync || null, files: manifest.files || {} };
    }
  } catch (error) {
    console.warn(chalk.yellow(`⚠️  Could not read attachment manifest: ${error.message}`));
  }
  return { lastSync: null, files: {} };
}

/**
 * Save the download manifest
 */
async function saveManifest(outputDir, manifest) {
  await fs.ensureDir(outputDir);
  await fs.writeJson(path.join(outputDir, MANIFEST_NAME), manifest, { spaces: 2 });
}

/**
 * Core download routine shared by fetch and sync
 * @param {Object} gmail Gmail API client
 * @param {Array} emails Parsed email objects
 * @param {Object} options
 * @param {boolean} onlyNew Skip attachments already in the manifest
 */
async function downloadAttachments(gmail, emails, options = {}, onlyNew = false) {
  const {
    outputDir = "./attachments",
    fileTypes = [],
    maxFileSize = 25 * 1024 * 1024,
    organizeByDate = true,
    organizeByType = true,
  } = options;

  const results = {
    totalFiles: 0,
    totalSize: 0,
    downloaded: [],
    skipped: [],
    errors: [],
  };

  const allowedTypes = buildAllowedTypes(fileTypes);
  const manifest = await loadManifest(outputDir);
  await fs.ensureDir(outputDir);

  for (const email of emails || []) {
    if (!email || !email.id) continue;

    let message;
    try {
      message = await getFullMessage(gmail, email);
    } catch (error) {
      results.errors.push({ emailId: email.id, error: error.message });
      continue;
    }

    const parts = collectAttachmentParts(message.payload);
    if (parts.length === 0) continue;

    const from = email.from || getHeader(message.payload, "From");
    const subject = email.subject || getHeader(message.payload, "Subject");
    const emailDate = new Date(
      email.date || getHeader(message.payload, "Date") || Number(message.internalDate)
    );
    const dateValid = !isNaN(emailDate.getTime());
    const monthKey = dateValid
      ? `${emailDate.getFullYear()}-${String(emailDate.getMonth() + 1).padStart(2, "0")}`
      : "unknown-date";

    for (const part of parts) {
      const filename = sanitizeFilename(part.filename);
      const type = getExtension(filename) || "other";
      const key = `${email.id}:${part.attachmentId || filename}`;

      if (allowedTypes && !allowedTypes.has(type)) {
        results.skipped.push({ filename, reason: `type .${type} not selected` });
        continue;
      }
      if (maxFileSize && part.size > maxFileSize) {
        results.skipped.push({
          filename,
          reason: `larger than ${formatFileSize(maxFileSize)}`,
        });
        continue;
      }
      if (onlyNew && manifest.files[key] && (await fs.pathExists(manifest.files[key].path))) {
        results.skipped.push({ filename, reason: "already downloaded" });
        continue;
      }

      try {
        let data = part.data;
        if (!data && part.attachmentId) {
          const res = await gmail.users.messages.attachments.get({
            userId: "me",
            messageId: email.id,
            id: part.attachmentId,
          });
          data = res.data.data;
        }
        if (!data) throw new Error("attachment has no data");

        const buffer = Buffer.from(data, "base64url");

        let targetDir = outputDir;
        if (organizeByDate) targetDir = path.join(targetDir, monthKey);
        if (organizeByType) targetDir = path.join(targetDir, type);
        await fs.ensureDir(targetDir);

        const filePath = await uniquePath(targetDir, filename);
        await fs.writeFile(filePath, buffer);

        const record = {
          filename,
          path: filePath,
          size: buffer.length,
          type,
          mimeType: part.mimeType,
          emailId: email.id,
          subject,
          from: senderLabel(from),
          date: dateValid ? emailDate.toISOString() : null,
          downloadedAt: new Date().toISOString(),
        };

        manifest.files[key] = record;
        results.downloaded.push(record);
        results.totalFiles++;
        results.totalSize += buffer.length;
        console.log(chalk.green(`  ✓ ${filename} (${formatFileSize(buffer.length)})`));
      } catch (error) {
        results.errors.push({ filename, emailId: email.id, error: error.message });
        console.log(chalk.red(`  ✗ ${filename}: ${error.message}`));
      }
    }
  }

  manifest.lastSync = new Date().toISOString();
  await saveManifest(outputDir, manifest);

  return results;
}

/**
 * Download all matching attachments from the given emails
 * @param {Object} gmail Gmail API client
 * @param {Array} emails Parsed email objects
 * @param {Object} options { outputDir, fileTypes, maxFileSize, organizeByDate, organizeByType }
 * @returns {Promise<Object>} { totalFiles, totalSize, downloaded, skipped, errors }
 */
async function fetchAttachments(gmail, emails, options = {}) {
  return downloadAttachments(gmail, emails, options, false);
}

/**
 * Download only attachments that have not been downloaded before
 * @param {Object} gmail Gmail API client
 * @param {Array} emails Parsed email objects
 * @param {Object} options Same as fetchAttachments
 * @returns {Promise<Object>} { totalFiles, totalSize, downloaded, skipped, errors }
 */
async function syncAttachments(gmail, emails, options = {}) {
  return downloadAttachments(gmail, emails, options, true);
}

/**
 * Summarise previously downloaded attachments
 * @param {string} outputDir Attachments directory
 * @returns {Promise<Object>} { totalFiles, totalSize, lastSync, fileTypes, byMonth, byEmailSender } or { error }
 */
async function getAttachmentStats(outputDir = "./attachments") {
  const manifestPath = path.join(outputDir, MANIFEST_NAME);
  if (!(await fs.pathExists(manifestPath))) {
    return { error: "No attachment data found" };
  }

  const manifest = await loadManifest(outputDir);
  const stats = {
    totalFiles: 0,
    totalSize: 0,
    lastSync: manifest.lastSync,
    fileTypes: {},
    byMonth: {},
    byEmailSender: {},
  };

  for (const record of Object.values(manifest.files)) {
    if (!(await fs.pathExists(record.path))) continue; // file was deleted by the user

    stats.totalFiles++;
    stats.totalSize += record.size || 0;
    stats.fileTypes[record.type] = (stats.fileTypes[record.type] || 0) + 1;

    const month = record.date ? record.date.slice(0, 7) : "unknown-date";
    stats.byMonth[month] = (stats.byMonth[month] || 0) + 1;

    const sender = record.from || "Unknown";
    stats.byEmailSender[sender] = (stats.byEmailSender[sender] || 0) + 1;
  }

  return stats;
}

module.exports = {
  fetchAttachments,
  syncAttachments,
  getAttachmentStats,
  formatFileSize,
};
