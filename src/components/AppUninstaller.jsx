import React, { useEffect, useMemo, useState } from 'react';
import { apiInvoke } from '../utils/api';
import { formatBytes } from './DiskGauge';

/**
 * App Uninstaller (macOS) — AppCleaner-style.
 * Pick an installed app, discover every leftover file it scattered across the
 * Library domains (caches, preferences, containers, logs, launch agents, ...),
 * then permanently purge the app plus the selected leftovers in one pass.
 */
export default function AppUninstaller({ onUninstalled }) {
  const [apps, setApps] = useState([]);
  const [loadingApps, setLoadingApps] = useState(false);
  const [appsError, setAppsError] = useState(null);
  const [search, setSearch] = useState('');

  const [selectedApp, setSelectedApp] = useState(null);
  const [leftovers, setLeftovers] = useState(null);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState(null);
  const [checked, setChecked] = useState(new Set()); // set of paths

  const [showConfirm, setShowConfirm] = useState(false);
  const [uninstalling, setUninstalling] = useState(false);
  const [report, setReport] = useState(null);

  const fetchApps = async () => {
    setLoadingApps(true);
    setAppsError(null);
    try {
      const data = await apiInvoke('list_applications');
      setApps(Array.isArray(data) ? data : []);
    } catch (err) {
      setAppsError(err.message || String(err));
    } finally {
      setLoadingApps(false);
    }
  };

  useEffect(() => {
    fetchApps();
  }, []);

  const filteredApps = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return apps;
    return apps.filter(
      (a) => a.name.toLowerCase().includes(q) || (a.bundleId || '').toLowerCase().includes(q)
    );
  }, [apps, search]);

  const selectApp = async (app) => {
    setSelectedApp(app);
    setLeftovers(null);
    setScanError(null);
    setScanning(true);
    setReport(null);
    try {
      const data = await apiInvoke('find_app_leftovers', { appPath: app.path });
      setLeftovers(data);
      // Default: select everything (matches AppCleaner behaviour).
      setChecked(new Set(data.items.map((i) => i.path)));
    } catch (err) {
      setScanError(err.message || String(err));
    } finally {
      setScanning(false);
    }
  };

  const toggleItem = (itemPath) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(itemPath)) next.delete(itemPath);
      else next.add(itemPath);
      return next;
    });
  };

  const selectedItems = useMemo(
    () => (leftovers ? leftovers.items.filter((i) => checked.has(i.path)) : []),
    [leftovers, checked]
  );
  const selectedSize = selectedItems.reduce((sum, i) => sum + i.size, 0);

  const handleUninstall = async () => {
    setShowConfirm(false);
    setUninstalling(true);
    try {
      const paths = selectedItems.map((i) => i.path);
      const data = await apiInvoke('uninstall_paths', { paths });
      setReport(data);
      setLeftovers(null);
      setSelectedApp(null);
      setChecked(new Set());
      await fetchApps();
      if (onUninstalled) onUninstalled();
    } catch (err) {
      setReport({ message: 'Uninstall failed', results: [{ path: '', status: 'error', reason: err.message || String(err), size: 0 }], spaceFreed: 0 });
    } finally {
      setUninstalling(false);
    }
  };

  const adminCount = selectedItems.filter((i) => i.needsAdmin).length;

  return (
    <div className="uninstaller">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
        <h3 style={{ fontFamily: 'var(--font-heading)' }}>🗑️ App Uninstaller</h3>
        <button className="btn" onClick={fetchApps} style={{ fontSize: '0.8rem', padding: '0.4rem 0.8rem' }}>
          🔄 Reload Apps
        </button>
      </div>

      <div className="uninstaller-grid">
        {/* App list */}
        <div className="uninstaller-list">
          <input
            type="text"
            className="path-input"
            placeholder="Search applications..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ marginBottom: '0.75rem', width: '100%' }}
          />

          {loadingApps && (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.75rem', padding: '2rem 0' }}>
              <div className="spinner" style={{ width: '28px', height: '28px' }} />
              <span style={{ color: 'var(--text-secondary)' }}>Scanning applications...</span>
            </div>
          )}

          {appsError && (
            <div style={{ color: 'var(--color-danger)', padding: '1rem', textAlign: 'center' }}>
              {appsError}
              <br />
              <button className="btn" onClick={fetchApps} style={{ marginTop: '0.75rem' }}>Retry</button>
            </div>
          )}

          {!loadingApps && !appsError && filteredApps.length === 0 && (
            <div style={{ color: 'var(--text-secondary)', padding: '1.5rem', textAlign: 'center', fontSize: '0.85rem' }}>
              No applications found. (App uninstaller is macOS-only.)
            </div>
          )}

          <div className="uninstaller-app-rows">
            {filteredApps.map((app) => (
              <div
                key={app.path}
                className={`uninstaller-app-row ${selectedApp && selectedApp.path === app.path ? 'active' : ''}`}
                onClick={() => selectApp(app)}
              >
                <div style={{ overflow: 'hidden' }}>
                  <div className="uninstaller-app-name">{app.name}</div>
                  <div className="uninstaller-app-meta" title={app.bundleId}>
                    {app.bundleId || 'no bundle id'}{app.version ? ` · v${app.version}` : ''}
                  </div>
                </div>
                <span className="uninstaller-app-size">{formatBytes(app.size)}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Detail / leftovers */}
        <div className="uninstaller-detail">
          {!selectedApp && (
            <div style={{ color: 'var(--text-secondary)', textAlign: 'center', padding: '3rem 1rem' }}>
              Select an application to find its leftover files.
            </div>
          )}

          {scanning && (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.75rem', padding: '3rem 0' }}>
              <div className="spinner" style={{ width: '28px', height: '28px' }} />
              <span style={{ color: 'var(--text-secondary)' }}>Finding leftover files for {selectedApp.name}...</span>
            </div>
          )}

          {scanError && (
            <div style={{ color: 'var(--color-danger)', padding: '1rem', textAlign: 'center' }}>{scanError}</div>
          )}

          {leftovers && !scanning && (
            <>
              <div className="uninstaller-detail-header">
                <div>
                  <div className="uninstaller-app-name" style={{ fontSize: '1.05rem' }}>{leftovers.app.name}</div>
                  <div className="uninstaller-app-meta">
                    {leftovers.items.length} item(s) found · {formatBytes(leftovers.totalSize)} total
                  </div>
                </div>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <button className="btn" style={{ fontSize: '0.75rem', padding: '0.3rem 0.6rem' }} onClick={() => setChecked(new Set(leftovers.items.map((i) => i.path)))}>
                    Select all
                  </button>
                  <button className="btn" style={{ fontSize: '0.75rem', padding: '0.3rem 0.6rem' }} onClick={() => setChecked(new Set())}>
                    Clear
                  </button>
                </div>
              </div>

              <div className="uninstaller-items">
                {leftovers.items.map((item) => {
                  const isChecked = checked.has(item.path);
                  return (
                    <div
                      key={item.path}
                      className={`uninstaller-item ${isChecked ? 'selected' : ''}`}
                      onClick={() => toggleItem(item.path)}
                    >
                      <div className="checkbox-wrapper">
                        <div className={`custom-checkbox ${isChecked ? 'checked' : ''}`} />
                      </div>
                      <div style={{ flex: 1, overflow: 'hidden' }}>
                        <div className="uninstaller-item-name">
                          {item.isApp ? '📦' : '📄'} {item.name}
                          <span className="uninstaller-tag">{item.category}</span>
                          {item.needsAdmin && <span className="uninstaller-tag admin">admin</span>}
                        </div>
                        <div className="uninstaller-item-path" title={item.path}>{item.path}</div>
                      </div>
                      <span className="uninstaller-app-size">{formatBytes(item.size)}</span>
                    </div>
                  );
                })}
              </div>

              <div className="uninstaller-actions">
                <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                  {selectedItems.length} selected · <strong className="space-to-free">{formatBytes(selectedSize)}</strong>
                  {adminCount > 0 && (
                    <span style={{ color: 'var(--color-warning)', marginLeft: '0.5rem' }}>
                      ({adminCount} need admin)
                    </span>
                  )}
                </div>
                <button
                  className="btn btn-danger"
                  disabled={uninstalling || selectedItems.length === 0}
                  onClick={() => setShowConfirm(true)}
                >
                  {uninstalling ? 'Uninstalling...' : '🧨 Uninstall & Purge'}
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Confirm modal */}
      {showConfirm && (
        <div className="modal-overlay">
          <div className="modal-content">
            <div className="modal-header">⚠️ Confirm Permanent Uninstall</div>
            <div className="modal-body">
              <p>Permanently delete <strong>{selectedItems.length}</strong> item(s) for <strong>{selectedApp?.name}</strong>?</p>
              <div className="danger-text-box">
                <strong>Crucial Warning:</strong> Files are purged immediately (bypassing the Trash) and CANNOT be recovered.
                {adminCount > 0 && ` ${adminCount} system item(s) may fail without admin privileges.`}
              </div>
              <p>Estimated reclaimed space: <strong>{formatBytes(selectedSize)}</strong></p>
            </div>
            <div className="modal-footer">
              <button className="btn" onClick={() => setShowConfirm(false)}>Cancel</button>
              <button className="btn btn-danger" onClick={handleUninstall}>Yes, Purge Everything</button>
            </div>
          </div>
        </div>
      )}

      {/* Report modal */}
      {report && (
        <div className="modal-overlay">
          <div className="modal-content" style={{ maxWidth: '600px' }}>
            <div className="modal-header">✅ Uninstall Report</div>
            <div className="modal-body" style={{ maxHeight: '400px', overflowY: 'auto' }}>
              <p>Reclaimed <strong>{formatBytes(report.spaceFreed)}</strong> of disk space.</p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginTop: '1rem' }}>
                {report.results.map((res, i) => (
                  <div
                    key={i}
                    style={{
                      fontSize: '0.82rem',
                      display: 'flex',
                      justifyContent: 'space-between',
                      gap: '1rem',
                      background: 'rgba(0,0,0,0.2)',
                      padding: '0.4rem 0.6rem',
                      borderRadius: '4px',
                      borderLeft: `3px solid ${res.status === 'success' ? 'var(--color-success)' : res.status === 'skipped' ? 'var(--color-warning)' : 'var(--color-danger)'}`
                    }}
                  >
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }} title={res.path}>
                      {res.path || '—'}
                    </span>
                    <span style={{ fontWeight: 'bold', whiteSpace: 'nowrap' }}>
                      {res.status === 'success' ? `Freed ${formatBytes(res.size)}` : res.status === 'skipped' ? 'Skipped' : `Error: ${res.reason}`}
                    </span>
                  </div>
                ))}
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-primary" onClick={() => setReport(null)}>Done</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
