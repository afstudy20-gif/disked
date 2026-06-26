import express from 'express';
import cors from 'cors';
import { promises as fs } from 'fs';
import { existsSync } from 'fs';
import path from 'path';
import { exec, execFile } from 'child_process';
import { promisify } from 'util';
import os from 'os';
import trash from 'trash';
import crypto from 'crypto';
import { createReadStream, readFileSync } from 'fs';
import { fileURLToPath } from 'url';

// Add common macOS paths to process.env.PATH if they aren't already present
if (process.platform === 'darwin') {
  const commonPaths = ['/usr/local/bin', '/opt/homebrew/bin'];
  const currentPaths = (process.env.PATH || '').split(path.delimiter);
  for (const p of commonPaths) {
    if (!currentPaths.includes(p)) {
      currentPaths.push(p);
    }
  }
  process.env.PATH = currentPaths.join(path.delimiter);
}

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile); // no shell — safe for untrusted path args
const app = express();
const PORT = process.env.PORT || 5005;

// Load shared smart-scan configuration from the single source of truth
// that is also compiled into the Tauri Rust binary.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const smartScanConfig = JSON.parse(
  readFileSync(path.join(__dirname, 'src-tauri', 'smart-scan-config.json'), 'utf8')
);

function resolveTilde(inputPath) {
  if (typeof inputPath !== 'string') return inputPath;
  if (inputPath.startsWith('~/')) {
    return path.join(os.homedir(), inputPath.slice(2));
  }
  return inputPath;
}

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use((req, res, next) => {
  console.log(`[Backend] ${req.method} ${req.url}`);
  next();
});

// Optional Basic Auth Middleware based on Environment Variables
const authUser = process.env.BASIC_AUTH_USER;
const authPass = process.env.BASIC_AUTH_PASS;
if (authUser && authPass) {
  app.use((req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      res.setHeader('WWW-Authenticate', 'Basic realm="disked"');
      return res.status(401).send('Authentication required');
    }

    try {
      const token = authHeader.split(' ')[1];
      const credentials = Buffer.from(token, 'base64').toString('utf8').split(':');
      const user = credentials[0];
      const pass = credentials[1];

      if (user === authUser && pass === authPass) {
        return next();
      }
    } catch (e) {}

    res.setHeader('WWW-Authenticate', 'Basic realm="disked"');
    return res.status(401).send('Authentication required');
  });
}

// Global scanner state
let scanState = {
  active: false,
  cancelled: false,
  currentPath: '',
  foldersScanned: 0,
  filesScanned: 0,
  totalSizeCalculated: 0,
  topFiles: [], // Array of { name, path, size, updatedAt }
  tree: {}, // Map of path -> { name, path, size, isDirectory, children }
  error: null,
  permissionErrors: 0 // Folders/files that could not be read
};

class ConcurrencyLimiter {
  constructor(max) {
    this.max = max;
    this.active = 0;
    this.queue = [];
  }
  async run(fn, state) {
    if (state && state.cancelled) {
      return null;
    }
    if (this.active >= this.max) {
      await new Promise(resolve => this.queue.push({ resolve, state }));
    }
    if (state && state.cancelled) {
      this.processQueue();
      return null;
    }
    this.active++;
    try {
      if (state && state.cancelled) {
        return null;
      }
      return await fn();
    } finally {
      this.active--;
      this.processQueue();
    }
  }
  processQueue() {
    if (this.queue.length > 0) {
      const { resolve } = this.queue.shift();
      resolve();
    }
  }
}
const fsLimiter = new ConcurrencyLimiter(30);

// Helper to keep top 100 files sorted by size
function insertIntoTopFiles(list, file) {
  let insertIndex = list.findIndex(item => item.size < file.size);
  if (insertIndex === -1) {
    if (list.length < 100) {
      list.push(file);
    }
  } else {
    list.splice(insertIndex, 0, file);
    if (list.length > 100) {
      list.pop();
    }
  }
}

// Check path safety before deletion
function isSafeToDelete(targetPath, homeDir) {
  const normalized = path.normalize(targetPath);
  const home = homeDir || os.homedir();
  const resolvedHome = path.resolve(home);
  const resolvedTarget = path.resolve(normalized);

  // Strip /host prefix if present to check system protections
  let checkTarget = resolvedTarget;
  if (resolvedTarget.startsWith('/host/') || resolvedTarget === '/host') {
    checkTarget = resolvedTarget === '/host' ? '/' : resolvedTarget.substring(5);
  }

  // Absolute blocked directories
  const blockedPaths = [
    '/',
    '/System',
    '/Library',
    '/bin',
    '/sbin',
    '/usr',
    '/var',
    '/etc',
    '/private',
    '/cores',
    '/dev',
    '/proc',
    '/sys',
    '/run',
    '/boot',
    '/opt',
    '/Applications',
    '/Users',
    '/lost+found'
  ];

  if (blockedPaths.includes(checkTarget)) {
    return false;
  }

  // Prevent deleting critical home directories themselves
  const keyHomeFolders = [
    resolvedHome,
    path.join(resolvedHome, 'Desktop'),
    path.join(resolvedHome, 'Documents'),
    path.join(resolvedHome, 'Downloads'),
    path.join(resolvedHome, 'Library'),
    path.join(resolvedHome, 'Applications')
  ];

  if (keyHomeFolders.includes(resolvedTarget)) {
    return false;
  }

  // Allow deleting items inside the home directory
  if (resolvedTarget.startsWith(resolvedHome + path.sep) || resolvedTarget === path.join(resolvedHome, '.npm') || resolvedTarget === path.join(resolvedHome, '.cargo')) {
    return true;
  }

  // If we're inside `/host`, allow deleting if it's not a blocked path and is inside `/host`
  if (resolvedTarget.startsWith('/host' + path.sep)) {
    const parts = checkTarget.split(path.sep).filter(Boolean);
    // If it has fewer than 2 segments (like /etc, /var, /usr), block it.
    if (parts.length <= 1) {
      return false;
    }
    return true;
  }

  return false;
}

// Folders that we scan the total size of, but don't parse sub-folders (saves memory & CPU)
const LEAF_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  '.venv',
  'venv',
  'env',
  '.idea',
  '.vscode',
  '.next',
  '.nuxt'
]);

// Helper to determine if a directory should be skipped from scanning
function isExcluded(fullPath, homeDir, targetPath) {
  const normalized = path.normalize(fullPath);
  const name = path.basename(normalized);

  const excludedNames = [
    'Saved Application State',
    'Autosave Information',
    '.Trash'
  ];
  if (excludedNames.includes(name)) return true;

  // Prevent scanning the mounted host root /host when starting the scan from container paths
  if (targetPath && !targetPath.startsWith('/host')) {
    if (normalized === '/host' || normalized.startsWith('/host' + path.sep)) {
      return true;
    }
  }

  const systemPaths = [
    '/System',
    '/Volumes',
    '/dev',
    '/proc',
    '/sys',
    '/run',
    '/mnt',
    '/media',
    '/boot',
    '/cores',
    '/private',
    '/Network',
    '/usr',
    '/bin',
    '/sbin',
    '/var/lib/docker',
    '/var/run/docker.sock',
    '/lost+found'
  ];

  // Check both the normalized path, and the path with /host prefix stripped if present
  const checkPaths = [normalized];
  if (normalized.startsWith('/host/') || normalized === '/host') {
    const stripped = normalized === '/host' ? '/' : normalized.substring(5);
    checkPaths.push(stripped);
  }

  for (const checkPath of checkPaths) {
    if (systemPaths.some(p => checkPath === p || checkPath.startsWith(p + path.sep))) {
      return true;
    }
  }

  if (homeDir) {
    const cloudStorage = path.join(homeDir, 'Library/CloudStorage');
    const icloudDrive = path.join(homeDir, 'Library/Mobile Documents');

    if (normalized === cloudStorage || normalized.startsWith(cloudStorage + path.sep)) {
      return true;
    }
    if (normalized === icloudDrive || normalized.startsWith(icloudDrive + path.sep)) {
      return true;
    }
  }

  return false;
}

// Recursive size calculator with concurrency limit and tree builder
async function scanDirectoryRecursive(dirPath, state, depth = 0) {
  if (state.cancelled) return 0;

  state.currentPath = dirPath;
  state.foldersScanned++;

  const maxDepth = state.maxDepth ?? 10;
  const maxChildren = state.maxChildren ?? 200;
  const shouldRecurse = depth < maxDepth;

  let totalSize = 0;
  let children = [];
  const home = os.homedir();

  try {
    const entries = await fsLimiter.run(() => fs.readdir(dirPath, { withFileTypes: true }), state);
    if (!entries) return 0;

    const promises = entries.map(async (entry) => {
      if (state.cancelled) return null;
      const fullPath = path.join(dirPath, entry.name);

      // Check exclusions dynamically
      if (isExcluded(fullPath, home, state.targetPath)) {
        return null;
      }

      if (entry.isSymbolicLink()) {
        return null;
      }

      if (entry.isDirectory()) {
        const isLeaf = LEAF_DIRECTORIES.has(entry.name);
        
        let subSize = 0;
        if (isLeaf || !shouldRecurse) {
          // If it's a leaf folder (like node_modules) or we've hit the depth limit,
          // calculate its size but don't add its children to the tree.
          subSize = await getFolderSizeFast(fullPath, state);
        } else {
          subSize = await scanDirectoryRecursive(fullPath, state, depth + 1);
        }

        let mtime = new Date();
        try {
          const stats = await fsLimiter.run(() => fs.lstat(fullPath), state);
          if (stats) mtime = stats.mtime;
        } catch (e) {}

        return {
          name: entry.name,
          path: fullPath,
          isDirectory: true,
          size: subSize,
          updatedAt: mtime
        };
      } else if (entry.isFile()) {
        try {
          const stats = await fsLimiter.run(() => fs.lstat(fullPath), state);
          if (!stats) return null;
          const size = stats.blocks !== undefined ? Math.min(stats.size, stats.blocks * 512) : stats.size;
          
          state.filesScanned++;
          state.totalSizeCalculated += size;

          insertIntoTopFiles(state.topFiles, {
            name: entry.name,
            path: fullPath,
            size: size,
            updatedAt: stats.mtime
          });

          // Add file to folder's children list
          return {
            name: entry.name,
            path: fullPath,
            isDirectory: false,
            size: size,
            updatedAt: stats.mtime
          };
        } catch (e) {
          // File might be missing or locked
          return null;
        }
      }
      return null;
    });

    const results = await Promise.all(promises);

    for (const res of results) {
      if (res) {
        totalSize += res.size;
        children.push(res);
      }
    }
  } catch (err) {
    // Permission denied or other error
    if (err && (err.code === 'EACCES' || err.code === 'EPERM')) {
      state.permissionErrors++;
    }
  }

  // Sort subfolders/files in tree node by size descending
  children.sort((a, b) => b.size - a.size);

  // Keep only the largest children to bound memory usage
  if (children.length > maxChildren) {
    children = children.slice(0, maxChildren);
  }

  state.tree[dirPath] = {
    name: path.basename(dirPath) || dirPath,
    path: dirPath,
    size: totalSize,
    isDirectory: true,
    children: children
  };

  return totalSize;
}

// Fast size calculation for skipped directories (like node_modules)
async function getFolderSizeFast(dirPath, state) {
  let size = 0;
  try {
    const entries = await fsLimiter.run(() => fs.readdir(dirPath, { withFileTypes: true }), state);
    if (!entries) return 0;
    
    const promises = entries.map(async (entry) => {
      if (state.cancelled) return 0;
      const fullPath = path.join(dirPath, entry.name);
      
      if (entry.isSymbolicLink()) return 0;

      if (entry.isDirectory()) {
        return await getFolderSizeFast(fullPath, state);
      } else if (entry.isFile()) {
        try {
          const stats = await fsLimiter.run(() => fs.lstat(fullPath), state);
          if (!stats) return 0;
          const physicalSize = stats.blocks !== undefined ? Math.min(stats.size, stats.blocks * 512) : stats.size;
          
          state.filesScanned++;
          state.totalSizeCalculated += physicalSize;
          return physicalSize;
        } catch (e) {
          return 0;
        }
      }
      return 0;
    });

    const sizes = await Promise.all(promises);
    for (const s of sizes) {
      size += s;
    }
  } catch (e) {}
  return size;
}

// Endpoint to get disk stats
app.get('/api/disk-space', async (req, res) => {
  try {
    const home = os.homedir();
    const { stdout } = await execAsync(`df -k "${home.replace(/"/g, '\\"')}"`);
    const lines = stdout.trim().split('\n');
    if (lines.length < 2) {
      return res.status(500).json({ error: 'Unable to parse disk stats' });
    }
    const parts = lines[1].split(/\s+/);
    const totalKB = parseInt(parts[1], 10);
    const volumeUsedKB = parseInt(parts[2], 10);
    const availableKB = parseInt(parts[3], 10);
    
    // On macOS APFS, multiple volumes share the container.
    // The actual container used space is (total - available).
    // The space used by other volumes is total - available - volumeUsed.
    const otherKB = Math.max(0, totalKB - availableKB - volumeUsedKB);
    const percentage = Math.round(((totalKB - availableKB) / totalKB) * 100);

    res.json({
      total: totalKB * 1024,
      used: volumeUsedKB * 1024,
      available: availableKB * 1024,
      other: otherKB * 1024,
      percentage: percentage,
      homeDir: home
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Endpoint to trigger a scan
app.post('/api/scan', async (req, res) => {
  const { scanPath, maxDepth = 10, maxChildren = 200 } = req.body;
  const targetPath = scanPath ? path.resolve(scanPath) : os.homedir();

  if (!existsSync(targetPath)) {
    return res.status(400).json({ error: 'Target path does not exist' });
  }

  // Cancel running scan if active
  if (scanState.active) {
    scanState.cancelled = true;
    // wait slightly for cancellation
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  scanState = {
    active: true,
    cancelled: false,
    currentPath: targetPath,
    targetPath: targetPath,
    foldersScanned: 0,
    filesScanned: 0,
    totalSizeCalculated: 0,
    topFiles: [],
    tree: {},
    error: null,
    permissionErrors: 0,
    maxDepth,
    maxChildren
  };

  // Run in background
  scanDirectoryRecursive(targetPath, scanState, 0).then(() => {
    scanState.active = false;
  }).catch((err) => {
    scanState.active = false;
    scanState.error = err.message;
  });

  res.json({ message: 'Scan started', targetPath });
});

// Cancel active scan
app.post('/api/scan/cancel', (req, res) => {
  if (scanState.active) {
    scanState.cancelled = true;
    scanState.active = false;
    return res.json({ message: 'Scan cancellation requested' });
  }
  res.json({ message: 'No active scan to cancel' });
});

// SSE progress reporting endpoint
app.get('/api/scan-progress', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  const sendProgress = () => {
    res.write(`data: ${JSON.stringify({
      active: scanState.active,
      cancelled: scanState.cancelled,
      currentPath: scanState.currentPath,
      foldersScanned: scanState.foldersScanned,
      filesScanned: scanState.filesScanned,
      totalSizeCalculated: scanState.totalSizeCalculated,
      topFiles: scanState.topFiles,
      error: scanState.error,
      permissionErrors: scanState.permissionErrors
    })}\n\n`);
  };

  sendProgress();

  const interval = setInterval(() => {
    sendProgress();
    if (!scanState.active) {
      clearInterval(interval);
      res.end();
    }
  }, 200);

  req.on('close', () => {
    clearInterval(interval);
  });
});

// Fetch detailed scanned tree once scanning is done
app.get('/api/scan-results', (req, res) => {
  if (scanState.active) {
    return res.status(400).json({ error: 'Scan is still running' });
  }
  res.json({
    tree: scanState.tree,
    topFiles: scanState.topFiles,
    totalSize: scanState.totalSizeCalculated,
    filesCount: scanState.filesScanned,
    foldersCount: scanState.foldersScanned,
    permissionErrors: scanState.permissionErrors
  });
});

// Deletion endpoint with safety checks
app.post('/api/delete', async (req, res) => {
  const { paths } = req.body; // Array of paths to delete

  if (!paths || !Array.isArray(paths) || paths.length === 0) {
    return res.status(400).json({ error: 'No paths provided for deletion' });
  }

  const results = [];
  let spaceFreed = 0;

  for (const targetPath of paths) {
    const resolvedPath = path.resolve(targetPath);

    if (!existsSync(resolvedPath)) {
      results.push({ path: targetPath, status: 'skipped', reason: 'Path does not exist' });
      continue;
    }

    if (!isSafeToDelete(resolvedPath)) {
      results.push({ path: targetPath, status: 'error', reason: 'Access denied: System folder protection active' });
      continue;
    }

    try {
      const stats = await fs.lstat(resolvedPath);
      let itemSize = stats.blocks !== undefined ? Math.min(stats.size, stats.blocks * 512) : stats.size;
      
      // If it's a directory, calculate its size before deleting for reporting
      if (stats.isDirectory()) {
        const tempState = { cancelled: false };
        itemSize = await getFolderSizeFast(resolvedPath, tempState);
      }

      // Move to trash instead of permanently deleting
      await trash(resolvedPath);

      spaceFreed += itemSize;
      results.push({ path: targetPath, status: 'success', size: itemSize });
    } catch (err) {
      results.push({ path: targetPath, status: 'error', reason: err.message });
    }
  }

  res.json({
    message: 'Deletion completed',
    results,
    spaceFreed
  });
});

// Smart Clean quick scan categories size scanner
app.get('/api/smart-scan-targets', async (req, res) => {
  const results = [];

  for (const t of smartScanConfig.targets) {
    const resolvedPaths = t.paths.map(resolveTilde).filter(p => existsSync(p));
    const exists = resolvedPaths.length > 0;
    let size = 0;

    if (exists) {
      const tempState = { cancelled: false };
      for (const p of resolvedPaths) {
        size += await getFolderSizeFast(p, tempState);
      }
    }

    results.push({
      id: t.id,
      name: t.name,
      icon: t.icon,
      description: t.description,
      category: t.category,
      path: resolvedPaths[0] || resolveTilde(t.paths[0]),
      paths: resolvedPaths,
      command: t.command,
      safety: t.safety,
      safetyLabel: t.safetyLabel,
      consequence: t.consequence,
      size,
      exists
    });
  }

  res.json(results);
});

// Run docker prune CLI command directly
app.post('/api/docker-prune', async (req, res) => {
  try {
    // Check if docker is running first
    await execAsync('docker info');
    const { stdout } = await execAsync('docker system prune -af --volumes');
    res.json({ success: true, log: stdout });
  } catch (err) {
    res.status(500).json({ error: 'Docker is not running or not accessible', details: err.message });
  }
});

// Terminal access is intentionally disabled in the Express/web dev server because
// exposing an arbitrary shell execution endpoint on localhost is a remote-code-
// execution risk (any website can POST to localhost). Use the Tauri desktop app
// for the interactive terminal.
app.post('/api/terminal/run', (req, res) => {
  res.status(403).json({
    error: 'Terminal is only available in the Tauri desktop build.',
    detail: 'Arbitrary shell execution is disabled in the web/Express dev server for security.'
  });
});

// ----------------- APP UNINSTALLER (macOS) -----------------

// Library subdomains scanned for an app's leftover files (relative to ~/Library and /Library).
// modes: name (== bundleId/appName/exec), id (== bundleId), group (contains bundleId),
// pref (bundleId.* plist), saved (bundleId.savedState), cookie (bundleId.binarycookies)
const LIBRARY_DOMAINS = [
  ['Application Support', 'Application Support', 'name'],
  ['Caches', 'Cache', 'name'],
  ['Logs', 'Logs', 'name'],
  ['Containers', 'Container', 'id'],
  ['Application Scripts', 'App Scripts', 'id'],
  ['WebKit', 'WebKit Data', 'id'],
  ['HTTPStorages', 'HTTP Storage', 'id'],
  ['Group Containers', 'Group Container', 'group'],
  ['Preferences', 'Preferences', 'pref'],
  ['Preferences/ByHost', 'Preferences (ByHost)', 'pref'],
  ['SyncedPreferences', 'Synced Preferences', 'pref'],
  ['Saved Application State', 'Saved State', 'saved'],
  ['Cookies', 'Cookies', 'cookie'],
  ['LaunchAgents', 'Launch Agent', 'pref']
];

// Extra domains only scanned under /Library (system-wide, typically need admin).
const SYSTEM_DOMAINS = [
  ['LaunchDaemons', 'Launch Daemon', 'pref'],
  ['PrivilegedHelperTools', 'Helper Tool', 'id'],
  ['Extensions', 'System Extension', 'name'],
  ['StartupItems', 'Startup Item', 'name']
];

// Read a value from an app bundle's Info.plist via `defaults` (handles binary plists).
async function readPlistValue(appPath, key) {
  try {
    const { stdout } = await execFileAsync('defaults', ['read', `${appPath}/Contents/Info`, key]);
    const value = stdout.trim();
    return value || null;
  } catch (e) {
    return null;
  }
}

// Derive vendor/app tokens from a bundleId. `com.google.Chrome` -> ["google","chrome"].
// Reverse-DNS prefixes (com/org/io/net/...) are dropped; an Apple-style team prefix
// like `2BUA8C4S2C.com.agilebits.onepassword` keeps the team id as the first token.
function bundleTokens(bundleId) {
  if (!bundleId) return [];
  const tlds = new Set(['com', 'org', 'io', 'net', 'co', 'me', 'app', 'dev', 'us']);
  return bundleId
    .split('.')
    .filter((seg, i) => !(i === 0 && tlds.has(seg.toLowerCase())))
    .map((s) => s.toLowerCase())
    .filter(Boolean);
}

function entryMatches(name, bundleId, appName, exec, mode) {
  const hasId = Boolean(bundleId);
  switch (mode) {
    case 'name': return name === appName || (hasId && name === bundleId) || (Boolean(exec) && name === exec);
    case 'id': return hasId && name === bundleId;
    case 'group': return hasId && name.includes(bundleId);
    case 'pref': return hasId && (name === `${bundleId}.plist` || name.startsWith(`${bundleId}.`));
    case 'saved': return hasId && name === `${bundleId}.savedState`;
    case 'cookie': return hasId && name === `${bundleId}.binarycookies`;
    default: return false;
  }
}

async function pushLeftover(fullPath, name, label, needsAdmin, out, seen) {
  if (seen.has(fullPath)) return;
  seen.add(fullPath);
  let size = 0;
  try {
    const stats = await fs.lstat(fullPath);
    size = stats.isDirectory() ? await getFolderSizeFast(fullPath, { cancelled: false }) : stats.size;
  } catch (e) {}
  out.push({ path: fullPath, name, size, category: label, isApp: false, needsAdmin });
}

async function scanDomain(dir, label, mode, ctx, needsAdmin, out, seen) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (e) {
    return;
  }
  for (const entry of entries) {
    if (entryMatches(entry.name, ctx.bundleId, ctx.appName, ctx.exec, mode)) {
      await pushLeftover(path.join(dir, entry.name), entry.name, label, needsAdmin, out, seen);
      continue;
    }
    // Vendor-nested: when scanning a "name" domain, also descend one level into a
    // folder whose name matches a bundleId token (vendor) and look for an inner
    // folder matching the app name or a later token. AppCleaner does the same —
    // catches Chrome at ~/Library/Application Support/Google/Chrome.
    if (mode !== 'name' || !entry.isDirectory() || ctx.tokens.length === 0) continue;
    const lname = entry.name.toLowerCase();
    if (!ctx.tokens.includes(lname)) continue;
    let inner;
    try {
      inner = await fs.readdir(path.join(dir, entry.name), { withFileTypes: true });
    } catch (e) {
      continue;
    }
    for (const sub of inner) {
      if (!sub.isDirectory()) continue;
      const lsub = sub.name.toLowerCase();
      const matches = lsub === ctx.appName.toLowerCase() ||
                      ctx.tokens.slice(1).includes(lsub) ||
                      lsub === ctx.tokens[ctx.tokens.length - 1];
      if (!matches) continue;
      const sp = path.join(dir, entry.name, sub.name);
      await pushLeftover(sp, `${entry.name}/${sub.name}`, label, needsAdmin, out, seen);
    }
  }
}

async function collectApps(dir, apps, depth) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (e) {
    return;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.name.endsWith('.app')) {
      const bundleId = await readPlistValue(fullPath, 'CFBundleIdentifier');
      const version = await readPlistValue(fullPath, 'CFBundleShortVersionString');
      const size = await getFolderSizeFast(fullPath, { cancelled: false });
      apps.push({
        name: entry.name.replace(/\.app$/, ''),
        path: fullPath,
        bundleId: bundleId || '',
        version: version || '',
        size
      });
    } else if (entry.isDirectory() && depth < 1) {
      await collectApps(fullPath, apps, depth + 1);
    }
  }
}

// Relaxed safety check for uninstall: allow .app bundles + Library leftovers,
// never critical roots or whole Library subdomain directories.
function isSafeToUninstall(targetPath, home) {
  const resolved = path.resolve(targetPath);
  const forbidden = ['/', '/System', '/Library', '/Applications', '/Users', '/usr', '/bin', '/sbin', '/etc', '/var', '/private', '/opt', '/cores', '/dev'];
  if (forbidden.includes(resolved)) return false;
  if (resolved === home || resolved === path.join(home, 'Library') || resolved === path.join(home, 'Applications')) return false;

  const userLib = path.join(home, 'Library');
  for (const [sub] of [...LIBRARY_DOMAINS, ...SYSTEM_DOMAINS]) {
    if (resolved === path.join(userLib, sub) || resolved === path.join('/Library', sub)) return false;
  }

  if (resolved.endsWith('.app') && (resolved.startsWith('/Applications' + path.sep) || resolved.startsWith(path.join(home, 'Applications') + path.sep))) {
    return true;
  }
  if (resolved.includes(path.sep + 'Library' + path.sep)) return true;
  return false;
}

// List installed applications
app.get('/api/applications', async (req, res) => {
  if (process.platform !== 'darwin') {
    return res.json([]);
  }
  try {
    const apps = [];
    const roots = ['/Applications', path.join(os.homedir(), 'Applications')];
    for (const root of roots) {
      if (existsSync(root)) await collectApps(root, apps, 0);
    }
    const seen = new Set();
    const unique = apps.filter((a) => (seen.has(a.path) ? false : (seen.add(a.path), true)));
    unique.sort((a, b) => b.size - a.size);
    res.json(unique);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Find an app's leftover files across Library domains
app.post('/api/app-leftovers', async (req, res) => {
  const { appPath } = req.body;
  if (!appPath || !existsSync(appPath)) {
    return res.status(400).json({ error: 'Application does not exist' });
  }
  if (!appPath.endsWith('.app')) {
    return res.status(400).json({ error: 'Selected path is not an application bundle' });
  }

  try {
    const appName = path.basename(appPath).replace(/\.app$/, '');
    const bundleId = (await readPlistValue(appPath, 'CFBundleIdentifier')) || '';
    const version = (await readPlistValue(appPath, 'CFBundleShortVersionString')) || '';
    const exec = (await readPlistValue(appPath, 'CFBundleExecutable')) || '';
    const appSize = await getFolderSizeFast(appPath, { cancelled: false });
    const ctx = { bundleId, appName, exec, tokens: bundleTokens(bundleId) };
    const seen = new Set([appPath]);

    const items = [{
      path: appPath,
      name: `${appName}.app`,
      size: appSize,
      category: 'Application',
      isApp: true,
      needsAdmin: appPath.startsWith('/Applications' + path.sep)
    }];

    const home = os.homedir();
    const userLib = path.join(home, 'Library');
    for (const [sub, label, mode] of LIBRARY_DOMAINS) {
      await scanDomain(path.join(userLib, sub), label, mode, ctx, false, items, seen);
    }
    for (const [sub, label, mode] of [...LIBRARY_DOMAINS, ...SYSTEM_DOMAINS]) {
      await scanDomain(path.join('/Library', sub), label, mode, ctx, true, items, seen);
    }

    const totalSize = items.reduce((sum, i) => sum + i.size, 0);
    res.json({ app: { name: appName, path: appPath, bundleId, version, size: appSize }, items, totalSize });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Permanently remove an app + its selected leftovers
app.post('/api/uninstall', async (req, res) => {
  const { paths } = req.body;
  if (!paths || !Array.isArray(paths) || paths.length === 0) {
    return res.status(400).json({ error: 'No paths provided for uninstall' });
  }

  const home = os.homedir();
  const results = [];
  let spaceFreed = 0;

  for (const targetPath of paths) {
    const resolved = path.resolve(targetPath);

    if (!existsSync(resolved)) {
      results.push({ path: targetPath, status: 'skipped', size: 0, reason: 'Path does not exist' });
      continue;
    }
    if (!isSafeToUninstall(resolved, home)) {
      results.push({ path: targetPath, status: 'error', size: 0, reason: 'Protected location — refused' });
      continue;
    }

    try {
      const stats = await fs.lstat(resolved);
      const isDir = stats.isDirectory();
      const size = isDir ? await getFolderSizeFast(resolved, { cancelled: false }) : stats.size;

      if (isDir) {
        await fs.rm(resolved, { recursive: true, force: true });
      } else {
        await fs.unlink(resolved);
      }

      spaceFreed += size;
      results.push({ path: targetPath, status: 'success', size, reason: '' });
    } catch (err) {
      const reason = (err.code === 'EACCES' || err.code === 'EPERM')
        ? 'Permission denied — requires admin privileges'
        : err.message;
      results.push({ path: targetPath, status: 'error', size: 0, reason });
    }
  }

  res.json({ message: 'Uninstall completed', results, spaceFreed });
});

// Reveal a path in the OS file manager. Useful in desktop builds; in web mode
// this runs on the server host, so it generally won't open anything visible
// to the user — the frontend only calls it from a Tauri context.
app.post('/api/reveal', async (req, res) => {
  const { targetPath } = req.body;
  if (!targetPath || !existsSync(targetPath)) {
    return res.status(400).json({ error: 'Path does not exist' });
  }
  try {
    if (process.platform === 'darwin') {
      await execFileAsync('open', ['-R', targetPath]);
    } else if (process.platform === 'win32') {
      await execFileAsync('explorer', [`/select,${targetPath}`]).catch(() => {});
    } else {
      const stats = await fs.lstat(targetPath);
      const dir = stats.isDirectory() ? targetPath : path.dirname(targetPath);
      await execFileAsync('xdg-open', [dir]);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Helper: stream a file through SHA-256
function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

// Find duplicate files inside a directory.
// Groups by size first, then confirms duplicates with SHA-256.
app.post('/api/duplicates', async (req, res) => {
  const { scanPath, minSize = 1024 } = req.body;
  const targetPath = scanPath ? path.resolve(scanPath) : os.homedir();

  if (!existsSync(targetPath)) {
    return res.status(400).json({ error: 'Target path does not exist' });
  }

  const filesBySize = new Map(); // size -> [{path, size, mtime}]
  const home = os.homedir();

  async function collectFiles(dir) {
    if (isExcluded(dir, home, targetPath)) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      return;
    }

    for (const entry of entries) {
      if (scanState.cancelled) return;
      const fullPath = path.join(dir, entry.name);
      if (isExcluded(fullPath, home, targetPath) || entry.isSymbolicLink()) continue;

      if (entry.isDirectory()) {
        await collectFiles(fullPath);
      } else if (entry.isFile()) {
        try {
          const stats = await fs.lstat(fullPath);
          if (stats.size < minSize) continue;
          const list = filesBySize.get(stats.size) || [];
          list.push({ path: fullPath, size: stats.size, updatedAt: stats.mtime });
          filesBySize.set(stats.size, list);
        } catch (e) {}
      }
    }
  }

  try {
    await collectFiles(targetPath);

    const duplicateGroups = [];
    for (const [, candidates] of filesBySize) {
      if (candidates.length < 2) continue;

      const hashes = new Map(); // hash -> [file objects]
      for (const file of candidates) {
        try {
          const h = await hashFile(file.path);
          const list = hashes.get(h) || [];
          list.push(file);
          hashes.set(h, list);
        } catch (e) {}
      }

      for (const group of hashes.values()) {
        if (group.length >= 2) {
          group.sort((a, b) => a.path.localeCompare(b.path));
          duplicateGroups.push({
            size: group[0].size,
            count: group.length,
            wastedSpace: group[0].size * (group.length - 1),
            files: group
          });
        }
      }
    }

    duplicateGroups.sort((a, b) => b.wastedSpace - a.wastedSpace);
    res.json({ groups: duplicateGroups, totalWasted: duplicateGroups.reduce((s, g) => s + g.wastedSpace, 0) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Serve static frontend files in production
const distPath = path.resolve('dist');
if (existsSync(distPath)) {
  app.use(express.static(distPath));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) {
      return next();
    }
    res.sendFile(path.join(distPath, 'index.html'));
  });
}

// Start server only when this module is run directly (not imported for tests)
let server = null;
if (import.meta.url === `file://${process.argv[1]}`) {
  server = app.listen(PORT, () => {
    console.log(`Backend server is running on http://localhost:${PORT}`);
  });
}

// Export helpers for unit testing
export { isSafeToDelete, isExcluded, app, server };
