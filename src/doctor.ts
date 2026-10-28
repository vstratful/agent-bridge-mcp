import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Descriptor } from './adapters/claude.js';
import { codexEndpoints } from './adapters/codex.js';
import type { Config } from './config.js';
import { ownedSocket, processMatches, readLocalJson } from './local-files.js';
import { CodexRpc } from './rpc.js';
import { errorText } from './types.js';

export type Finding = { check: string; status: 'PASS'; finding: string }
  | { check: string; status: 'WARN' | 'FAIL' | 'SKIPPED'; finding: string; fix: string };
export type CommandRunner = (command: string, args: string[], options: {
  timeout: number; env: NodeJS.ProcessEnv;
}) => Promise<{ stdout: string; stderr: string }>;
export interface DoctorOptions {
  run?: CommandRunner;
  claudeCommand?: string;
  cliPath?: string;
  nodeVersion?: string;
  platform?: NodeJS.Platform;
  procStatPath?: string;
  procRoot?: string;
  uid?: number;
  loadSqlite?: () => Promise<unknown>;
}

const exec = promisify(execFile);
const oneLine = (text: string) => text.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ').trim();

export function formatDoctor(findings: Finding[]): string {
  return findings.map(item => `${item.status} ${item.check}: ${oneLine(item.finding)}`
    + (item.status === 'PASS' ? '' : `\n  Fix: ${oneLine(item.fix)}`)).join('\n');
}

function versionOf(text: string): number[] | undefined {
  const match = /\b(\d+)\.(\d+)\.(\d+)\b/.exec(text);
  return match ? match.slice(1).map(Number) : undefined;
}

function handshakeVersion(result: unknown): string | undefined {
  if (!result || typeof result !== 'object') return undefined;
  const response = result as { serverInfo?: { version?: unknown }; userAgent?: unknown };
  if (typeof response.serverInfo?.version === 'string') return response.serverInfo.version;
  if (typeof response.userAgent === 'string') {
    return /\bcodex[\w-]*\/([\d.]+(?:[-+][\w.-]+)?)/i.exec(response.userAgent)?.[1];
  }
  return undefined;
}

function olderThan(actual: number[], minimum: number[]): boolean {
  for (let i = 0; i < minimum.length; i++) {
    if (actual[i] !== minimum[i]) return actual[i]! < minimum[i]!;
  }
  return false;
}

async function checkedDirectory(path: string, uid: number): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || resolve(path) !== await realpath(path)) {
    throw new Error(`Not a directory with an unaliased path: ${path}`);
  }
  if (info.uid !== uid) throw new Error(`Directory is not owned by this user: ${path}`);
}

async function stateFinding(check: string, path: string, uid: number): Promise<Finding> {
  try {
    try {
      const info = await lstat(path);
      await checkedDirectory(path, uid);
      if ((info.mode & 0o077) !== 0) throw new Error(`Directory is not private (expected mode 0700): ${path}`);
      await access(path, constants.W_OK | constants.X_OK);
      return { check, status: 'PASS', finding: `${path} is owned, private and writable` };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    let parent = dirname(path);
    for (;;) {
      try {
        const info = await lstat(parent);
        if (!info.isDirectory() || resolve(parent) !== await realpath(parent)) throw new Error(`Unsafe parent directory: ${parent}`);
        await access(parent, constants.W_OK | constants.X_OK);
        return { check, status: 'PASS', finding: `${path} does not exist; nearest existing parent ${parent} is writable (nothing created)` };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || parent === dirname(parent)) throw error;
        parent = dirname(parent);
      }
    }
  } catch (error) {
    return { check, status: 'FAIL', finding: errorText(error), fix: `Choose a writable, user-owned private ${check.toLowerCase()} directory; for an existing directory, fix its ownership and set mode 0700.` };
  }
}

async function canonical(path: string): Promise<string> {
  return realpath(path).catch(() => resolve(path));
}

function registeredCli(output: string, json: boolean): string | undefined {
  if (json) {
    const record = JSON.parse(output);
    const transport = record.transport ?? record;
    const args: unknown[] = [transport.command, ...(Array.isArray(transport.args) ? transport.args : [])];
    return args.find((arg): arg is string => typeof arg === 'string' && /(?:^|\/)dist\/cli\.js$/.test(arg));
  }
  const args = /^\s*Args:\s*(.+)$/mi.exec(output)?.[1]?.trim();
  const command = /^\s*Command:\s*(.+)$/mi.exec(output)?.[1]?.trim();
  // Claude's human-readable output has a separate Args line; preserve spaces
  // inside the absolute script path instead of treating it as shell input.
  return [command, args?.replace(/\s+serve\s*$/, '').replace(/^(["'])(.*)\1$/, '$2')]
    .find((value): value is string => !!value && /(?:^|\/)dist\/cli\.js$/.test(value));
}

async function registration(check: string, command: string, run: (command: string, args: string[]) => Promise<{ stdout: string; stderr: string }>, cliPath: string): Promise<Finding> {
  const fix = `Register agent-bridge with ${command} mcp add using absolute Node and ${cliPath} paths, then reconnect the client.`;
  try {
    const { stdout: help } = await run(command, ['mcp', '--help']);
    if (!/^\s*get\b/m.test(help)) return { check, status: 'SKIPPED', finding: 'skipped: CLI does not advertise mcp get', fix: 'Check registration manually with the MCP commands supported by this client.' };
    const { stdout: getHelp } = await run(command, ['mcp', 'get', '--help']);
    const json = /--json\b/.test(getHelp);
    if (/health.check/i.test(getHelp)) {
      return { check, status: 'SKIPPED', finding: 'claude mcp get health-checks by starting the registered server; run `claude mcp get agent-bridge` or /mcp yourself to confirm', fix: 'Check registration manually; doctor will not start an MCP server.' };
    }
    const { stdout } = await run(command, ['mcp', 'get', 'agent-bridge', ...(json ? ['--json'] : [])]);
    if (/not found|not registered|no .*server/i.test(stdout)) return { check, status: 'WARN', finding: 'agent-bridge is not registered', fix };
    const registered = registeredCli(stdout, json);
    if (!registered) return { check, status: 'WARN', finding: 'registration found, but its dist/cli.js path could not be verified', fix };
    if (await canonical(registered) !== await canonical(cliPath)) {
      return { check, status: 'WARN', finding: `registered command points at ${registered}, doctor is running ${cliPath}`, fix };
    }
    return { check, status: 'PASS', finding: `agent-bridge points at ${cliPath}` };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { check, status: 'SKIPPED', finding: 'skipped: command is missing', fix: `Install ${command} and rerun doctor.` };
    }
    return { check, status: 'WARN', finding: 'agent-bridge is not registered or registration could not be read', fix };
  }
}

/** Read-only checks: no stores, mkdir, writes, messages, thread/read or thread resume. */
export async function runDoctor(config: Config, options: DoctorOptions = {}): Promise<Finding[]> {
  const findings: Finding[] = [];
  const uid = options.uid ?? process.getuid?.() ?? -1;
  const cliPath = options.cliPath ?? fileURLToPath(new URL('./cli.js', import.meta.url));
  const claudeCommand = options.claudeCommand ?? 'claude';
  const runner: CommandRunner = options.run ?? ((command, args, opts) => exec(command, args, { ...opts, maxBuffer: 128 * 1024 }));
  const run = (command: string, args: string[]) => runner(command, args, {
    timeout: config.timeoutMs,
    env: { ...process.env, CLAUDE_CONFIG_DIR: config.claudeHome, CODEX_HOME: config.codexHome },
  });
  const nodeVersion = options.nodeVersion ?? process.versions.node;
  try {
    if (Number(nodeVersion.split('.')[0]) < 24) throw new Error(`Node.js ${nodeVersion} is below 24`);
    await (options.loadSqlite ?? (() => import('node:sqlite')))();
    findings.push({ check: 'Node', status: 'PASS', finding: `Node.js ${nodeVersion}; node:sqlite loads` });
  } catch (error) {
    findings.push({ check: 'Node', status: 'FAIL', finding: errorText(error), fix: 'Use Node.js 24 or newer with node:sqlite enabled, and register its absolute executable path.' });
  }
  try {
    if ((options.platform ?? process.platform) !== 'linux') throw new Error('Linux/WSL only: discovery reads /proc');
    await readFile(options.procStatPath ?? '/proc/self/stat', 'utf8');
    findings.push({ check: 'Platform', status: 'PASS', finding: 'Linux/WSL; /proc/self/stat is readable' });
  } catch (error) {
    findings.push({ check: 'Platform', status: 'FAIL', finding: errorText(error), fix: 'Run doctor on Linux or WSL 2 in the same process namespace as the clients, with /proc readable.' });
  }
  for (const [check, command, tested, minimum] of [
    ['Claude version', claudeCommand, '2.1.312', [2, 1, 224]],
  ] as const) {
    try {
      const { stdout } = await run(command, ['--version']);
      const version = versionOf(stdout);
      if (!version) throw new Error('Could not parse the CLI version');
      const actual = version.join('.');
      if (minimum && olderThan(version, [...minimum])) findings.push({ check, status: 'FAIL', finding: `${actual} is below the cross-session messaging minimum 2.1.224`, fix: 'Upgrade Claude Code to at least 2.1.224; 2.1.312 is the tested version.' });
      else if (actual !== tested) findings.push({ check, status: 'WARN', finding: `${actual}: untested version (tested ${tested})`, fix: 'Use the tested version or verify discovery and delivery after updating the client.' });
      else findings.push({ check, status: 'PASS', finding: `${actual} matches the tested version` });
    } catch (error) {
      findings.push({ check, status: 'FAIL', finding: `Cannot run ${command} --version: ${errorText(error)}`, fix: `Install ${command} and make its executable available on PATH (Codex also supports AGENT_BRIDGE_CODEX_COMMAND).` });
    }
  }
  const registry = join(config.claudeHome, 'sessions');
  try {
    await checkedDirectory(registry, uid);
    const files = (await readdir(registry)).filter(name => /^[1-9]\d*\.json$/.test(name));
    let live = 0;
    let stale = 0;
    const unknownPids: number[] = [];
    for (const file of files) {
      const result = await readLocalJson(join(registry, file))
        .then(value => Descriptor.safeParse(value)).catch(() => undefined);
      if (!result?.success) {
        const pid = Number(file.slice(0, -5));
        // Old formats left by dead processes are normal. Only flag drift when
        // the registration belongs to a currently running Claude process.
        const cmdline = Number.isSafeInteger(pid)
          ? await readFile(join(options.procRoot ?? '/proc', String(pid), 'cmdline'), 'utf8').catch(() => '')
          : '';
        if (cmdline.includes('claude')) unknownPids.push(pid);
        else stale++;
        continue;
      }
      try {
        const d = result.data;
        if (file !== `${d.pid}.json` || !await processMatches(d.pid, d.procStart, d.pidDomain)) {
          stale++;
          continue;
        }
        await ownedSocket(d.messagingSocketPath);
        live++;
      } catch { stale++; }
    }
    if (unknownPids.length) findings.push({ check: 'Claude registry', status: 'FAIL', finding: `Claude session registry format changed for running session(s) ${unknownPids.sort((a, b) => a - b).join(', ')}; the bridge needs updating`, fix: 'Update the bridge Descriptor schema against the installed Claude version before sending messages.' });
    else if (!live) findings.push({ check: 'Claude registry', status: 'WARN', finding: 'no live Claude session found', fix: 'Start a Claude session with cross-session messaging enabled in this namespace.' });
    else findings.push({ check: 'Claude registry', status: 'PASS', finding: `${live} live, ${stale} stale registrations ignored` });
  } catch (error) {
    findings.push({ check: 'Claude registry', status: 'FAIL', finding: `${registry}: ${errorText(error)}`, fix: 'Start Claude Code with cross-session messaging enabled; verify CLAUDE_CONFIG_DIR and directory ownership.' });
  }
  const codexVersions = new Set<string>();
  try {
    const paths = await codexEndpoints(config);
    let reachable = 0;
    let loaded = 0;
    const warnings: string[] = [];
    if (paths.length > 32) warnings.push('probe capped at 32 endpoints');
    await Promise.all(paths.slice(0, 32).map(async path => {
      let rpc: CodexRpc | undefined;
      try {
        await ownedSocket(path);
        rpc = await CodexRpc.connect(path, config.timeoutMs);
        const version = handshakeVersion(rpc.initializeResult);
        if (version && versionOf(version)) codexVersions.add(version);
        let cursor: string | null = null;
        let count = 0;
        for (let page = 0; page < 10; page++) {
          const result: { data: string[]; nextCursor?: string | null } = await rpc.call('thread/loaded/list', { limit: 100, cursor });
          if (!Array.isArray(result.data) || result.data.some(id => typeof id !== 'string')) throw new Error('Invalid thread/loaded/list response');
          count += result.data.length;
          cursor = result.nextCursor ?? null;
          if (!cursor) break;
          if (page === 9) warnings.push(`loaded-thread pagination capped at ${path}`);
        }
        reachable++;
        loaded += count;
      } catch (error) {
        warnings.push(`${path}: ${errorText(error)}`);
      } finally { rpc?.close(); }
    }));
    const counts = `${paths.length} endpoints excluding updater, ${reachable} reachable, ${loaded} loaded threads`;
    if (!reachable) findings.push({ check: 'Codex endpoints', status: 'FAIL', finding: `${counts}${warnings.length ? `; ${warnings.join('; ')}` : ''}`, fix: 'Start the Codex app-server daemon; check /tmp/codex-daemon-<uid>, socket ownership, and AGENT_BRIDGE_CODEX_SOCKET.' });
    else if (warnings.length) findings.push({ check: 'Codex endpoints', status: 'WARN', finding: `${counts}; ${warnings.join('; ')}`, fix: 'Check stale or inaccessible daemon endpoints, or select the working one with AGENT_BRIDGE_CODEX_SOCKET.' });
    else findings.push({ check: 'Codex endpoints', status: 'PASS', finding: counts });
  } catch (error) {
    findings.push({ check: 'Codex endpoints', status: 'FAIL', finding: errorText(error), fix: 'Start the Codex app-server daemon; check its socket directory or select AGENT_BRIDGE_CODEX_SOCKET.' });
  }
  let versionNote = ' (app-server initialize)';
  try {
    if (!codexVersions.size) {
      versionNote = ' (the codex CLI may update its PATH alias)';
      const { stdout } = await run(config.codexCommand, ['--version']);
      const version = versionOf(stdout);
      if (!version) throw new Error('Could not parse the CLI version');
      codexVersions.add(version.join('.'));
    }
    const actual = [...codexVersions].join(', ');
    if ([...codexVersions].some(version => version !== '0.165.0')) {
      findings.push({ check: 'Codex version', status: 'WARN', finding: `${actual}: untested version (tested 0.165.0)${versionNote}`, fix: 'Use the tested version or verify discovery and delivery after updating Codex.' });
    } else findings.push({ check: 'Codex version', status: 'PASS', finding: `${actual} matches the tested version${versionNote}` });
  } catch (error) {
    findings.push({ check: 'Codex version', status: 'FAIL', finding: `Cannot determine Codex version: ${errorText(error)}${versionNote}`, fix: 'Start the Codex app-server daemon or install codex on PATH (AGENT_BRIDGE_CODEX_COMMAND can override its path).' });
  }
  findings.push(await stateFinding('State', config.stateDir, uid));
  findings.push(await stateFinding('Runtime', config.runtimeDir, uid));
  findings.push(await registration('Claude registration', claudeCommand, run, cliPath));
  findings.push(await registration('Codex registration', config.codexCommand, run, cliPath));
  return findings;
}
