/**
 * AI features: classification, summaries, replies, calendar events, search,
 * tagging, sentiment and follow-up checks.
 *
 * All model calls go through ./aiProvider (Azure OpenAI or Google Gemini),
 * which handles rate limits and retries. This module builds the prompts,
 * parses the JSON replies and maps results back to emails.
 * (The file keeps its historical name so existing imports keep working.)
 */
const fs = require("fs-extra");
const path = require("path");
const chalk = require("chalk");
const { generate, getProviderInfo } = require("./aiProvider");

const MAX_CONTENT_CHARS = 4000; // per email sent to the model

// ---------- configuration ----------

function loadConfig() {
  const configPath = path.join(__dirname, "../../config.json");
  let config = {};
  try {
    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, "utf8").trim();
      if (raw) config = JSON.parse(raw);
    }
  } catch {
    // malformed config.json: use defaults
  }
  return { tempDir: "./temp", ...config, batchSize: Number(config.batchSize) || 20 };
}

/**
 * Check if an AI provider is configured
 * @returns {Object} Configuration status
 */
function checkAIConfiguration() {
  const info = getProviderInfo();
  return {
    configured: info.configured,
    provider: info.label,
    model: info.model,
    apiKey: info.configured ? "✓ Set" : "✗ Missing",
    setupInstructions: info.configured ? null : info.setupHint,
  };
}

// ---------- JSON parsing ----------

/**
 * Index of the bracket that closes the one at `start`, respecting strings
 */
function findClosingBracket(text, start) {
  const stack = [];
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "[" || ch === "{") stack.push(ch === "[" ? "]" : "}");
    else if (ch === "]" || ch === "}") {
      if (stack.pop() !== ch) return -1;
      if (stack.length === 0) return i;
    }
  }
  return -1;
}

/**
 * Pull the first JSON value out of a model reply (handles code fences and
 * surrounding prose). Returns null if none parses.
 */
function extractJSON(text) {
  if (typeof text !== "string") return null;
  let body = text.trim().replace(/^﻿/, "");
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(body);
  if (fenced) body = fenced[1].trim();

  try {
    return JSON.parse(body);
  } catch {
    // fall through to bracket matching
  }

  const start = body.search(/[[{]/);
  if (start === -1) return null;
  const end = findClosingBracket(body, start);
  if (end === -1) return null;
  const candidate = body.slice(start, end + 1);
  try {
    return JSON.parse(candidate);
  } catch {
    try {
      return JSON.parse(
        candidate
          .replace(/[“”]/g, '"')
          .replace(/,(\s*[}\]])/g, "$1")
      );
    } catch {
      return null;
    }
  }
}

/**
 * Parse a reply that should be an array of per-email results. Accepts a bare
 * array or an object wrapping it (e.g. {"results": [...]}).
 * @returns {Array|null}
 */
function parseAIResponse(response) {
  const parsed = extractJSON(response);
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === "object") {
    if (Array.isArray(parsed.results)) return parsed.results;
    const arrays = Object.values(parsed).filter(Array.isArray);
    if (arrays.length === 1) return arrays[0];
    return [parsed];
  }
  return null;
}

// ---------- helpers ----------

function toISODate(value) {
  const date = value instanceof Date ? value : new Date(value);
  return isNaN(date.getTime()) ? String(value || "") : date.toISOString();
}

/**
 * Plain-text email content for prompts: HTML stripped, whitespace collapsed,
 * capped at MAX_CONTENT_CHARS so large newsletters don't blow the token budget.
 */
function emailContent(email) {
  let text = String(email.body || email.snippet || "");
  if (/<[a-z!/][\s\S]*>/i.test(text)) {
    text = text
      .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"')
      .replace(/&#39;|&apos;/gi, "'");
  }
  text = text.replace(/[ \t\f\v ]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
  return text.length > MAX_CONTENT_CHARS ? `${text.slice(0, MAX_CONTENT_CHARS)} …[truncated]` : text;
}

function toPromptEmail(email) {
  return {
    id: email.id,
    subject: email.subject,
    from: email.from,
    date: toISODate(email.date),
    content: emailContent(email),
  };
}

function findById(results, id) {
  return (results || []).find((r) => r && String(r.id) === String(id));
}

function makeBatches(items, size) {
  const batches = [];
  for (let i = 0; i < items.length; i += size) batches.push(items.slice(i, i + size));
  return batches;
}

/** Errors that will fail every request (bad key, missing deployment, quota) */
function isFatal(error) {
  return Boolean(error && (error.fatal || error.quotaExceeded));
}

function warn(message) {
  console.warn(chalk.yellow(`⚠️  ${message}`));
}

/**
 * Process emails in batches
 * @param {Array} emails Array of email objects
 * @param {Function} processFn Function to process each batch
 * @param {Function} progressCallback Optional callback for progress updates
 * @returns {Promise<Array>} Array of processed results
 */
async function processBatches(emails, processFn, progressCallback = null) {
  const batches = makeBatches(emails, loadConfig().batchSize);
  const results = [];
  for (let i = 0; i < batches.length; i++) {
    if (progressCallback) progressCallback(i + 1, batches.length);
    results.push(...(await processFn(batches[i])));
  }
  return results;
}

// ---------- analysis (classification, summary, suggested reply) ----------

const PRIORITIES = ["Urgent", "Important", "Normal"];

function defaultClassification() {
  return {
    priority: "Normal",
    priorityConfidence: 0,
    type: "Others",
    actionRequired: false,
    actionConfidence: 0,
    actionItems: [],
  };
}

function normalizeClassification(result) {
  const { id, ...rest } = result;
  const priority = PRIORITIES.find((p) => p.toLowerCase() === String(rest.priority || "").toLowerCase()) || "Normal";
  return {
    ...defaultClassification(),
    ...rest,
    priority,
    actionRequired: Boolean(rest.actionRequired),
    actionItems: Array.isArray(rest.actionItems) ? rest.actionItems : [],
  };
}

function defaultSummary(email) {
  return {
    summary: [email.snippet || "No summary available"],
    keyPoints: [],
    deadlines: [],
    estimatedReadingTime: 1,
  };
}

function normalizeSummary(result) {
  const { id, ...rest } = result;
  const asList = (value) => (Array.isArray(value) ? value : value ? [String(value)] : []);
  return {
    ...rest,
    summary: asList(rest.summary),
    keyPoints: asList(rest.keyPoints),
    deadlines: asList(rest.deadlines),
    estimatedReadingTime: Number(rest.estimatedReadingTime) || 1,
  };
}

/**
 * Run one JSON prompt for a batch and map each result back to its email.
 * Emails the model skipped, or the whole batch on a non-fatal failure,
 * get the fallback value and are flagged `_aiFailed` (not cached).
 */
async function runBatchPrompt(emailBatch, prompt, step, { field, normalize, fallback }) {
  try {
    const results = parseAIResponse(await generate(prompt, { json: true }));
    if (!results) throw new Error("the AI reply was not valid JSON");
    return emailBatch.map((email) => {
      const found = findById(results, email.id);
      return found
        ? { ...email, [field]: normalize(found) }
        : { ...email, [field]: fallback(email), _aiFailed: true };
    });
  } catch (error) {
    if (isFatal(error)) throw error;
    warn(`AI ${step} failed for ${emailBatch.length} email(s): ${error.message}`);
    return emailBatch.map((email) => ({ ...email, [field]: fallback(email), _aiFailed: true }));
  }
}

/**
 * Classify email priority for a batch of emails
 * @param {Array} emailBatch Batch of email objects
 * @returns {Promise<Array>} Emails with a `classification` field
 */
async function classifyEmailPriorityBatch(emailBatch) {
  const prompt = `
      Analyze these emails and classify each one's priority as either "Urgent", "Important", or "Normal".
      Also determine if each contains any action items that require a response or action.

      Emails:
      ${JSON.stringify(emailBatch.map(toPromptEmail), null, 2)}

      Respond in JSON format only with an array of results, one for each email:
      [
        {
          "id": "email_id_1",
          "priority": "Urgent|Important|Normal",
          "priorityConfidence": <number between 0-100>,
          "type": "Personal|Work|Marketing|Updates|Others",
          "actionRequired": true|false,
          "actionConfidence": <number between 0-100>,
          "actionItems": ["list", "of", "action", "items"]
        }
      ]
    `;
  return runBatchPrompt(emailBatch, prompt, "classification", {
    field: "classification",
    normalize: normalizeClassification,
    fallback: defaultClassification,
  });
}

/**
 * Generate email summaries for a batch of emails
 * @param {Array} emailBatch Batch of email objects
 * @returns {Promise<Array>} Emails with a `summary` field
 */
async function generateEmailSummaryBatch(emailBatch) {
  const prompt = `
      Summarize each of these emails in bullet points. Extract key points, deadlines, and important information.

      Emails:
      ${JSON.stringify(emailBatch.map(toPromptEmail), null, 2)}

      Respond in JSON format only with an array of results, one for each email:
      [
        {
          "id": "email_id_1",
          "summary": ["bullet point 1", "bullet point 2"],
          "keyPoints": ["key point 1", "key point 2"],
          "deadlines": ["deadline 1"],
          "estimatedReadingTime": <number in minutes>
        }
      ]
    `;
  return runBatchPrompt(emailBatch, prompt, "summary", {
    field: "summary",
    normalize: normalizeSummary,
    fallback: defaultSummary,
  });
}

/**
 * Generate suggested responses for a batch of emails
 * @param {Array} emailBatch Batch of email objects
 * @returns {Promise<Array>} Emails with a `suggestedResponse` field
 */
async function generateSuggestedResponseBatch(emailBatch) {
  const prompt = `
      Generate professional responses to each of these emails. The responses should be concise, address any questions or action items,
      and maintain a professional tone.

      Emails:
      ${JSON.stringify(emailBatch.map(toPromptEmail), null, 2)}

      Respond in JSON format only with an array of results, one for each email:
      [
        {
          "id": "email_id_1",
          "suggestedResponse": "Response text here..."
        }
      ]
    `;
  return runBatchPrompt(emailBatch, prompt, "reply suggestion", {
    field: "suggestedResponse",
    normalize: (result) => String(result.suggestedResponse || ""),
    fallback: () => "Unable to generate a response at this time.",
  });
}

/**
 * Analyze emails: classification, summary and suggested reply, in batches
 * of `batchSize` emails per request. Successful results are cached in
 * temp/analyzed_cache.json; failed ones are retried on the next run.
 * @param {Array} emails Array of email objects
 * @param {Function} progressCallback Optional (step, batchNum, totalBatches)
 * @returns {Promise<Array>} Array of analyzed emails
 */
async function analyzeEmails(emails, progressCallback = null) {
  const config = loadConfig();
  const tempDir = path.join(__dirname, "../../", config.tempDir || "./temp");
  await fs.ensureDir(tempDir);

  const cacheFile = path.join(tempDir, "analyzed_cache.json");
  let cache = {};
  try {
    if (await fs.pathExists(cacheFile)) cache = await fs.readJson(cacheFile);
  } catch {
    cache = {}; // unreadable cache: rebuild it
  }

  // Only reuse complete analyses (older caches could hold failed defaults)
  const isCached = (email) => cache[email.id] && cache[email.id].aiAnalyzed;
  const emailsToAnalyze = emails.filter((email) => !isCached(email));
  const cachedEmails = emails.filter(isCached).map((email) => cache[email.id]);

  if (emailsToAnalyze.length === 0) return cachedEmails;

  const progress = (step) => (batchNum, totalBatches) => {
    if (progressCallback) progressCallback(step, batchNum, totalBatches);
  };

  const classified = await processBatches(emailsToAnalyze, classifyEmailPriorityBatch, progress("classification"));
  const summarized = await processBatches(classified, generateEmailSummaryBatch, progress("summarization"));
  const analyzed = await processBatches(summarized, generateSuggestedResponseBatch, progress("response generation"));

  let failed = 0;
  const results = analyzed.map(({ _aiFailed, ...email }) => {
    if (_aiFailed) {
      failed++;
      return email;
    }
    const complete = { ...email, aiAnalyzed: true };
    cache[email.id] = complete;
    return complete;
  });

  await fs.writeJson(cacheFile, cache);
  if (failed > 0) {
    warn(`AI analysis was incomplete for ${failed} email(s); they will be retried on the next analyze.`);
  }
  return [...results, ...cachedEmails];
}

// ---------- calendar events ----------

/**
 * Extract calendar events from one email
 * @param {Object} email Email object
 * @returns {Promise<Array>} Array of calendar events
 */
async function extractCalendarEvents(email) {
  const prompt = `
      Extract any date/time-based tasks or meetings from this email. Only extract important dates, not every date mentioned.
      Name the events properly based on context.

      Email Subject: ${email.subject}
      From: ${email.from}
      Date: ${toISODate(email.date)}
      Content: ${emailContent(email)}

      Respond in JSON format only:
      {
        "events": [
          {
            "title": "Event title",
            "date": "YYYY-MM-DD",
            "time": "HH:MM (optional)",
            "endTime": "HH:MM (optional)",
            "description": "Brief description of the event"
          }
        ]
      }
    `;
  try {
    const parsed = extractJSON(await generate(prompt, { json: true }));
    if (parsed && Array.isArray(parsed.events)) return parsed.events;
    if (Array.isArray(parsed)) return parsed.flatMap((item) => (item && item.events) || []);
    return [];
  } catch (error) {
    if (isFatal(error)) throw error;
    warn(`Could not extract calendar events: ${error.message}`);
    return [];
  }
}

/**
 * Extract calendar events from multiple emails
 * @param {Array} emails Array of email objects
 * @param {Function} progressCallback Optional callback for progress updates
 * @returns {Promise<Array>} Array of calendar events
 */
async function extractCalendarEventsFromEmails(emails, progressCallback = null) {
  const batches = makeBatches(emails.map(toPromptEmail), loadConfig().batchSize);
  const allEvents = [];

  for (let i = 0; i < batches.length; i++) {
    if (progressCallback) progressCallback(i + 1, batches.length);
    const prompt = `
        Extract any date/time-based tasks or meetings from these emails. Only extract important dates, not every date mentioned.
        Name the events properly based on context.

        Emails:
        ${JSON.stringify(batches[i], null, 2)}

        Respond in JSON format only with an array of results, one for each email:
        [
          {
            "id": "email_id_1",
            "events": [
              {
                "title": "Event title",
                "date": "YYYY-MM-DD",
                "time": "HH:MM (optional)",
                "endTime": "HH:MM (optional)",
                "description": "Brief description of the event"
              }
            ]
          }
        ]
      `;
    try {
      const results = parseAIResponse(await generate(prompt, { json: true })) || [];
      results.forEach((item) => {
        if (item && Array.isArray(item.events)) allEvents.push(...item.events);
      });
    } catch (error) {
      if (isFatal(error)) throw error;
      warn(`Could not extract calendar events from batch ${i + 1}: ${error.message}`);
    }
  }
  return allEvents;
}

// ---------- search ----------

function simpleTextSearch(emails, query) {
  const q = query.toLowerCase();
  return emails.filter((email) =>
    [email.subject, email.from, email.snippet].some((field) => String(field || "").toLowerCase().includes(q))
  );
}

/**
 * Search emails with a natural language query (falls back to plain text search)
 * @param {Array} emails Array of email objects
 * @param {string} query Natural language query
 * @returns {Promise<Array>} Array of matching emails
 */
async function searchEmailsWithNLP(emails, query) {
  if (!getProviderInfo().configured) {
    console.log("⚠️  No AI provider configured. Using simple text search instead.");
    return simpleTextSearch(emails, query);
  }

  const emailsJson = JSON.stringify(
    emails.map((email) => ({
      id: email.id,
      subject: email.subject,
      from: email.from,
      date: toISODate(email.date),
      snippet: email.snippet,
    }))
  );

  const prompt = `
      I have a list of emails and a search query. Find emails that match the query.
      Today's date is ${new Date().toISOString().slice(0, 10)}.

      Search query: "${query}"

      Emails:
      ${emailsJson}

      Return the IDs of matching emails in JSON format:
      {
        "matchingIds": ["id1", "id2"]
      }

      Be flexible in interpreting the query. For example, "last month" should match emails from the previous month,
      "urgent" should match emails that seem urgent even if they don't contain that exact word.
    `;

  try {
    const parsed = extractJSON(await generate(prompt, { json: true }));
    const ids = parsed && (parsed.matchingIds || (parsed.results && parsed.results.matchingIds));
    if (!Array.isArray(ids)) throw new Error("the AI reply had no matchingIds");
    const wanted = new Set(ids.map(String));
    return emails.filter((email) => wanted.has(String(email.id)));
  } catch (error) {
    console.log(chalk.yellow(`⚠️  AI search failed (${error.message}). Using simple text search.`));
    return simpleTextSearch(emails, query);
  }
}

// ---------- tags, sentiment, follow-up ----------

/**
 * Auto-tag emails with custom labels
 * @param {Array} emails Array of email objects
 * @param {Function} progressCallback Optional callback for progress updates
 * @returns {Promise<Array>} Emails with a `tags` field
 */
async function autoTagEmails(emails, progressCallback = null) {
  const tagged = [];
  const batches = makeBatches(emails, loadConfig().batchSize);

  for (let i = 0; i < batches.length; i++) {
    if (progressCallback) progressCallback(i + 1, batches.length);
    const batch = batches[i];
    const prompt = `
        Based on the content of these emails, suggest appropriate labels/tags from the following options:
        - Invoices
        - Leads
        - Personal
        - Projects
        - Follow-up

        You can suggest multiple labels if appropriate.

        Emails:
        ${JSON.stringify(batch.map(toPromptEmail), null, 2)}

        Respond in JSON format only with an array of results, one for each email:
        [
          {
            "id": "email_id_1",
            "tags": ["tag1", "tag2"],
            "confidence": <number between 0-100>
          }
        ]
      `;
    let results = [];
    try {
      results = parseAIResponse(await generate(prompt, { json: true })) || [];
    } catch (error) {
      if (isFatal(error)) throw error;
      warn(`Auto-tagging failed for batch ${i + 1}: ${error.message}`);
    }
    batch.forEach((email) => {
      const found = findById(results, email.id);
      tagged.push({
        ...email,
        tags: found
          ? { tags: Array.isArray(found.tags) ? found.tags : [], confidence: Number(found.confidence) || 0 }
          : { tags: [], confidence: 0 },
      });
    });
  }
  return tagged;
}

/**
 * Sentiment analysis for emails
 * @param {Array} emails Array of email objects
 * @param {Function} progressCallback Optional callback for progress updates
 * @returns {Promise<Array>} One sentiment result per email
 */
async function analyzeEmailSentiment(emails, progressCallback = null) {
  const neutral = (email) => ({ id: email.id, sentiment: "neutral", sentimentScore: 0, type: "other", stressLevel: 5 });
  const results = [];
  const batches = makeBatches(emails, loadConfig().batchSize);

  for (let i = 0; i < batches.length; i++) {
    if (progressCallback) progressCallback(i + 1, batches.length);
    const batch = batches[i];
    const prompt = `
        Analyze the sentiment of these emails. Determine if each is positive, negative, or neutral.
        Also identify if each is an appreciation, complaint, or request.

        Emails:
        ${JSON.stringify(batch.map(toPromptEmail), null, 2)}

        Respond in JSON format only with an array of results, one for each email:
        [
          {
            "id": "email_id_1",
            "sentiment": "positive|negative|neutral",
            "sentimentScore": <number between -1 and 1>,
            "type": "appreciation|complaint|request|information|other",
            "stressLevel": <number between 0-10>
          }
        ]
      `;
    let parsed = [];
    try {
      parsed = parseAIResponse(await generate(prompt, { json: true })) || [];
    } catch (error) {
      if (isFatal(error)) throw error;
      warn(`Sentiment analysis failed for batch ${i + 1}: ${error.message}`);
    }
    batch.forEach((email) => results.push(findById(parsed, email.id) || neutral(email)));
  }
  return results;
}

/**
 * Check if emails need follow-up
 * @param {Array} emails Array of email objects
 * @param {Function} progressCallback Optional callback for progress updates
 * @returns {Promise<Array>} Emails with a `followUp` field
 */
async function checkNeedsFollowUp(emails, progressCallback = null) {
  const noFollowUp = { needsFollowUp: false, confidence: 0, reason: "Could not analyze email", suggestedFollowUp: "" };
  const results = [];
  const batches = makeBatches(emails, loadConfig().batchSize);

  for (let i = 0; i < batches.length; i++) {
    if (progressCallback) progressCallback(i + 1, batches.length);
    const batch = batches[i];
    const prompt = `
        Analyze these emails and determine if each requires a follow-up response.
        Consider factors like:
        - Does it contain questions that need answers?
        - Does it request information or action?
        - Does the tone suggest an expectation of response?

        Emails:
        ${JSON.stringify(batch.map(toPromptEmail), null, 2)}

        Respond in JSON format only with an array of results, one for each email:
        [
          {
            "id": "email_id_1",
            "needsFollowUp": true|false,
            "confidence": <number between 0-100>,
            "reason": "brief explanation",
            "suggestedFollowUp": "suggested follow-up message"
          }
        ]
      `;
    let parsed = [];
    try {
      parsed = parseAIResponse(await generate(prompt, { json: true })) || [];
    } catch (error) {
      if (isFatal(error)) throw error;
      warn(`Follow-up check failed for batch ${i + 1}: ${error.message}`);
    }
    batch.forEach((email) => {
      const found = findById(parsed, email.id);
      const { id, ...followUp } = found || {};
      results.push({ ...email, followUp: found ? { ...noFollowUp, ...followUp } : noFollowUp });
    });
  }
  return results;
}

// ---------- reply drafts ----------

/**
 * Generate a full email reply draft
 * @param {Object} email Email object
 * @returns {Promise<string>} Reply draft text
 */
async function generateFullReplyDraft(email) {
  const prompt = `
      Generate a full professional reply draft for this email, including greeting, body, and closing.
      The reply should reflect the appropriate urgency, tone (friendly or formal based on context),
      and address all questions or expected outcomes mentioned.

      Email Subject: ${email.subject}
      From: ${email.from}
      Date: ${toISODate(email.date)}
      Content: ${emailContent(email)}

      Generate only the reply text, without any additional formatting or explanation.
    `;
  try {
    return (await generate(prompt)).trim();
  } catch (error) {
    console.error(chalk.red(`Error generating reply draft: ${error.message}`));
    return "Failed to generate a reply draft.";
  }
}

// ---------- config ----------

/**
 * Update configuration
 * @param {Object} newConfig New configuration values
 * @returns {Promise<Object>} Updated configuration
 */
async function updateConfig(newConfig) {
  const configPath = path.join(__dirname, "../../config.json");
  const updatedConfig = { ...loadConfig(), ...newConfig };
  await fs.writeJson(configPath, updatedConfig, { spaces: 2 });
  return updatedConfig;
}

/**
 * Get current configuration
 * @returns {Object} Current configuration
 */
function getConfig() {
  return loadConfig();
}

module.exports = {
  analyzeEmails,
  extractCalendarEvents,
  extractCalendarEventsFromEmails,
  searchEmailsWithNLP,
  autoTagEmails,
  analyzeEmailSentiment,
  checkNeedsFollowUp,
  generateFullReplyDraft,
  updateConfig,
  getConfig,
  checkAIConfiguration,
  parseAIResponse,
  extractJSON,
  classifyEmailPriorityBatch,
  generateEmailSummaryBatch,
};
