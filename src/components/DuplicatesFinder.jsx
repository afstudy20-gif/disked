import React, { useState } from 'react';
import { apiInvoke } from '../utils/api';
import { formatBytes } from './DiskGauge';

export default function DuplicatesFinder({ scanPath, selectedPaths, togglePathSelection }) {
  const [groups, setGroups] = useState([]);
  const [totalWasted, setTotalWasted] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [minSize, setMinSize] = useState(1024);

  const findDuplicates = async () => {
    if (!scanPath) return;
    setLoading(true);
    setError(null);
    try {
      const data = await apiInvoke('find_duplicates', { scanPath, minSize });
      setGroups(data.groups || []);
      setTotalWasted(data.totalWasted || 0);
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setLoading(false);
    }
  };

  const toggleFile = (file) => {
    togglePathSelection(file.path, file.size);
  };

  const selectAllButFirst = (group) => {
    // Keep the first file (usually the oldest path alphabetically) and select the rest
    group.files.slice(1).forEach((file) => {
      if (!selectedPaths.has(file.path)) {
        togglePathSelection(file.path, file.size);
      }
    });
  };

  if (loading) {
    return (
      <div className="card" style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '200px' }}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1rem' }}>
          <div className="spinner" style={{ width: '30px', height: '30px' }}></div>
          <span style={{ color: 'var(--text-secondary)' }}>Scanning for duplicate files...</span>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem', flexWrap: 'wrap', gap: '1rem' }}>
        <div>
          <h3 style={{ fontFamily: 'var(--font-heading)' }}>Duplicate File Finder</h3>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginTop: '0.25rem' }}>
            Finds identical files by size and hash so you can safely remove extras.
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <label style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
            Min size:
            <select
              value={minSize}
              onChange={(e) => setMinSize(Number(e.target.value))}
              style={{ marginLeft: '0.5rem', background: 'rgba(0,0,0,0.25)', color: 'inherit', border: '1px solid var(--border-light)', borderRadius: '6px', padding: '0.3rem' }}
            >
              <option value={1024}>1 KB</option>
              <option value={10240}>10 KB</option>
              <option value={102400}>100 KB</option>
              <option value={1048576}>1 MB</option>
              <option value={10485760}>10 MB</option>
            </select>
          </label>
          <button className="btn btn-primary" onClick={findDuplicates}>
            🔍 Find Duplicates
          </button>
        </div>
      </div>

      {error && (
        <div className="card" style={{ color: 'var(--color-danger)', padding: '1rem', marginBottom: '1rem' }}>
          Error finding duplicates: {error}
        </div>
      )}

      {groups.length === 0 && !loading && !error && (
        <div className="no-results">
          <span className="no-results-icon">📁</span>
          <div>
            <strong>No duplicates found</strong>
            <div>Click "Find Duplicates" to scan {scanPath || 'the selected path'}.</div>
          </div>
        </div>
      )}

      {groups.length > 0 && (
        <div style={{ marginBottom: '1rem', padding: '0.75rem 1rem', background: 'rgba(99, 102, 241, 0.08)', borderRadius: '10px', border: '1px solid var(--border-focus)' }}>
          <strong>{groups.length}</strong> duplicate groups found. Potential space savings: <strong style={{ color: 'var(--color-success)' }}>{formatBytes(totalWasted)}</strong>
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        {groups.map((group, idx) => (
          <div key={idx} className="card" style={{ padding: '1rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
              <div>
                <span style={{ fontWeight: '600' }}>{group.count} identical files</span>
                <span style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginLeft: '0.75rem' }}>
                  {formatBytes(group.size)} each
                </span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                <span style={{ color: 'var(--color-success)', fontWeight: '600', fontSize: '0.9rem' }}>
                  Save {formatBytes(group.wastedSpace)}
                </span>
                <button className="btn" style={{ fontSize: '0.78rem', padding: '0.3rem 0.6rem' }} onClick={() => selectAllButFirst(group)}>
                  Keep First, Select Rest
                </button>
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
              {group.files.map((file, fidx) => {
                const isChecked = selectedPaths.has(file.path);
                return (
                  <div
                    key={fidx}
                    onClick={() => toggleFile(file)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '0.5rem 0.75rem',
                      borderRadius: '6px',
                      cursor: 'pointer',
                      background: isChecked ? 'rgba(99, 102, 241, 0.1)' : 'rgba(255,255,255,0.02)',
                      border: `1px solid ${isChecked ? 'var(--color-primary)' : 'var(--border-light)'}`,
                    }}
                  >
                    <span style={{ fontSize: '0.85rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }} title={file.path}>
                      {fidx === 0 && <span style={{ color: 'var(--color-success)', marginRight: '0.4rem' }}>★</span>}
                      {file.path}
                    </span>
                    <div className="checkbox-wrapper">
                      <div className={`custom-checkbox ${isChecked ? 'checked' : ''}`} />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
