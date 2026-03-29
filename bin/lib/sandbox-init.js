// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// `nemoclaw sandbox-init` — idempotent workspace bootstrapper.
//
// Sets up an existing sandbox with:
//   • Workspace identity files  (IDENTITY.md, SOUL.md, AGENTS.md, USER.md)
//   • Network policy presets    (github by default; pass --policy <name> to add more)
//   • Git credentials           (GITHUB_TOKEN stored as a sandbox env hint)
//   • A named openclaw agent    entry in openclaw.json
//
// All steps are idempotent: safe to re-run on an already-configured sandbox.
//
// Usage:
//   nemoclaw sandbox-init <sandbox-name> [options]
//
// Options:
//   --agent-name <name>       Display name for the agent   (default: sandbox name)
//   --agent-id   <id>         Agent identifier             (default: sandbox name)
//   --soul       <file>       Path to a SOUL.md file to upload
//   --identity   <file>       Path to an IDENTITY.md file to upload
//   --agents     <file>       Path to an AGENTS.md file to upload
//   --user       <file>       Path to a USER.md file to upload
//   --policy     <preset>     Extra policy preset to apply (repeatable)
//   --no-github               Skip GitHub policy + credential setup
//   --parent-agent <id>       Register this sandbox as a subagent of another agent
//   --non-interactive         Never prompt; fail if required info is missing

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const runner = require("./runner");
const credentials = require("./credentials");
const registry = require("./registry");
const policies = require("./policies");

// ── Workspace file templates ─────────────────────────────────────

function defaultIdentityMd(agentName) {
  return `# Identity

name: ${agentName}
emoji: 🤖
role: AI Agent
`;
}

function defaultSoulMd(agentName) {
  return `# Soul

You are ${agentName}, a capable and collaborative AI agent.

## Core Values
- Be accurate, helpful, and concise.
- Tell the user when you are uncertain rather than guessing.
- Prefer reversible actions over destructive ones; confirm before deleting.

## Tone
Professional, direct, and friendly. Adapt detail level to the complexity of the request.

## Safety
Never expose credentials, tokens, or secret values in responses.
Always sanitize file paths before using them in shell commands.
`;
}

function defaultAgentsMd(agentName) {
  return `# Agents

You are ${agentName}.

## Shared Workspace
All agents share a single writable workspace. Use these canonical paths:

- **Workspace root**: \`/sandbox/.openclaw/workspace/\`  (shared; readable and writable by all agents)
- **Git repositories**: \`/sandbox/.openclaw/workspace/git/\`  ← clone ALL repos here
- **Notes / memory**: \`/sandbox/.openclaw/workspace/MEMORY.md\`

### Rules for working with code
- Always clone into \`/sandbox/.openclaw/workspace/git/<repo-name>/\`
  Example: \`git clone https://github.com/org/repo /sandbox/.openclaw/workspace/git/repo\`
- Never clone into \`/sandbox\` directly or any path outside the workspace.
- All file edits, builds, and scripts must run from inside the repo directory under \`git/\`.
- Do NOT invent sub-paths like \`workspace-main\` or \`workspace-cortana\`. There is only one workspace
  directory. Writing to any other path under \`/sandbox/.openclaw/\` will fail (read-only mount).

## Coordination Rules
- Work on one feature branch at a time.
- Commit with conventional commit messages: <type>(<scope>): <summary>
- Do not push to main without explicit user confirmation.
- Leave a note in \`/sandbox/.openclaw/workspace/MEMORY.md\` if you are interrupted mid-task.
- When handing off to another agent, write a summary of current state to the workspace before exiting.
`;
}

function defaultUserMd() {
  return `# User

## Preferences
- Prefer concise answers unless detail is requested.
- Use English unless another language is requested.
`;
}

// ── Helpers ──────────────────────────────────────────────────────

/**
 * Write content to a file inside the sandbox workspace via openshell sandbox exec.
 * The file path is inside /sandbox/.openclaw/workspace/.
 */
function writeWorkspaceFile(sandboxName, filename, content) {
  // Write to a temp file then upload via openshell sandbox upload
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-init-"));
  const tmpFile = path.join(tmpDir, filename);
  try {
    fs.writeFileSync(tmpFile, content, { encoding: "utf-8", mode: 0o644 });
    const destDir = "/sandbox/.openclaw/workspace";
    runner.run(
      `openshell sandbox upload ${runner.shellQuote(sandboxName)} ${runner.shellQuote(tmpFile)} ${runner.shellQuote(destDir + "/")}`,
    );
  } finally {
    try { fs.unlinkSync(tmpFile); } catch { /* best effort */ }
    try { fs.rmdirSync(tmpDir); } catch { /* best effort */ }
  }
}

/**
 * Read content from a user-supplied file path or return the default.
 */
function resolveFileContent(filePath, defaultContent) {
  if (!filePath) return defaultContent;
  if (!fs.existsSync(filePath)) {
    console.error(`  ✗ File not found: ${filePath}`);
    process.exit(1);
  }
  return fs.readFileSync(filePath, "utf-8");
}

/**
 * Patch ~/.openclaw/openclaw.json to add or update an agent entry.
 * If --parent-agent is given, appends this agent ID to the parent's
 * subagents.allowAgents list.
 */
function patchOpenClawConfig(agentId, agentName, parentAgentId, model) {
  const configPath = path.join(os.homedir(), ".openclaw", "openclaw.json");
  let config = {};
  try {
    if (fs.existsSync(configPath)) {
      config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    }
  } catch { /* start fresh */ }

  if (!config.agents) config.agents = { defaults: {}, list: [] };
  if (!config.agents.defaults) config.agents.defaults = {};
  if (!Array.isArray(config.agents.list)) config.agents.list = [];

  // Ensure defaults.workspace points to the writable data dir so the
  // gateway never tries to mkdir under the read-only state dir.
  if (!config.agents.defaults.workspace) {
    config.agents.defaults.workspace = "/sandbox/.openclaw-data/workspace";
  }

  // Upsert agent entry
  const existingIdx = config.agents.list.findIndex((a) => a.id === agentId);
  const entry = existingIdx >= 0
    ? config.agents.list[existingIdx]
    : { id: agentId };
  entry.name = agentName;
  entry.workspace = "/sandbox/.openclaw-data/workspace";
  if (model) entry.model = { primary: model };
  if (existingIdx >= 0) {
    config.agents.list[existingIdx] = entry;
  } else {
    config.agents.list.push(entry);
  }

  // Wire as subagent of parent if requested
  if (parentAgentId) {
    const parent = config.agents.list.find((a) => a.id === parentAgentId);
    if (!parent) {
      console.warn(`  ⚠ Parent agent '${parentAgentId}' not found in openclaw.json — skipping subagent wiring.`);
    } else {
      if (!parent.subagents) parent.subagents = { allowAgents: [] };
      if (!Array.isArray(parent.subagents.allowAgents)) parent.subagents.allowAgents = [];
      if (!parent.subagents.allowAgents.includes(agentId)) {
        parent.subagents.allowAgents.push(agentId);
      }
    }
  }

  const dir = path.dirname(configPath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
}

// ── Main ─────────────────────────────────────────────────────────

async function sandboxInit(sandboxName, opts = {}) {
  const {
    agentName = sandboxName,
    agentId = sandboxName,
    soulFile = null,
    identityFile = null,
    agentsFile = null,
    userFile = null,
    extraPolicies = [],
    skipGithub = false,
    parentAgentId = null,
    nonInteractive = false,
    enableDocker = false,
    model = null,
  } = opts;

  // Expand docker flag into the two required policy presets
  const allPolicies = enableDocker
    ? [...extraPolicies, "docker", "docker-proxy"]
    : [...extraPolicies];

  // ── Validate sandbox exists in registry ─────────────────────

  const sb = registry.getSandbox(sandboxName);
  if (!sb) {
    console.error(`  ✗ Sandbox '${sandboxName}' is not registered.`);
    console.error(`    Run 'nemoclaw list' to see available sandboxes.`);
    process.exit(1);
  }

  console.log("");
  console.log(`  ${"\x1b[1m"}Initialising sandbox: ${sandboxName}${"\x1b[0m"}`);
  console.log("  ─────────────────────────────────────────────────────");

  // ── Step 1: Write workspace identity files ───────────────────

  console.log("");
  console.log("  [1/4] Writing workspace files");

  const workspaceFiles = [
    {
      name: "IDENTITY.md",
      content: resolveFileContent(identityFile, defaultIdentityMd(agentName)),
    },
    {
      name: "SOUL.md",
      content: resolveFileContent(soulFile, defaultSoulMd(agentName)),
    },
    {
      name: "AGENTS.md",
      content: resolveFileContent(agentsFile, defaultAgentsMd(agentName)),
    },
    {
      name: "USER.md",
      content: resolveFileContent(userFile, defaultUserMd()),
    },
  ];

  for (const { name, content } of workspaceFiles) {
    process.stdout.write(`    • ${name} … `);
    try {
      writeWorkspaceFile(sandboxName, name, content);
      console.log("\x1b[32m✓\x1b[0m");
    } catch (err) {
      console.log("\x1b[31m✗\x1b[0m");
      console.error(`      Error: ${err.message}`);
      process.exit(1);
    }
  }

  // ── Step 2: Apply network policies ──────────────────────────

  console.log("");
  console.log("  [2/4] Applying policies");

  const policiestoApply = skipGithub
    ? [...allPolicies]
    : ["github", ...allPolicies];

  if (policiestoApply.length === 0) {
    console.log("    • No policies to apply (--no-github and no --policy flags)");
  } else {
    for (const preset of [...new Set(policiestoApply)]) {
      process.stdout.write(`    • ${preset} … `);
      try {
        policies.applyPreset(sandboxName, preset);
        console.log("\x1b[32m✓\x1b[0m");
      } catch (err) {
        console.log("\x1b[33m⚠\x1b[0m (skipped)");
        console.warn(`      ${err.message}`);
      }
    }
  }

  // ── npm prefix ───────────────────────────────────────────────
  // /usr is read-only inside the sandbox, so npm global installs must go to
  // a writable location. Upload a .npmrc that redirects the global prefix.
  // IMPORTANT: source file must be named ".npmrc" so openshell upload
  // preserves the filename when copying into '/sandbox/'.
  {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-npm-"));
    // File must be named .npmrc — openshell upload uses the source filename
    const npmrcFile = path.join(tmpDir, ".npmrc");
    try {
      fs.writeFileSync(npmrcFile, "prefix=/sandbox/.npm-global\n", { mode: 0o644 });
      runner.run(
        `openshell sandbox upload ${runner.shellQuote(sandboxName)} ${runner.shellQuote(npmrcFile)} '/sandbox/'`,
        { ignoreError: true },
      );
    } catch { /* best effort — sandbox may be restarted later */ }
    finally {
      try { fs.unlinkSync(npmrcFile); } catch { /* best effort */ }
      try { fs.rmdirSync(tmpDir); } catch { /* best effort */ }
    }
  }

  // ── Step 3: GitHub credentials ───────────────────────────────

  if (!skipGithub) {
    console.log("");
    console.log("  [3/4] GitHub credentials");

    let ghToken = credentials.getCredential("GITHUB_TOKEN");

    if (!ghToken) {
      // Try gh CLI
      try {
        ghToken = runner.runCapture("gh auth token 2>/dev/null", { ignoreError: true });
      } catch { /* not available */ }
    }

    if (!ghToken && !nonInteractive) {
      console.log("    No GITHUB_TOKEN found.");
      ghToken = await credentials.prompt("    GitHub personal access token (leave blank to skip): ", { secret: true });
      if (ghToken && ghToken.trim()) {
        credentials.saveCredential("GITHUB_TOKEN", ghToken.trim());
        ghToken = ghToken.trim();
      } else {
        ghToken = null;
      }
    }

    if (ghToken) {
      // Upload .git-credentials directly via openshell sandbox upload so the
      // token is never echoed to the terminal. Then run the non-sensitive
      // `git config` line via connect (no secrets in that script).
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gh-"));
      const credFile = path.join(tmpDir, ".git-credentials");
      const gitconfigFile = path.join(tmpDir, ".gitconfig");
      try {
        // Upload .git-credentials — never echoed to terminal
        fs.writeFileSync(credFile, `https://x-token:${ghToken}@github.com\n`, { mode: 0o600 });
        runner.run(
          `openshell sandbox upload ${runner.shellQuote(sandboxName)} ${runner.shellQuote(credFile)} '/sandbox/'`,
        );

        // Upload .gitconfig with credential.helper=store set.
        // Avoids using `openshell sandbox connect` (PTY sessions don't reliably
        // exit on stdin EOF). Sandbox containers are initialised fresh so
        // overwriting ~/.gitconfig is safe here.
        fs.writeFileSync(gitconfigFile, "[credential]\n\thelper = store\n", { mode: 0o644 });
        runner.run(
          `openshell sandbox upload ${runner.shellQuote(sandboxName)} ${runner.shellQuote(gitconfigFile)} '/sandbox/'`,
        );

        console.log("    \x1b[32m✓\x1b[0m GitHub credentials configured in sandbox");
      } catch {
        console.warn("    \x1b[33m⚠\x1b[0m Could not configure git credentials in sandbox (sandbox may not be running)");
      } finally {
        try { fs.unlinkSync(credFile); } catch { /* best effort */ }
        try { fs.unlinkSync(gitconfigFile); } catch { /* best effort */ }
        try { fs.rmdirSync(tmpDir); } catch { /* best effort */ }
      }
    } else {
      console.log("    • Skipped (no token available)");
    }
  } else {
    console.log("");
    console.log("  [3/4] GitHub credentials — skipped (--no-github)");
  }

  // ── Step 4: Register agent in openclaw.json ──────────────────

  console.log("");
  console.log("  [4/4] Registering agent");

  process.stdout.write(`    • openclaw.json (id: ${agentId}) … `);
  try {
    patchOpenClawConfig(agentId, agentName, parentAgentId, model);
    console.log("\x1b[32m✓\x1b[0m");
    if (parentAgentId) {
      console.log(`    • Wired as subagent of '${parentAgentId}' \x1b[32m✓\x1b[0m`);
    }
  } catch (err) {
    console.log("\x1b[31m✗\x1b[0m");
    console.error(`      Error: ${err.message}`);
  }

  // ── Summary ──────────────────────────────────────────────────

  console.log("");
  console.log("  ─────────────────────────────────────────────────────");
  console.log(`  \x1b[32m✓\x1b[0m Sandbox '${sandboxName}' initialised as agent '${agentName}'`);
  if (parentAgentId) {
    console.log(`    Registered as subagent of '${parentAgentId}'`);
  }
  console.log("");
  console.log(`  Next steps:`);
  console.log(`    nemoclaw ${sandboxName} connect    — open a shell`);
  console.log(`    nemoclaw ${sandboxName} status     — check health`);
  console.log("");
}

module.exports = { sandboxInit };
