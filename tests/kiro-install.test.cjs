'use strict';

/**
 * kiro-install.test.cjs — Kiro (kiro.dev) runtime support.
 *
 * Kiro's IDE and CLI share one tree: `.kiro/` locally, `~/.kiro/` globally (`KIRO_HOME`).
 *   - skills: `<root>/skills/<name>/SKILL.md`, `name` must match the folder
 *   - agents: `<root>/agents/*.md`, `tools` takes Kiro tool tags
 * Sources are cited in the `## kiro` section of the host-integration capability matrix.
 *
 * The installed SKILL.md / agent files are the deployed contract Kiro reads, so install
 * rows spawn the REAL installer and assert on what reached disk; converter rows call the
 * exported converters directly.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runNode } = require('./helpers/process-seam.cjs');

const { cleanup } = require('./helpers.cjs');
const { installerEnv } = require('./helpers/install-shared.cjs');
const { INSTALL_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const {
  convertClaudeCommandToKiroSkill,
  convertClaudeAgentToKiroAgent,
} = require('../gsd-core/bin/lib/runtime-artifact-conversion.cjs');

const REPO_ROOT = path.join(__dirname, '..');

function frontmatterOf(content) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(content);
  return match ? match[1] : null;
}

function fieldOf(frontmatter, key) {
  const match = new RegExp(`^${key}:[ \\t]*(.*)$`, 'm').exec(frontmatter);
  return match ? match[1].trim() : null;
}

function toolsOf(content) {
  const raw = fieldOf(frontmatterOf(content), 'tools');
  return raw === null ? null : JSON.parse(raw);
}

function runInstaller(cwd, args, env = {}) {
  return runNode(
    ['--preserve-symlinks', '--preserve-symlinks-main', path.join(REPO_ROOT, 'bin', 'install.js'), ...args],
    { cwd, env: installerEnv({ HOME: cwd, USERPROFILE: cwd, ...env }), timeoutMs: INSTALL_TIMEOUT_MS },
  );
}

function assertExit0(result, label) {
  assert.strictEqual(result.exitCode, 0, `${label} must succeed\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
}

describe('Kiro converters', () => {
  test('agent tool grants become Kiro tool tags, deduplicated in source order', () => {
    const source = '---\nname: gsd-x\ndescription: Does x.\ntools: Read, Write, Edit, Bash, Glob, Grep, WebSearch, WebFetch, mcp__context7__*, mcp__exa__*\ncolor: green\n---\n\nbody\n';
    const out = convertClaudeAgentToKiroAgent(source);
    assert.deepStrictEqual(toolsOf(out), ['read', 'write', 'shell', 'web', '@mcp']);
    assert.strictEqual(fieldOf(frontmatterOf(out), 'color'), null, 'Claude-only keys are dropped');
    assert.ok(out.endsWith('\n\nbody\n'), 'body survives');
  });

  test('a YAML block tools list maps the same as an inline one', () => {
    const source = '---\nname: gsd-x\ndescription: Does x.\ntools:\n  - Read\n  - Task\n  - AskUserQuestion\n---\nbody\n';
    assert.deepStrictEqual(toolsOf(convertClaudeAgentToKiroAgent(source)), ['read', 'subagent']);
  });

  test('an agent whose grants all map to nothing emits no tools key (keeps Kiro defaults)', () => {
    for (const tools of ['Skill, AskUserQuestion, TodoWrite', null]) {
      const fm = tools === null ? '' : `tools: ${tools}\n`;
      const out = convertClaudeAgentToKiroAgent(`---\nname: gsd-x\ndescription: Does x.\n${fm}---\nbody\n`);
      assert.strictEqual(fieldOf(frontmatterOf(out), 'tools'), null, `tools=${tools}`);
      assert.strictEqual(fieldOf(frontmatterOf(out), 'name'), 'gsd-x');
    }
  });

  test('a skill carries name + description frontmatter, the Kiro adapter, and Kiro-shaped references', () => {
    const source = '---\nname: gsd:plan-phase\ndescription: Plan a phase\nallowed-tools: Read\n---\nRun /gsd:execute-phase with $ARGUMENTS. Read CLAUDE.md. Use Bash(ls).\n';
    const out = convertClaudeCommandToKiroSkill(source, 'gsd-plan-phase');
    const fm = frontmatterOf(out);
    assert.strictEqual(fieldOf(fm, 'name'), 'gsd-plan-phase');
    assert.strictEqual(fieldOf(fm, 'description'), '"Plan a phase"');
    assert.strictEqual(fieldOf(fm, 'allowed-tools'), null);
    assert.ok(out.includes('<kiro_skill_adapter>'));
    assert.ok(out.includes('/gsd-execute-phase with {{GSD_ARGS}}'));
    assert.ok(out.includes('.kiro/steering/'));
    assert.ok(out.includes('shell(ls)'));
    assert.ok(!out.includes('$ARGUMENTS') && !out.includes('/gsd:') && !out.includes('CLAUDE.md'));
  });

  test('a skill description is capped at Kiro\'s 1024-character limit', () => {
    const long = 'x'.repeat(1500);
    const out = convertClaudeCommandToKiroSkill(`---\ndescription: ${long}\n---\nbody\n`, 'gsd-long');
    const description = JSON.parse(fieldOf(frontmatterOf(out), 'description'));
    assert.strictEqual(description.length, 1024);
    assert.ok(description.endsWith('...'));
  });
});

describe('Kiro install', () => {
  test('a local install writes Kiro-loadable skills and agents and no Claude-only surfaces', (t) => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-kiro-local-'));
    t.after(() => cleanup(project));
    assertExit0(runInstaller(project, ['--kiro', '--local']), 'kiro local install');

    const kiro = path.join(project, '.kiro');
    const skills = fs.readdirSync(path.join(kiro, 'skills')).filter((d) => d.startsWith('gsd-'));
    assert.ok(skills.includes('gsd-plan-phase') && skills.includes('gsd-new-project'), `skills: ${skills.join(', ')}`);
    for (const dir of skills) {
      const content = fs.readFileSync(path.join(kiro, 'skills', dir, 'SKILL.md'), 'utf8');
      assert.strictEqual(fieldOf(frontmatterOf(content), 'name'), dir, `${dir}: Kiro requires name === folder`);
      const description = JSON.parse(fieldOf(frontmatterOf(content), 'description'));
      assert.ok(description.length > 0 && description.length <= 1024, `${dir}: description within Kiro's limit`);
      assert.ok(!content.includes('~/.claude/') && !content.includes('$HOME/.claude/'), `${dir}: no global Claude paths`);
    }

    const agents = fs.readdirSync(path.join(kiro, 'agents'));
    assert.ok(agents.includes('gsd-planner.md'), `agents: ${agents.join(', ')}`);
    assert.deepStrictEqual(agents.filter((f) => f.endsWith('.compact.md')), [],
      'compact variants share their canonical name and must not reach Kiro\'s by-name agent registry');
    const kiroTags = new Set(['read', 'write', 'shell', 'web', 'subagent', '@mcp']);
    for (const file of agents) {
      const tools = toolsOf(fs.readFileSync(path.join(kiro, 'agents', file), 'utf8'));
      for (const tool of tools ?? []) assert.ok(kiroTags.has(tool), `${file}: '${tool}' is not a Kiro tool tag`);
    }

    assert.strictEqual(fs.readFileSync(path.join(kiro, 'gsd-core', '.gsd-runtime'), 'utf8').trim(), 'kiro');
    assert.ok(fs.existsSync(path.join(kiro, 'gsd-core', 'bin', 'gsd-tools.cjs')), 'engine is installed');
    for (const absent of ['settings.json', 'hooks', 'commands']) {
      assert.ok(!fs.existsSync(path.join(kiro, absent)), `kiro install must not write ${absent}`);
    }
  });

  test('Kiro and Claude installs coexist in one project, and uninstalling Kiro leaves Claude intact', (t) => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-kiro-claude-'));
    t.after(() => cleanup(project));
    assertExit0(runInstaller(project, ['--claude', '--local']), 'claude local install');
    const claudeSkill = path.join(project, '.claude', 'commands', 'gsd-plan-phase.md');
    const before = fs.readFileSync(claudeSkill, 'utf8');

    assertExit0(runInstaller(project, ['--kiro', '--local']), 'kiro local install');
    assert.ok(fs.existsSync(path.join(project, '.kiro', 'skills', 'gsd-plan-phase', 'SKILL.md')));
    assert.strictEqual(fs.readFileSync(claudeSkill, 'utf8'), before, 'kiro install must not touch .claude/');

    assertExit0(runInstaller(project, ['--kiro', '--local', '--uninstall']), 'kiro local uninstall');
    assert.ok(!fs.existsSync(path.join(project, '.kiro', 'skills', 'gsd-plan-phase')), 'kiro skills removed');
    assert.strictEqual(fs.readFileSync(claudeSkill, 'utf8'), before, 'kiro uninstall must not touch .claude/');
  });

  test('a global install honours KIRO_HOME', (t) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-kiro-home-'));
    t.after(() => cleanup(home));
    const kiroHome = path.join(home, 'kiro-profile');
    assertExit0(runInstaller(home, ['--kiro', '--global'], { KIRO_HOME: kiroHome }), 'kiro global install');
    assert.ok(fs.existsSync(path.join(kiroHome, 'skills', 'gsd-plan-phase', 'SKILL.md')), 'skills land under KIRO_HOME');
    assert.ok(!fs.existsSync(path.join(home, '.kiro', 'skills')), 'the default ~/.kiro is not written');
  });
});
