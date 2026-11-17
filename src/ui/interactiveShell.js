/**
 * Interactive Shell
 * A Claude Code-style prompt for EmailMaster:
 *   - type "/" to open a live, filterable command menu (↑↓ select, Tab complete, Enter run)
 *   - type a plain question (no "/") to search your emails with AI
 *   - ↑↓ on an empty menu walks command history; Ctrl+C twice or /exit leaves
 *
 * Each command runs in its own child process (the same index.js), so a command
 * that calls process.exit() or crashes never takes the shell down with it.
 */
const readline = require("readline");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs-extra");
const chalk = require("chalk");
const boxen = require("boxen");

const MAX_VISIBLE = 8;
const HISTORY_SIZE = 200;
const EXIT_CONFIRM_MS = 2000;

const accent = chalk.hex("#c084fc");
const PROMPT = accent("❯ ");

// Order and grouping of commands in the "/" menu and in /help.
const GROUPS = [
  ["Email", ["fetch", "list", "view", "search", "summary", "analyze", "dashboard", "reply", "export", "calendar-export", "sweep", "unsubscribe"]],
  ["Attachments", ["attachments", "attachments-fetch", "attachments-sync", "attachments-stats"]],
  ["Accounts & settings", ["accounts", "account-add", "account-switch", "account-remove", "config"]],
  ["Shell", ["help", "clear", "exit"]],
];

const BUILTINS = [
  { name: "help", args: "[command]", requiresArgs: false, description: "List commands, or show detailed help for one", builtin: true },
  { name: "clear", args: "", requiresArgs: false, description: "Clear the screen", builtin: true },
  { name: "exit", args: "", requiresArgs: false, description: "Leave EmailMaster (or press Ctrl+C twice)", builtin: true },
];

const stripAnsi = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, "");

function truncate(text, width) {
  if (width <= 0) return "";
  return text.length > width ? text.slice(0, Math.max(0, width - 1)) + "…" : text;
}

// Keep the end of long paths, where the folder name is
function truncateStart(text, width) {
  if (width <= 0) return "";
  return text.length > width ? "…" + text.slice(text.length - width + 1) : text;
}

/**
 * Build the command list from the commander program plus shell built-ins
 */
function buildCommands(program) {
  const fromProgram = program.commands
    .filter((c) => c.name() !== "help")
    .map((c) => {
      const argDefs = c.registeredArguments || c._args || [];
      return {
        name: c.name(),
        args: argDefs.map((a) => (a.required ? `<${a.name()}>` : `[${a.name()}]`)).join(" "),
        requiresArgs: argDefs.some((a) => a.required),
        description: c.description() || "",
        builtin: false,
      };
    });

  const order = GROUPS.flatMap(([, names]) => names);
  const rank = (name) => (order.includes(name) ? order.indexOf(name) : order.length);
  return [...fromProgram, ...BUILTINS].sort((a, b) => rank(a.name) - rank(b.name));
}

/**
 * Commands whose name starts with the query first, then ones that contain it
 */
function matchCommands(commands, query) {
  const q = query.toLowerCase();
  if (!q) return commands;
  const starts = commands.filter((c) => c.name.startsWith(q));
  const contains = commands.filter((c) => !c.name.startsWith(q) && c.name.includes(q));
  return [...starts, ...contains];
}

/**
 * Split an argument string like a shell would. Quotes only group when they
 * start a word, so apostrophes inside words ("what's") stay literal.
 */
function tokenize(str) {
  const tokens = [];
  let current = "";
  let quote = null;
  let started = false;
  for (const ch of str) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
    } else if ((ch === '"' || ch === "'") && !started) {
      quote = ch;
      started = true;
    } else if (/\s/.test(ch)) {
      if (started) tokens.push(current);
      current = "";
      started = false;
    } else {
      current += ch;
      started = true;
    }
  }
  if (started) tokens.push(current);
  return tokens;
}

function loadHistory(file) {
  try {
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
    const recent = lines.slice(-HISTORY_SIZE);
    if (lines.length > HISTORY_SIZE * 2) fs.writeFileSync(file, recent.join("\n") + "\n");
    return recent.reverse(); // readline wants newest first
  } catch {
    return [];
  }
}

function appendHistory(file, entry) {
  try {
    fs.ensureDirSync(path.dirname(file));
    fs.appendFileSync(file, entry.replace(/\r?\n/g, " ") + "\n");
  } catch {
    // history is a convenience; never fail a command over it
  }
}

function readJsonSafe(file) {
  try {
    return fs.readJsonSync(file);
  } catch {
    return null;
  }
}

/**
 * Start the interactive shell
 * @param {import("commander").Command} program The configured commander program
 * @param {Object} options
 * @param {string} options.entryFile Path to index.js (run for each command)
 * @param {string} options.appDir App folder (holds accounts.json, config.json, temp/)
 * @param {string} options.userCwd Folder the user started the shell from
 */
function startShell(program, options) {
  const {
    entryFile,
    appDir,
    userCwd,
    input = process.stdin,
    output = process.stdout,
    onExit = (code) => process.exit(code),
  } = options;

  const commands = buildCommands(program);
  const byName = new Map(commands.map((c) => [c.name, c]));
  const historyFile = path.join(appDir, "temp", ".shell_history");
  const promptWidth = stripAnsi(PROMPT).length;
  const columns = () => output.columns || 80;
  const write = (text = "") => output.write(text);

  const state = {
    matches: [],
    selected: 0,
    dismissedLine: null,
    busy: false,
    closed: false,
    lastSigint: 0,
  };

  // ---------- header & help ----------

  function printHeader() {
    const accounts = readJsonSafe(path.join(appDir, "accounts.json"));
    const current =
      accounts && Array.isArray(accounts.accounts)
        ? accounts.accounts.find((a) => a.name === accounts.currentAccount)
        : null;
    const ai = require("../ai/aiProvider").getProviderInfo();
    const width = Math.max(20, columns() - 20);

    const lines = [
      `${accent("✉")}  ${chalk.bold("Welcome to EmailMaster")}`,
      "",
      chalk.gray("  /help for commands · / to browse · or just ask a question"),
      "",
      `  ${chalk.gray("account")}  ${current ? chalk.white(current.email) : chalk.yellow("none yet — run /account-add")}`,
      `  ${chalk.gray("AI")}       ${
        ai.configured ? chalk.white(`${ai.model} · ${ai.label}`) : chalk.yellow(`not configured — ${ai.setupHint}`)
      }`,
      `  ${chalk.gray("folder")}   ${chalk.white(truncateStart(userCwd, width))}`,
    ];
    write(
      boxen(lines.join("\n"), {
        padding: { top: 0, bottom: 0, left: 1, right: 2 },
        borderStyle: "round",
        borderColor: "#c084fc",
      }) + "\n\n"
    );
  }

  function commandLabel(c) {
    return `/${c.name}${c.args ? " " + c.args : ""}`;
  }

  function printHelp() {
    const cols = columns();
    const labelWidth = Math.min(Math.max(...commands.map((c) => commandLabel(c).length)) + 2, Math.floor(cols / 2));
    const listed = new Set();
    const groups = GROUPS.map(([title, names]) => [title, names.map((n) => byName.get(n)).filter(Boolean)]);
    const others = commands.filter((c) => !GROUPS.some(([, names]) => names.includes(c.name)));
    if (others.length) groups.splice(groups.length - 1, 0, ["Other", others]);

    write("\n");
    for (const [title, cmds] of groups) {
      if (!cmds.length) continue;
      write(chalk.bold(title) + "\n");
      for (const c of cmds) {
        listed.add(c.name);
        const label = truncate(commandLabel(c), labelWidth - 1).padEnd(labelWidth);
        write(`  ${accent(label)}${chalk.gray(truncate(c.description, cols - labelWidth - 4))}\n`);
      }
      write("\n");
    }
    write(chalk.gray("Type a question without \"/\" to search your emails with AI.\n"));
    write(chalk.gray("Add --help to any command for its options, e.g. /fetch --help\n"));
  }

  // ---------- "/" menu rendering ----------

  function computeMatches() {
    const line = rl.line || "";
    if (!line.startsWith("/") || /\s/.test(line) || line === state.dismissedLine) return [];
    return matchCommands(commands, line.slice(1));
  }

  function menuRows(matches) {
    const cols = columns();
    const total = matches.length;
    const visible = Math.min(MAX_VISIBLE, total);
    const start = Math.max(0, Math.min(state.selected - Math.floor(visible / 2), total - visible));
    const shown = matches.slice(start, start + visible);
    const labels = shown.map(commandLabel);
    const labelWidth = Math.min(Math.max(...labels.map((l) => l.length)) + 2, Math.floor(cols / 2));

    const rows = shown.map((c, i) => {
      const selected = start + i === state.selected;
      const label = truncate(labels[i], labelWidth - 1).padEnd(labelWidth);
      const desc = truncate(c.description, cols - labelWidth - 5);
      return selected
        ? accent("› ") + accent.bold(label) + chalk.white(desc)
        : "  " + chalk.white(label) + chalk.gray(desc);
    });
    const position = total > visible ? `${state.selected + 1}/${total} · ` : "";
    rows.push(chalk.gray(truncate(`  ${position}↑↓ select · Tab complete · Enter run · Esc close`, cols - 3)));
    return rows;
  }

  // Redraw the menu below the input line (or clear it). Stateless: it always
  // clears everything under the input first, so it can't leave stale rows.
  function render() {
    if (state.busy || state.closed) return;
    const line = rl.line || "";
    if (promptWidth + line.length >= columns()) {
      state.matches = []; // input wrapped onto a second row; skip the menu
      return;
    }
    state.matches = computeMatches();
    if (state.selected >= state.matches.length) state.selected = 0;

    readline.cursorTo(output, promptWidth + line.length);
    readline.clearScreenDown(output);
    if (state.matches.length) {
      const rows = menuRows(state.matches);
      write("\n" + rows.join("\n"));
      readline.moveCursor(output, 0, -rows.length);
    }
    readline.cursorTo(output, promptWidth + rl.cursor);
  }

  function clearMenu() {
    const line = rl.line || "";
    if (state.matches.length && promptWidth + line.length < columns()) {
      readline.cursorTo(output, promptWidth + line.length);
      readline.clearScreenDown(output);
      readline.cursorTo(output, promptWidth + rl.cursor);
    }
    state.matches = [];
  }

  function setLine(text) {
    rl.line = text;
    rl.cursor = text.length;
    if (typeof rl._refreshLine === "function") rl._refreshLine();
    render();
  }

  // ---------- running commands ----------

  function runCommand(argv) {
    return new Promise((resolve) => {
      const tty = input.isTTY && typeof input.setRawMode === "function";
      const ignoreSigint = () => {}; // Ctrl+C stops the command, not the shell
      let finished = false;

      const finish = () => {
        if (finished) return;
        finished = true;
        process.removeListener("SIGINT", ignoreSigint);
        if (tty) input.setRawMode(true);
        state.busy = false;
        rl.resume();
        resolve();
      };

      state.busy = true;
      rl.pause();
      if (tty) input.setRawMode(false);
      process.on("SIGINT", ignoreSigint);

      try {
        const child = spawn(process.execPath, [entryFile, ...argv], {
          cwd: userCwd,
          stdio: "inherit",
          env: process.env,
        });
        child.on("error", (error) => {
          write(chalk.red(`Could not run command: ${error.message}`) + "\n");
          finish();
        });
        child.on("exit", finish);
      } catch (error) {
        write(chalk.red(`Could not run command: ${error.message}`) + "\n");
        finish();
      }
    });
  }

  async function handle(text) {
    let name;
    let args = [];

    if (text.startsWith("/")) {
      const body = text.slice(1);
      const space = body.search(/\s/);
      name = (space === -1 ? body : body.slice(0, space)).toLowerCase();
      const rest = space === -1 ? "" : body.slice(space + 1).trim();
      // search takes free text: keep it as one argument, apostrophes and all
      args = name === "search" ? (rest ? [rest] : []) : tokenize(rest);
    } else {
      const word = text.toLowerCase();
      if (byName.has(word) || word === "quit") {
        name = word; // a bare command name like "fetch" or "exit"
      } else {
        write(chalk.gray(`Searching your emails for: ${text}`) + "\n");
        return runCommand(["search", text]);
      }
    }

    if (name === "quit" || name === "q") name = "exit";

    if (name === "exit") return close();
    if (name === "clear") {
      write("\x1b[2J\x1b[3J\x1b[H");
      printHeader();
      return;
    }
    if (name === "help") {
      if (args[0]) return runCommand(["help", args[0].replace(/^\//, "")]);
      printHelp();
      return;
    }

    const command = byName.get(name);
    if (!command) {
      const similar = matchCommands(commands, name).slice(0, 3);
      write(chalk.yellow(`Unknown command /${name}.`));
      write(
        similar.length
          ? chalk.gray(` Did you mean ${similar.map((c) => accent("/" + c.name)).join(", ")}?`) + "\n"
          : chalk.gray(" Type / to see all commands.") + "\n"
      );
      return;
    }
    if (command.requiresArgs && args.length === 0) {
      write(chalk.yellow(`/${name} needs ${command.args}`) + chalk.gray(` — e.g. ${commandLabel(command)}`) + "\n");
      return;
    }
    return runCommand([name, ...args]);
  }

  // ---------- readline setup ----------

  printHeader();

  const rl = readline.createInterface({
    input,
    output,
    terminal: true,
    prompt: PROMPT,
    history: loadHistory(historyFile),
    historySize: HISTORY_SIZE,
    removeHistoryDuplicates: true,
  });

  function close() {
    if (state.closed) return;
    state.closed = true;
    rl.close();
  }

  // Intercept keys while the "/" menu is open; everything else goes to readline.
  const originalTtyWrite = rl._ttyWrite;
  if (typeof originalTtyWrite === "function") {
    rl._ttyWrite = function (s, key = {}) {
      if (state.busy) return originalTtyWrite.call(this, s, key);

      const name = key.name;
      const plainKey = !key.ctrl && !key.meta;
      const isEnter = name === "return" || name === "enter";

      if (state.matches.length && plainKey) {
        if (name === "up" || name === "down") {
          const n = state.matches.length;
          state.selected = (state.selected + (name === "up" ? -1 : 1) + n) % n;
          render();
          return;
        }
        if (name === "tab") {
          setLine(`/${state.matches[state.selected].name} `);
          return;
        }
        if (name === "escape") {
          state.dismissedLine = rl.line;
          clearMenu();
          return;
        }
        if (isEnter) {
          const chosen = state.matches[state.selected];
          if (chosen.requiresArgs) {
            setLine(`/${chosen.name} `); // needs arguments first; let the user type them
            return;
          }
          setLine(`/${chosen.name}`); // show the full command before running it
        }
      }

      if (name === "tab") return; // nothing to complete; don't insert a tab
      if (isEnter) {
        clearMenu();
        return originalTtyWrite.call(this, s, key);
      }

      const before = rl.line;
      originalTtyWrite.call(this, s, key);
      if (rl.line !== before) state.selected = 0;
      render();
    };
  }

  rl.on("line", (raw) => {
    readline.clearScreenDown(output); // remove any menu remnants under the submitted line
    state.matches = [];
    state.selected = 0;
    state.dismissedLine = null;

    const text = raw.trim();
    if (!text) {
      rl.prompt();
      return;
    }
    appendHistory(historyFile, text);

    Promise.resolve(handle(text))
      .catch((error) => write(chalk.red(`Error: ${error.message}`) + "\n"))
      .finally(() => {
        if (state.closed) return;
        write("\n");
        rl.prompt();
      });
  });

  rl.on("SIGINT", () => {
    if (rl.line) {
      clearMenu();
      setLine("");
      state.lastSigint = 0;
      return;
    }
    const now = Date.now();
    if (now - state.lastSigint < EXIT_CONFIRM_MS) {
      close();
      return;
    }
    state.lastSigint = now;
    clearMenu();
    write("\n" + chalk.gray("Press Ctrl+C again to exit") + "\n");
    rl.prompt();
  });

  rl.on("close", () => {
    state.closed = true;
    write("\n" + chalk.gray("Goodbye!") + "\n");
    onExit(0);
  });

  if (typeof output.on === "function") output.on("resize", () => render());

  rl.prompt();
  return rl;
}

module.exports = { startShell, tokenize, matchCommands, buildCommands };
