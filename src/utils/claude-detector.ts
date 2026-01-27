import { existsSync } from 'fs';
import { execSync } from 'child_process';
import { homedir } from 'os';
import { join } from 'path';

export interface ClaudeInstallation {
  path: string;
  version?: string;
  type: 'path' | 'npm-global' | 'native' | 'local' | 'homebrew' | 'env';
}

// Cache the detected installation
let cachedInstallation: ClaudeInstallation | null = null;

/**
 * Common Claude Code installation locations
 */
const CLAUDE_LOCATIONS = [
  // Native installer (new)
  { path: join(homedir(), '.claude', 'bin', 'claude'), type: 'native' as const },
  // npm global (common)
  { path: join(homedir(), '.npm-global', 'bin', 'claude'), type: 'npm-global' as const },
  // Local bin
  { path: join(homedir(), '.local', 'bin', 'claude'), type: 'local' as const },
  // Homebrew (macOS)
  { path: '/opt/homebrew/bin/claude', type: 'homebrew' as const },
  { path: '/usr/local/bin/claude', type: 'homebrew' as const },
  // Linux system
  { path: '/usr/bin/claude', type: 'path' as const },
];

/**
 * Detect Claude Code installation
 * Checks multiple locations and returns the first valid installation
 */
export function detectClaude(): ClaudeInstallation | null {
  // Return cached result if available
  if (cachedInstallation) {
    return cachedInstallation;
  }

  // Check environment variable override first
  const envPath = process.env.CLAUDE_PATH;
  if (envPath && existsSync(envPath)) {
    cachedInstallation = { path: envPath, type: 'env' };
    cachedInstallation.version = getClaudeVersion(envPath);
    return cachedInstallation;
  }

  // Check if 'claude' is in PATH using 'which'
  try {
    const whichResult = execSync('which claude 2>/dev/null', { encoding: 'utf-8' }).trim();
    if (whichResult && existsSync(whichResult)) {
      cachedInstallation = { path: whichResult, type: 'path' };
      cachedInstallation.version = getClaudeVersion(whichResult);
      return cachedInstallation;
    }
  } catch {
    // 'which' failed, continue checking known locations
  }

  // Check known locations
  for (const location of CLAUDE_LOCATIONS) {
    if (existsSync(location.path)) {
      cachedInstallation = { path: location.path, type: location.type };
      cachedInstallation.version = getClaudeVersion(location.path);
      return cachedInstallation;
    }
  }

  return null;
}

/**
 * Get Claude Code version
 */
function getClaudeVersion(claudePath: string): string | undefined {
  try {
    const result = execSync(`"${claudePath}" --version 2>/dev/null`, { encoding: 'utf-8' });
    const match = result.match(/(\d+\.\d+\.\d+)/);
    return match ? match[1] : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Get the Claude executable path, throwing if not found
 */
export function getClaudePath(): string {
  const installation = detectClaude();
  if (!installation) {
    throw new Error(
      'Claude Code not found. Please install it:\n' +
      '  npm install -g @anthropic-ai/claude-code\n' +
      'Or set CLAUDE_PATH environment variable to the claude executable path.'
    );
  }
  return installation.path;
}

/**
 * Check if Claude Code is installed
 */
export function isClaudeInstalled(): boolean {
  return detectClaude() !== null;
}

/**
 * Clear the cached installation (useful for testing or after installation changes)
 */
export function clearClaudeCache(): void {
  cachedInstallation = null;
}

/**
 * Get installation info as a formatted string
 */
export function getClaudeInfo(): string {
  const installation = detectClaude();
  if (!installation) {
    return 'Claude Code: Not installed';
  }
  const version = installation.version ? ` v${installation.version}` : '';
  return `Claude Code${version} (${installation.type}): ${installation.path}`;
}
