/**
 * AI Provider
 * One `generate(prompt, { json })` call for the whole app, backed by
 * Azure OpenAI (used when AZURE_OPENAI_API_KEY is set) or Google Gemini.
 *
 * It paces requests to stay under the provider's per-minute limit, waits and
 * retries when the provider answers 429 (rate limited) or 5xx, and turns API
 * failures into short, readable errors.
 *
 * Settings (.env):
 *   AI_PROVIDER              "azure" or "gemini" (default: azure if its key is set)
 *   AZURE_OPENAI_API_KEY     Azure OpenAI key
 *   AZURE_OPENAI_ENDPOINT    e.g. https://<resource>.openai.azure.com/openai/v1
 *   AZURE_OPENAI_DEPLOYMENT  deployment name (default gpt-5.4-mini)
 *   GEMINI_API_KEY           Gemini key
 * Settings (config.json, via `emailmaster config`):
 *   azureDeployment / model  deployment (Azure) or model (Gemini) to use
 *   requestsPerMinute        pacing limit; reasoningEffort (Azure GPT-5 models)
 */
const path = require("path");
const fs = require("fs-extra");
const chalk = require("chalk");
require("dotenv").config({ path: path.join(__dirname, "../../.env") });

const CONFIG_PATH = path.join(__dirname, "../../config.json");
const MAX_RETRIES = 4;
const REQUEST_TIMEOUT_MS = 120000;

const DEFAULTS = {
  azure: { model: "gpt-5.4-mini", requestsPerMinute: 60, reasoningEffort: "low" },
  gemini: { model: "gemini-2.5-flash", requestsPerMinute: 5 },
};

// Azure's JSON mode always returns an object, so arrays come back wrapped.
const JSON_SYSTEM_PROMPT =
  "You are the AI engine of an email management CLI. Reply with valid JSON only, " +
  'no markdown or code fences. When asked for a JSON array, return {"results": [ ...the array... ]} instead.';

const debug = (...args) => {
  if (process.env.DEBUG === "true") console.log(chalk.gray("[ai]"), ...args);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class AIError extends Error {
  /**
   * @param {string} message Readable message
   * @param {Object} [info] { status, fatal, quotaExceeded, retryAfterMs, daily, retryable }
   */
  constructor(message, info = {}) {
    super(message);
    this.name = "AIError";
    Object.assign(this, info);
  }
}

function readConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const raw = fs.readFileSync(CONFIG_PATH, "utf8").trim();
      return raw ? JSON.parse(raw) : {};
    }
  } catch {
    // fall back to defaults on a malformed config.json
  }
  return {};
}

function normalizeAzureEndpoint(endpoint) {
  let url = String(endpoint || "").trim().replace(/\/+$/, "");
  if (url && !/\/openai\/v1$/i.test(url)) url += "/openai/v1";
  return url;
}

/**
 * Describe the active provider
 * @returns {{name, label, model, configured, setupHint, modelConfigKey, requestsPerMinute, reasoningEffort}}
 */
function getProviderInfo() {
  const config = readConfig();
  const requested = (process.env.AI_PROVIDER || "").toLowerCase();
  const name =
    requested === "gemini" || requested === "azure"
      ? requested
      : process.env.AZURE_OPENAI_API_KEY
      ? "azure"
      : "gemini";

  if (name === "azure") {
    const configured = Boolean(process.env.AZURE_OPENAI_API_KEY && process.env.AZURE_OPENAI_ENDPOINT);
    return {
      name,
      label: "Azure OpenAI",
      model: config.azureDeployment || process.env.AZURE_OPENAI_DEPLOYMENT || DEFAULTS.azure.model,
      modelConfigKey: "azureDeployment",
      configured,
      setupHint: "Set AZURE_OPENAI_API_KEY and AZURE_OPENAI_ENDPOINT in .env",
      requestsPerMinute: Number(config.requestsPerMinute) || DEFAULTS.azure.requestsPerMinute,
      reasoningEffort: config.reasoningEffort === undefined ? DEFAULTS.azure.reasoningEffort : config.reasoningEffort,
    };
  }

  return {
    name,
    label: "Google Gemini",
    model: config.model && config.model.startsWith("gemini") ? config.model : DEFAULTS.gemini.model,
    modelConfigKey: "model",
    configured: Boolean(process.env.GEMINI_API_KEY),
    setupHint: "Set GEMINI_API_KEY in .env (or configure Azure OpenAI)",
    requestsPerMinute: Number(config.requestsPerMinute) || DEFAULTS.gemini.requestsPerMinute,
    reasoningEffort: null,
  };
}

// ---------- pacing ----------

const recentStarts = []; // start times of requests in the last 60s
let pausedUntil = 0; // set when the provider tells us to back off
let queue = Promise.resolve();

function acquireSlot(limit) {
  const slot = queue.then(async () => {
    for (;;) {
      const now = Date.now();
      while (recentStarts.length && now - recentStarts[0] >= 60000) recentStarts.shift();
      let waitMs = Math.max(0, pausedUntil - now);
      if (recentStarts.length >= limit) waitMs = Math.max(waitMs, recentStarts[0] + 60000 - now);
      if (waitMs <= 0) break;
      if (waitMs >= 3000) {
        console.log(chalk.gray(`⏳ Waiting ${Math.ceil(waitMs / 1000)}s for the AI rate limit...`));
      }
      await sleep(waitMs + 100);
    }
    recentStarts.push(Date.now());
  });
  queue = slot.catch(() => {});
  return slot;
}

// ---------- Azure OpenAI ----------

const unsupportedParams = new Set(); // params a deployment rejected; skipped afterwards

async function callAzure(prompt, { json }, info) {
  const endpoint = normalizeAzureEndpoint(process.env.AZURE_OPENAI_ENDPOINT);
  const messages = [{ role: "user", content: prompt }];
  if (json) messages.unshift({ role: "system", content: JSON_SYSTEM_PROMPT });

  const body = { model: info.model, messages };
  if (json && !unsupportedParams.has("response_format")) body.response_format = { type: "json_object" };
  if (info.reasoningEffort && !unsupportedParams.has("reasoning_effort")) body.reasoning_effort = info.reasoningEffort;

  let response;
  try {
    response = await fetch(`${endpoint}/chat/completions`, {
      method: "POST",
      headers: { "api-key": process.env.AZURE_OPENAI_API_KEY, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new AIError(`Could not reach Azure OpenAI (${error.cause?.code || error.message})`, { retryable: true });
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const apiMessage = (data.error && data.error.message) || response.statusText;
    const code = data.error && data.error.code;

    // Some deployments don't accept every parameter: drop it and retry.
    for (const param of ["reasoning_effort", "response_format"]) {
      if (response.status === 400 && body[param] !== undefined && apiMessage.includes(param)) {
        unsupportedParams.add(param);
        throw new AIError(`Deployment does not support ${param}`, { retryNow: true });
      }
    }

    const retryAfterMs =
      Number(response.headers.get("retry-after-ms")) ||
      Number(response.headers.get("retry-after")) * 1000 ||
      null;

    if (response.status === 401 || response.status === 403) {
      throw new AIError("Azure OpenAI rejected the API key. Check AZURE_OPENAI_API_KEY in .env.", { status: response.status, fatal: true });
    }
    if (response.status === 404 || code === "DeploymentNotFound") {
      throw new AIError(
        `Azure deployment "${info.model}" was not found. List deployments with: emailmaster config --list-models`,
        { status: 404, fatal: true }
      );
    }
    if (code === "content_filter" || /content management policy/i.test(apiMessage)) {
      throw new AIError("Azure's content filter blocked this request.", { status: response.status });
    }
    throw new AIError(`Azure OpenAI error ${response.status}: ${apiMessage}`, {
      status: response.status,
      retryAfterMs,
      retryable: response.status === 429 || response.status >= 500,
    });
  }

  const choice = data.choices && data.choices[0];
  const content = choice && choice.message && choice.message.content;
  if (!content) {
    const reason = choice && choice.finish_reason;
    throw new AIError(
      reason === "content_filter" ? "Azure's content filter blocked the response." : `Azure OpenAI returned an empty reply (${reason || "no choices"}).`
    );
  }
  debug(`azure ${info.model}`, JSON.stringify(data.usage || {}));
  return content;
}

// ---------- Google Gemini ----------

async function callGemini(prompt, { json }, info) {
  const { GoogleGenerativeAI } = require("@google/generative-ai");
  const model = new GoogleGenerativeAI(process.env.GEMINI_API_KEY).getGenerativeModel({
    model: info.model,
    ...(json ? { generationConfig: { responseMimeType: "application/json" } } : {}),
  });

  try {
    const result = await model.generateContent(prompt);
    return result.response.text();
  } catch (error) {
    const status = error.status;
    const details = Array.isArray(error.errorDetails) ? error.errorDetails : [];
    const failure = details.find((d) => String(d["@type"]).includes("QuotaFailure"));
    const retry = details.find((d) => String(d["@type"]).includes("RetryInfo"));
    const quotaIds = failure && Array.isArray(failure.violations) ? failure.violations.map((v) => v.quotaId || "").join(" ") : "";
    const retryAfterMs = retry && retry.retryDelay ? parseFloat(retry.retryDelay) * 1000 : null;

    if (status === 429 && /PerDay/i.test(quotaIds)) {
      throw new AIError(
        `Gemini's daily free-tier quota for ${info.model} is used up. Try again tomorrow, or configure Azure OpenAI in .env.`,
        { status, fatal: true, quotaExceeded: true }
      );
    }
    if (status === 400 && /API key/i.test(error.message)) {
      throw new AIError("Gemini rejected the API key. Check GEMINI_API_KEY in .env.", { status, fatal: true });
    }
    if (status === 404) {
      throw new AIError(`Gemini model "${info.model}" was not found. List models with: emailmaster config --list-models`, { status, fatal: true });
    }
    throw new AIError(`Gemini error ${status || ""}: ${String(error.message).split("\n")[0]}`.trim(), {
      status,
      retryAfterMs,
      retryable: !status || status === 429 || status >= 500,
    });
  }
}

// ---------- public API ----------

/**
 * Send a prompt to the active provider
 * @param {string} prompt
 * @param {{json?: boolean}} [options] json: ask for a JSON-only reply
 * @returns {Promise<string>} The model's reply text
 */
async function generate(prompt, { json = false } = {}) {
  const info = getProviderInfo();
  if (!info.configured) {
    throw new AIError(`${info.label} is not configured. ${info.setupHint}.`, { fatal: true });
  }
  const call = info.name === "azure" ? callAzure : callGemini;

  for (let attempt = 1; ; attempt++) {
    await acquireSlot(info.requestsPerMinute);
    try {
      return await call(prompt, { json }, info);
    } catch (error) {
      if (!(error instanceof AIError)) throw error;
      if (error.retryNow && attempt <= MAX_RETRIES) continue;
      if (error.retryable && attempt <= MAX_RETRIES) {
        const waitMs = error.retryAfterMs || (error.status === 429 ? 20000 : 2000 * attempt);
        pausedUntil = Math.max(pausedUntil, Date.now() + waitMs);
        debug(`retrying after ${error.message}`);
        continue;
      }
      if (error.status === 429) {
        error.message = `${info.label} kept rate-limiting requests (tried ${attempt} times). Wait a minute and try again.`;
        error.quotaExceeded = true;
        error.fatal = true;
      }
      throw error;
    }
  }
}

/**
 * List deployments (Azure) or models (Gemini) available to the configured key
 * @returns {Promise<string[]>}
 */
async function listModels() {
  const info = getProviderInfo();
  if (!info.configured) throw new AIError(`${info.label} is not configured. ${info.setupHint}.`);

  if (info.name === "azure") {
    const resource = normalizeAzureEndpoint(process.env.AZURE_OPENAI_ENDPOINT).replace(/\/openai\/v1$/i, "");
    const response = await fetch(`${resource}/openai/deployments?api-version=2022-12-01`, {
      headers: { "api-key": process.env.AZURE_OPENAI_API_KEY },
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw new AIError(`Could not list Azure deployments (HTTP ${response.status})`);
    const data = await response.json();
    return (data.data || [])
      .filter((d) => !/embedding|whisper|tts|dall-e|image/i.test(d.model || d.id))
      .map((d) => d.id);
  }

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=${process.env.GEMINI_API_KEY}`,
    { signal: AbortSignal.timeout(30000) }
  );
  if (!response.ok) throw new AIError(`Could not list Gemini models (HTTP ${response.status})`);
  const data = await response.json();
  return (data.models || [])
    .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"))
    .map((m) => m.name.replace("models/", ""))
    .filter((n) => /^gemini/.test(n) && !/tts|image|audio|live/.test(n));
}

module.exports = { generate, getProviderInfo, listModels, AIError };
