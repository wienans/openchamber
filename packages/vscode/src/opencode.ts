import * as vscode from 'vscode';
import { createOpencode } from '@opencode-ai/sdk/v2';
import type { OpencodeClient } from '@opencode-ai/sdk/v2';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Default timeout increased for Windows/network storage scenarios
const DEFAULT_STARTUP_TIMEOUT_MS = 15000;
const HEALTH_CHECK_INTERVAL_MS = 5000;

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export type OpenCodeDebugInfo = {
  mode: 'managed' | 'external';
  status: ConnectionStatus;
  lastError?: string;
  workingDirectory: string;
  cliAvailable: boolean;
  cliPath: string | null;
  configuredApiUrl: string | null;
  configuredPort: number | null;
  detectedPort: number | null;
  apiPrefix: string;
  apiPrefixDetected: boolean;
  startCount: number;
  restartCount: number;
  lastStartAt: number | null;
  lastConnectedAt: number | null;
  lastExitCode: number | null;
};

export interface OpenCodeManager {
  start(workdir?: string): Promise<void>;
  stop(): Promise<void>;
  restart(): Promise<void>;
  setWorkingDirectory(path: string): Promise<{ success: boolean; restarted: boolean; path: string }>;
  getStatus(): ConnectionStatus;
  getApiUrl(): string | null;
  getWorkingDirectory(): string;
  isCliAvailable(): boolean;
  getDebugInfo(): OpenCodeDebugInfo;
  onStatusChange(callback: (status: ConnectionStatus, error?: string) => void): vscode.Disposable;
}

// SDK instance type
interface OpencodeInstance {
  client: OpencodeClient;
  server: {
    url: string;
    close(): void;
  };
}

// Binary candidates for CLI availability check (backward compatibility)
const BIN_CANDIDATES = [
  process.env.OPENCHAMBER_OPENCODE_PATH,
  process.env.OPENCHAMBER_OPENCODE_BIN,
  process.env.OPENCODE_PATH,
  process.env.OPENCODE_BINARY,
  '/opt/homebrew/bin/opencode',
  '/usr/local/bin/opencode',
  '/usr/bin/opencode',
  path.join(os.homedir(), '.local/bin/opencode'),
  path.join(os.homedir(), '.opencode/bin/opencode'),
].filter(Boolean) as string[];

function isExecutable(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function getLoginShellPath(): string | null {
  if (process.platform === 'win32') {
    return null;
  }

  const shell = process.env.SHELL || '/bin/zsh';
  const shellName = path.basename(shell);

  // Nushell requires different flag syntax and PATH access
  const isNushell = shellName === 'nu' || shellName === 'nushell';
  const args = isNushell
    ? ['-l', '-i', '-c', '$env.PATH | str join (char esep)']
    : ['-lic', 'echo -n "$PATH"'];

  try {
    const result = spawnSync(shell, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result.status === 0 && typeof result.stdout === 'string') {
      const value = result.stdout.trim();
      if (value) {
        return value;
      }
    }
  } catch {
    // ignore
  }
  return null;
}

function buildAugmentedPath(): string {
  const augmented = new Set<string>();

  const loginPath = getLoginShellPath();
  if (loginPath) {
    for (const segment of loginPath.split(path.delimiter)) {
      if (segment) {
        augmented.add(segment);
      }
    }
  }

  const current = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const segment of current) {
    augmented.add(segment);
  }

  return Array.from(augmented).join(path.delimiter);
}

function resolveCliPath(): string | null {
  // First check explicit candidates (backward compatibility for OPENCODE_BINARY)
  for (const candidate of BIN_CANDIDATES) {
    if (candidate && isExecutable(candidate)) {
      return candidate;
    }
  }

  // Then search in augmented PATH
  const augmentedPath = buildAugmentedPath();
  for (const segment of augmentedPath.split(path.delimiter)) {
    const candidate = path.join(segment, 'opencode');
    if (isExecutable(candidate)) {
      return candidate;
    }
  }

  // Fallback: try login shell detection
  if (process.platform !== 'win32') {
    const shellCandidates = [
      process.env.SHELL,
      '/bin/bash',
      '/bin/zsh',
      '/bin/sh',
    ].filter(Boolean) as string[];

    for (const shellPath of shellCandidates) {
      if (!isExecutable(shellPath)) continue;
      try {
        const shellName = path.basename(shellPath);
        const isNushell = shellName === 'nu' || shellName === 'nushell';
        const args = isNushell
          ? ['-l', '-i', '-c', 'which opencode']
          : ['-lic', 'command -v opencode'];

        const result = spawnSync(shellPath, args, {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        if (result.status === 0) {
          const candidate = result.stdout.trim().split(/\s+/).pop();
          if (candidate && isExecutable(candidate)) {
            return candidate;
          }
        }
      } catch {
        // continue
      }
    }
  }

  return null;
}

/**
 * Prepend custom binary directory to PATH for SDK to find.
 * This provides backward compatibility for OPENCODE_BINARY env var.
 */
function setupPathForCustomBinary(): void {
  const customBinary = process.env.OPENCODE_BINARY || process.env.OPENCODE_PATH;
  if (customBinary && fs.existsSync(customBinary)) {
    const binDir = path.dirname(customBinary);
    const currentPath = process.env.PATH || '';
    if (!currentPath.split(path.delimiter).includes(binDir)) {
      process.env.PATH = `${binDir}${path.delimiter}${currentPath}`;
    }
  }

  // Also augment PATH with login shell paths
  const augmentedPath = buildAugmentedPath();
  process.env.PATH = augmentedPath;
}

async function checkHealth(apiUrl: string, quick = false): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeoutMs = quick ? 1500 : 3000;
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    const normalized = apiUrl.replace(/\/+$/, '');
    const candidates: string[] = [`${normalized}/config`];

    for (const target of candidates) {
      try {
        const response = await fetch(target, {
          signal: controller.signal,
          headers: { Accept: 'application/json' },
        });
        if (response.ok) {
          clearTimeout(timeout);
          return true;
        }
      } catch {
        // try next
      }
    }

    clearTimeout(timeout);
  } catch {
    // ignore
  }
  return false;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function createOpenCodeManager(_context: vscode.ExtensionContext): OpenCodeManager {
  let opencodeInstance: OpencodeInstance | null = null;
  let status: ConnectionStatus = 'disconnected';
  let healthCheckInterval: NodeJS.Timeout | null = null;
  let lastError: string | undefined;
  const listeners = new Set<(status: ConnectionStatus, error?: string) => void>();
  let workingDirectory: string = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || os.homedir();
  let startCount = 0;
  let restartCount = 0;
  let lastStartAt: number | null = null;
  let lastConnectedAt: number | null = null;
  let lastExitCode: number | null = null;

  // Port detection state
  let detectedPort: number | null = null;

  // OpenCode API prefix detection
  let apiPrefix: string = '';
  let apiPrefixDetected = false;

  // Check if user configured a specific API URL
  const config = vscode.workspace.getConfiguration('openchamber');
  const configuredApiUrl = config.get<string>('apiUrl') || '';
  const useConfiguredUrl = configuredApiUrl && configuredApiUrl.trim().length > 0;
  const startupTimeout = config.get<number>('startupTimeout') || DEFAULT_STARTUP_TIMEOUT_MS;

  // Parse configured URL to extract port if specified
  let configuredPort: number | null = null;
  if (useConfiguredUrl) {
    try {
      const parsed = new URL(configuredApiUrl);
      if (parsed.port) {
        configuredPort = parseInt(parsed.port, 10);
      }
    } catch {
      // Invalid URL, will use dynamic port
    }
  }

  const cliPath = resolveCliPath();
  const cliAvailable = cliPath !== null;

  function setStatus(newStatus: ConnectionStatus, error?: string) {
    if (status !== newStatus || lastError !== error) {
      status = newStatus;
      lastError = error;
      if (newStatus === 'connected') {
        lastConnectedAt = Date.now();
      }
      listeners.forEach(cb => cb(status, error));
    }
  }

  function getApiUrl(): string | null {
    if (useConfiguredUrl && configuredApiUrl) {
      return configuredApiUrl.replace(/\/+$/, '');
    }
    if (opencodeInstance) {
      return opencodeInstance.server.url;
    }
    return null;
  }

  function startHealthCheck() {
    stopHealthCheck();
    healthCheckInterval = setInterval(async () => {
      const apiUrl = getApiUrl();
      if (!apiUrl) {
        if (status === 'connected') {
          setStatus('disconnected');
        }
        return;
      }

      const healthy = await checkHealth(apiUrl);
      if (healthy && status !== 'connected') {
        setStatus('connected');
      } else if (!healthy && status === 'connected') {
        setStatus('disconnected');
      }
    }, HEALTH_CHECK_INTERVAL_MS);
  }

  function stopHealthCheck() {
    if (healthCheckInterval) {
      clearInterval(healthCheckInterval);
      healthCheckInterval = null;
    }
  }

  async function start(workdir?: string): Promise<void> {
    startCount += 1;
    lastStartAt = Date.now();

    if (typeof workdir === 'string' && workdir.trim().length > 0) {
      workingDirectory = workdir.trim();
    }

    // If user configured an external API URL, do NOT start a local CLI instance.
    if (useConfiguredUrl && configuredApiUrl) {
      setStatus('connecting');
      const healthy = await checkHealth(configuredApiUrl);
      if (healthy) {
        setStatus('connected');
        startHealthCheck();
        return;
      }
      setStatus('error', `OpenCode API at ${configuredApiUrl} is not responding.`);
      return;
    }

    // Check for existing running instance
    const currentUrl = getApiUrl();
    if (currentUrl && await checkHealth(currentUrl)) {
      setStatus('connected');
      startHealthCheck();
      return;
    }

    if (!cliAvailable) {
      setStatus('error', 'OpenCode CLI not found. Install it or set OPENCODE_BINARY env var.');
      vscode.window.showErrorMessage(
        'OpenCode CLI not found. Please install it or set the OPENCODE_BINARY environment variable.',
        'More Info'
      ).then(selection => {
        if (selection === 'More Info') {
          vscode.env.openExternal(vscode.Uri.parse('https://github.com/opencode-ai/opencode'));
        }
      });
      return;
    }

    setStatus('connecting');

    // Reset state for fresh start
    detectedPort = null;
    apiPrefix = '';
    apiPrefixDetected = false;
    lastExitCode = null;

    const spawnCwd = workingDirectory || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || os.homedir();
    const prevCwd = process.cwd();
    const shouldChdir = spawnCwd && fs.existsSync(spawnCwd);

    try {
      // Setup PATH for backward compatibility with OPENCODE_BINARY
      setupPathForCustomBinary();

      // Change to working directory before spawning (SDK uses process.cwd())
      if (shouldChdir) {
        process.chdir(spawnCwd);
      }

      // Use SDK's createOpencode function
      opencodeInstance = await createOpencode({
        hostname: '127.0.0.1',
        port: configuredPort ?? 0, // Dynamic port unless configured
        timeout: startupTimeout,
      });

      // Extract port and prefix from server URL
      try {
        const url = new URL(opencodeInstance.server.url);
        detectedPort = parseInt(url.port, 10) || null;
        const pathPrefix = url.pathname;
        if (pathPrefix && pathPrefix !== '/') {
          apiPrefix = pathPrefix.endsWith('/') ? pathPrefix.slice(0, -1) : pathPrefix;
          apiPrefixDetected = true;
        }
      } catch {
        // URL parsing failed, use defaults
      }

      setStatus('connected');
      startHealthCheck();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      lastExitCode = -1; // Unknown exit code from SDK error
      setStatus('error', `Failed to start OpenCode: ${message}`);
    } finally {
      // Restore original working directory
      if (shouldChdir) {
        try {
          process.chdir(prevCwd);
        } catch {
          // Ignore chdir errors
        }
      }
    }
  }

  async function stop(): Promise<void> {
    stopHealthCheck();

    if (opencodeInstance) {
      try {
        opencodeInstance.server.close();
      } catch {
        // ignore
      }
      opencodeInstance = null;
    }

    detectedPort = null;
    setStatus('disconnected');
  }

  async function restart(): Promise<void> {
    restartCount += 1;
    await stop();
    // Brief delay to let OS release resources
    await new Promise(r => setTimeout(r, 250));
    await start();
  }

  async function setWorkingDirectory(newPath: string): Promise<{ success: boolean; restarted: boolean; path: string }> {
    const target = typeof newPath === 'string' && newPath.trim().length > 0 ? newPath.trim() : workingDirectory;
    if (target === workingDirectory) {
      return { success: true, restarted: false, path: target };
    }
    workingDirectory = target;

    // When pointing at an external API URL, avoid restarting a local CLI process.
    if (useConfiguredUrl && configuredApiUrl) {
      return { success: true, restarted: false, path: target };
    }

    await restart();
    return { success: true, restarted: true, path: target };
  }

  return {
    start,
    stop,
    restart,
    setWorkingDirectory,
    getStatus: () => status,
    getApiUrl,
    getWorkingDirectory: () => workingDirectory,
    isCliAvailable: () => cliAvailable,
    getDebugInfo: () => ({
      mode: useConfiguredUrl && configuredApiUrl ? 'external' : 'managed',
      status,
      lastError,
      workingDirectory,
      cliAvailable,
      cliPath,
      configuredApiUrl: useConfiguredUrl && configuredApiUrl ? configuredApiUrl.replace(/\/+$/, '') : null,
      configuredPort,
      detectedPort,
      apiPrefix,
      apiPrefixDetected,
      startCount,
      restartCount,
      lastStartAt,
      lastConnectedAt,
      lastExitCode,
    }),
    onStatusChange(callback) {
      listeners.add(callback);
      // Immediately call with current status
      callback(status, lastError);
      return new vscode.Disposable(() => listeners.delete(callback));
    },
  };
}
