import React, { useState, useEffect } from 'react';
import { apiInvoke, apiListen, isTauri } from './utils/api';
import DiskGauge, { formatBytes } from './components/DiskGauge';
import DisksOverview from './components/DisksOverview';
import SmartScanList from './components/SmartScanList';
import FileTree from './components/FileTree';
import LargestFiles from './components/LargestFiles';
import TerminalConsole from './components/TerminalConsole';
import AppUninstaller from './components/AppUninstaller';
import DuplicatesFinder from './components/DuplicatesFinder';

export default function App() {
  // Tabs: 'smart', 'explorer', 'largest'
  const [activeTab, setActiveTab] = useState('smart');
  
  // Disk Space State
  const [diskSpace, setDiskSpace] = useState({
    total: 0,
    used: 0,
    available: 0,
    other: 0,
    percentage: 0,
    homeDir: ''
  });

  // Scan Controls State
  const [scanPath, setScanPath] = useState('');
  const [scanning, setScanning] = useState(false);
  const [scanProgress, setScanProgress] = useState({
    active: false,
    currentPath: '',
    foldersScanned: 0,
    filesScanned: 0,
    totalSizeCalculated: 0,
    permissionErrors: 0
  });

  // Scan Results
  const [treeData, setTreeData] = useState(null);
  const [topFiles, setTopFiles] = useState([]);
  const [lastScannedPath, setLastScannedPath] = useState('');
  const [scanErrors, setScanErrors] = useState(0);

  const exportToJson = (data, filename) => {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  const exportTopFilesToCsv = (files, filename) => {
    const rows = [
      ['Name', 'Path', 'Size (bytes)', 'Size (human)', 'Modified'],
      ...files.map(f => [
        f.name,
        f.path,
        f.size,
        formatBytes(f.size),
        f.updatedAt ? new Date(f.updatedAt).toISOString() : ''
      ])
    ];
    const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Selection Drawer State
  const [selectedPaths, setSelectedPaths] = useState(new Map()); // Path -> Size
  const [isDryRun, setIsDryRun] = useState(false);
  const [showConfirmModal, setShowConfirmModal] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deletionSummary, setDeletionSummary] = useState(null);
  const [smartRefresh, setSmartRefresh] = useState(0);

  // Docker Integration
  const [dockerLog, setDockerLog] = useState('');
  const [dockerLoading, setDockerLoading] = useState(false);

  // Elapsed time tracker for scanning
  const [elapsedTime, setElapsedTime] = useState(0);
  useEffect(() => {
    let interval = null;
    if (scanning) {
      const startTime = Date.now();
      setElapsedTime(0);
      interval = setInterval(() => {
        setElapsedTime(Math.floor((Date.now() - startTime) / 1000));
      }, 1000);
    }
    return () => {
      if (interval) clearInterval(interval);
    };
  }, [scanning]);

  const formatTime = (seconds) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
  };

  // Load disk space on mount
  useEffect(() => {
    fetchDiskSpace();
  }, []);

  // Listen to scan progress from Tauri backend
  useEffect(() => {
    let unlisten = null;
    const setupListener = async () => {
      unlisten = await apiListen('scan-progress', (data) => {
        setScanProgress(data);
        if (!data.active) {
          setScanning(false);
          if (!data.cancelled && !data.error) {
            fetchScanResults();
          }
        }
      });
    };
    setupListener();
    return () => {
      if (unlisten) {
        unlisten();
      }
    };
  }, []);

  const fetchDiskSpace = async () => {
    try {
      const data = await apiInvoke('get_disk_space');
      setDiskSpace(data);
      if (!scanPath) {
        setScanPath(data.homeDir);
      }
    } catch (err) {
      console.error('Error fetching disk space:', err);
    }
  };

  const handleStartScan = async () => {
    if (!scanPath.trim()) return;
    setScanning(true);
    setTreeData(null);
    setTopFiles([]);
    setScanErrors(0);
    setSelectedPaths(new Map());

    try {
      await apiInvoke('start_scan', { scanPath });
      setLastScannedPath(scanPath);
    } catch (err) {
      alert(`Error starting scan: ${err}`);
      setScanning(false);
    }
  };

  const handleCancelScan = async () => {
    try {
      await apiInvoke('cancel_scan');
    } catch (e) {
      console.error('Cancel scan error:', e);
    }
  };

  const fetchScanResults = async () => {
    try {
      const data = await apiInvoke('get_scan_results');
      setTreeData(data.tree);
      setTopFiles(data.topFiles);
      setScanErrors(data.permissionErrors || 0);
      // Switch to tree tab once scan completes so user sees detail
      setActiveTab('explorer');
    } catch (err) {
      console.error('Error fetching scan results:', err);
    }
  };

  // Selection helper with recursive parent-child propagation
  const selectPathAndChildren = (targetPath, tree, selectedMap, checkState) => {
    const node = tree[targetPath];
    if (checkState) {
      selectedMap.set(targetPath, node ? node.size : 0);
    } else {
      selectedMap.delete(targetPath);
    }
    
    if (node && node.children) {
      node.children.forEach(child => {
        if (child.isDirectory && tree[child.path]) {
          selectPathAndChildren(child.path, tree, selectedMap, checkState);
        } else {
          if (checkState) {
            selectedMap.set(child.path, child.size);
          } else {
            selectedMap.delete(child.path);
          }
        }
      });
    }
  };

  const uncheckAncestors = (targetPath, selectedMap) => {
    let current = targetPath;
    while (current.includes('/')) {
      const parentPath = current.substring(0, current.lastIndexOf('/'));
      if (selectedMap.has(parentPath)) {
        selectedMap.delete(parentPath);
      }
      current = parentPath;
    }
  };

  const togglePathSelection = (path, size) => {
    if (!treeData) {
      const next = new Map(selectedPaths);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.set(path, size);
      }
      setSelectedPaths(next);
      return;
    }

    const next = new Map(selectedPaths);
    const isCurrentlyChecked = next.has(path);
    const shouldCheck = !isCurrentlyChecked;

    selectPathAndChildren(path, treeData, next, shouldCheck);

    if (!shouldCheck) {
      uncheckAncestors(path, next);
    }

    setSelectedPaths(next);
  };

  const getMinimizedPaths = (pathsMap) => {
    const rawPaths = Array.from(pathsMap.keys());
    const sorted = [...rawPaths].sort((a, b) => a.length - b.length);
    const minimized = [];
    for (const p of sorted) {
      const hasParent = minimized.some(parent => p.startsWith(parent + '/'));
      if (!hasParent) {
        minimized.push(p);
      }
    }
    return minimized;
  };

  const getSelectionTotalSize = () => {
    const minimized = getMinimizedPaths(selectedPaths);
    let sum = 0;
    minimized.forEach((path) => {
      sum += selectedPaths.get(path) || 0;
    });
    return sum;
  };

  // Perform backend deletion
  const handleDeleteConfirm = async () => {
    setIsDeleting(true);
    setShowConfirmModal(false);
    
    const pathsToDelete = getMinimizedPaths(selectedPaths);

    if (isDryRun) {
      // Simulation
      setTimeout(() => {
        setDeletionSummary({
          spaceFreed: getSelectionTotalSize(),
          results: pathsToDelete.map(p => ({ path: p, status: 'simulated', size: selectedPaths.get(p) }))
        });
        setSelectedPaths(new Map());
        setIsDeleting(false);
      }, 1500);
      return;
    }

    try {
      const data = await apiInvoke('delete_paths', { paths: pathsToDelete });
      
      setDeletionSummary(data);
      setSelectedPaths(new Map());
      
      // Update disk values
      await fetchDiskSpace();
      
      // Reload recommendations size
      setSmartRefresh(prev => prev + 1);

      // Remove deleted nodes from active tree data if present
      if (treeData) {
        const nextTree = { ...treeData };
        pathsToDelete.forEach((p) => {
          delete nextTree[p];
          // Remove child links
          const parentDir = p.substring(0, p.lastIndexOf('/'));
          if (nextTree[parentDir]) {
            nextTree[parentDir].children = nextTree[parentDir].children.filter(c => c.path !== p);
          }
        });
        setTreeData(nextTree);
      }

      // Filter from top files
      setTopFiles(prev => prev.filter(f => !pathsToDelete.includes(f.path)));

    } catch (err) {
      alert(`Deletion failed: ${err}`);
    } finally {
      setIsDeleting(false);
    }
  };

  // Docker Prune CLI trigger
  const runDockerPrune = async () => {
    setDockerLoading(true);
    setDockerLog('Running docker system prune -af --volumes...\n');
    try {
      const data = await apiInvoke('run_docker_prune');
      if (!data.success) {
        setDockerLog(`Error: ${data.error || 'Unknown error'}\nDetails: ${data.log || ''}`);
      } else {
        setDockerLog(data.log);
        // Refresh space
        await fetchDiskSpace();
      }
    } catch (err) {
      setDockerLog(`Error calling Docker prune: ${err}`);
    } finally {
      setDockerLoading(false);
    }
  };

  return (
    <div className="app-container">
      {/* Header */}
      <header className="app-header">
        <div className="header-title-group">
          <h1><span>💾</span> disked</h1>
          <p>Local disk inspector, server cleanup & developer cache cleaner</p>
        </div>
        <div className="header-actions" style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
          {!isTauri() && (
            <a 
              href="https://github.com/afstudy20-gif/disked/releases" 
              target="_blank" 
              rel="noopener noreferrer"
              className="btn"
              style={{ 
                display: 'inline-flex', 
                alignItems: 'center', 
                gap: '0.3rem', 
                textDecoration: 'none', 
                background: 'var(--primary-color, #3b82f6)',
                color: '#fff',
                borderColor: 'transparent'
              }}
            >
              📥 Download Desktop App
            </a>
          )}
          <button className="btn" onClick={fetchDiskSpace}>
            🔄 Refresh Disk
          </button>
        </div>
      </header>

      {/* Main Grid */}
      <div className="dashboard-grid">
        {/* Left Column: Stats and Scanner Controls */}
        <div className="left-column">
          <DiskGauge
            total={diskSpace.total}
            used={diskSpace.used}
            available={diskSpace.available}
            other={diskSpace.other}
            percentage={diskSpace.percentage}
            reclaimSize={getSelectionTotalSize()}
          />

          <DisksOverview />

          {/* Scanner Controls Card */}
          <div className="card scanner-controls">
            <h3>Directory Scanner</h3>
            <div className="path-input-group">
              <input 
                type="text" 
                className="path-input" 
                value={scanPath} 
                onChange={(e) => setScanPath(e.target.value)} 
                placeholder="/path/to/scan"
                disabled={scanning}
              />
              <button 
                className="btn btn-primary" 
                onClick={handleStartScan}
                disabled={scanning || !scanPath}
              >
                Scan
              </button>
            </div>
            
            {/* Active scan log card */}
            {scanning && (
              <div className="scan-progress-box">
                <div className="scan-progress-header">
                  <span className="scan-progress-title">
                    <div className="spinner"></div> Scanning Files ({formatTime(elapsedTime)})
                  </span>
                  <button className="btn btn-danger" style={{ padding: '0.2rem 0.5rem', fontSize: '0.75rem' }} onClick={handleCancelScan}>
                    Cancel
                  </button>
                </div>
                <div className="scan-progress-stats">
                  <div>Folders: {scanProgress.foldersScanned.toLocaleString()}</div>
                  <div>Files: {scanProgress.filesScanned.toLocaleString()}</div>
                  <div style={{ gridColumn: 'span 2' }}>
                    Calculated: <strong>{formatBytes(scanProgress.totalSizeCalculated)}</strong>
                  </div>
                </div>
                <div className="scan-progress-current-path" title={scanProgress.currentPath}>
                  {scanProgress.currentPath}
                </div>
                {(scanProgress.permissionErrors > 0 || scanErrors > 0) && (
                  <div className="scan-error-banner" style={{
                    marginTop: '0.75rem',
                    padding: '0.5rem 0.75rem',
                    background: 'rgba(245, 158, 11, 0.1)',
                    border: '1px solid rgba(245, 158, 11, 0.3)',
                    borderRadius: '6px',
                    color: '#fbbf24',
                    fontSize: '0.82rem'
                  }}>
                    ⚠️ {(scanProgress.permissionErrors || scanErrors).toLocaleString()} location(s) could not be read (permission denied). Results may be incomplete.
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Docker cleanup integration */}
          <div className="card docker-card">
            <div className="docker-status-header">
              <h3>Docker Prune</h3>
              <span className={`docker-badge running`}>CLI Integrator</span>
            </div>
            <p className="docker-info-text">
              Removes unused volumes, containers, networks, and untagged images. Excellent for Docker VM disk blowup.
            </p>
            <button 
              className="btn btn-danger" 
              onClick={runDockerPrune} 
              disabled={dockerLoading}
              style={{ width: '100%', justifyContent: 'center' }}
            >
              {dockerLoading ? 'Cleaning...' : 'Prune Unused Docker Data'}
            </button>
            {dockerLog && (
              <pre className="docker-log-pre">{dockerLog}</pre>
            )}
          </div>
        </div>

        {/* Right Column: Interactive Scan Inspector */}
        <div className="right-column">
          <div className="card" style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
            <div className="view-tabs">
              <button 
                className={`tab-btn ${activeTab === 'smart' ? 'active' : ''}`}
                onClick={() => setActiveTab('smart')}
              >
                ⚡ Quick Clean Recommendations
              </button>
              <button 
                className={`tab-btn ${activeTab === 'explorer' ? 'active' : ''}`}
                onClick={() => setActiveTab('explorer')}
              >
                🌳 Folder tree Explorer
              </button>
              <button 
                className={`tab-btn ${activeTab === 'largest' ? 'active' : ''}`}
                onClick={() => setActiveTab('largest')}
              >
                🔥 Top 100 Largest Files
              </button>
              <button
                className={`tab-btn ${activeTab === 'terminal' ? 'active' : ''}`}
                onClick={() => setActiveTab('terminal')}
              >
                💻 Interactive Terminal
              </button>
              <button
                className={`tab-btn ${activeTab === 'uninstall' ? 'active' : ''}`}
                onClick={() => setActiveTab('uninstall')}
              >
                🗑️ App Uninstaller
              </button>
              <button
                className={`tab-btn ${activeTab === 'duplicates' ? 'active' : ''}`}
                onClick={() => setActiveTab('duplicates')}
              >
                🔄 Duplicates
              </button>
            </div>

            {/* Tab content */}
            <div style={{ flex: 1, marginTop: '1rem' }}>
              {activeTab === 'smart' && (
                <SmartScanList 
                  selectedPaths={selectedPaths}
                  togglePathSelection={togglePathSelection}
                  onRefreshTrigger={smartRefresh}
                />
              )}

              {activeTab === 'explorer' && (
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem', flexWrap: 'wrap', gap: '0.5rem' }}>
                    <span style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>
                      {treeData ? `${Object.keys(treeData).length} nodes loaded` : 'No scan data'}
                    </span>
                    <div style={{ display: 'flex', gap: '0.5rem' }}>
                      <button
                        className="btn"
                        style={{ fontSize: '0.78rem', padding: '0.35rem 0.6rem' }}
                        disabled={!treeData}
                        onClick={() => exportToJson({ tree: treeData, topFiles, scannedAt: new Date().toISOString() }, `disked-scan-${Date.now()}.json`)}
                      >
                        Export JSON
                      </button>
                      <button
                        className="btn"
                        style={{ fontSize: '0.78rem', padding: '0.35rem 0.6rem' }}
                        disabled={!topFiles?.length}
                        onClick={() => exportTopFilesToCsv(topFiles, `disked-top-files-${Date.now()}.csv`)}
                      >
                        Export CSV
                      </button>
                    </div>
                  </div>
                  <FileTree
                    treeData={treeData}
                    rootPath={lastScannedPath}
                    selectedPaths={selectedPaths}
                    togglePathSelection={togglePathSelection}
                  />
                </div>
              )}

              {activeTab === 'largest' && (
                <LargestFiles 
                  topFiles={topFiles}
                  selectedPaths={selectedPaths}
                  togglePathSelection={togglePathSelection}
                />
              )}

              {activeTab === 'terminal' && (
                <TerminalConsole />
              )}

              {activeTab === 'uninstall' && (
                <AppUninstaller onUninstalled={fetchDiskSpace} />
              )}

              {activeTab === 'duplicates' && (
                <DuplicatesFinder
                  scanPath={lastScannedPath || scanPath}
                  selectedPaths={selectedPaths}
                  togglePathSelection={togglePathSelection}
                />
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Floating Deletion Queue Drawer */}
      {selectedPaths.size > 0 && (
        <div className="deletion-drawer">
          <div className="drawer-left">
            <div className="drawer-title">
              🗑️ Move to Trash Queue ({getMinimizedPaths(selectedPaths).length} items)
            </div>
            <div className="drawer-sub">
              Total Space Reclaimed: <span className="space-to-free">{formatBytes(getSelectionTotalSize())}</span>
            </div>
          </div>

          <div className="drawer-right">
            <label className="switch-group">
              <input 
                type="checkbox" 
                className="switch-input" 
                checked={isDryRun} 
                onChange={(e) => setIsDryRun(e.target.checked)}
              />
              <span className="switch-slider"></span>
              <span>Dry Run (Simulation)</span>
            </label>

            <button 
              className="btn btn-danger" 
              onClick={() => setShowConfirmModal(true)}
              disabled={isDeleting}
            >
              {isDeleting ? 'Moving to Trash...' : 'Move Selected to Trash'}
            </button>
          </div>
        </div>
      )}

      {/* Confirmation Modal */}
      {showConfirmModal && (
        <div className="modal-overlay">
          <div className="modal-content">
            <div className="modal-header">
              ⚠️ Confirm Move to Trash
            </div>
            <div className="modal-body">
              <p>Are you sure you want to move these <strong>{selectedPaths.size}</strong> selected files/folders to the Trash?</p>
              <div className="danger-text-box">
                <strong>You can recover them:</strong> Items will be moved to the system Trash. Empty the Trash later to permanently free the space.
              </div>
              <p>Estimated space that will be reclaimed after emptying Trash: <strong>{formatBytes(getSelectionTotalSize())}</strong></p>
            </div>
            <div className="modal-footer">
              <button className="btn" onClick={() => setShowConfirmModal(false)}>
                Cancel
              </button>
              <button className="btn btn-danger" onClick={handleDeleteConfirm}>
                Yes, Move to Trash
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Deletion Summary Modal */}
      {deletionSummary && (
        <div className="modal-overlay">
          <div className="modal-content" style={{ maxWidth: '600px' }}>
            <div className="modal-header">
              ✅ Moved to Trash
            </div>
            <div className="modal-body" style={{ maxHeight: '400px', overflowY: 'auto' }}>
              <p>Successfully moved <strong>{formatBytes(deletionSummary.spaceFreed)}</strong> to Trash. Empty the Trash to permanently free the space.</p>
              <h4 style={{ marginTop: '1rem', marginBottom: '0.5rem' }}>Detailed Status:</h4>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                {deletionSummary.results.map((res, i) => (
                  <div 
                    key={i} 
                    style={{ 
                      fontSize: '0.82rem', 
                      display: 'flex', 
                      justifyContent: 'between', 
                      background: 'rgba(0,0,0,0.2)', 
                      padding: '0.4rem 0.6rem', 
                      borderRadius: '4px',
                      borderLeft: `3px solid ${res.status === 'success' || res.status === 'simulated' ? 'var(--color-success)' : 'var(--color-danger)'}`
                    }}
                  >
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, paddingRight: '1rem' }} title={res.path}>
                      {res.path}
                    </span>
                    <span style={{ fontWeight: 'bold' }}>
                      {res.status === 'success' ? `Moved ${formatBytes(res.size)} to Trash` : res.status === 'simulated' ? `Simulated ${formatBytes(res.size)}` : `Error: ${res.reason}`}
                    </span>
                  </div>
                ))}
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-primary" onClick={() => setDeletionSummary(null)}>
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
