import React, { useEffect, useState } from 'react';
import { apiInvoke } from '../utils/api';
import { formatBytes } from './DiskGauge';

/**
 * Physical disk layout viewer (AOMEI Partition Assistant style).
 * For every physical disk, render a segmented horizontal bar showing each
 * partition sized proportionally with a label beneath it.
 */
export default function DisksOverview() {
  const [disks, setDisks] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const fetchDisks = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiInvoke('get_disks_overview');
      setDisks(Array.isArray(data) ? data : []);
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchDisks();
  }, []);

  if (loading && !disks) {
    return (
      <div className="card disks-card">
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.75rem', padding: '2rem 0' }}>
          <div className="spinner" style={{ width: '28px', height: '28px' }} />
          <span style={{ color: 'var(--text-secondary)' }}>Reading disk layout...</span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="card disks-card">
        <div style={{ color: 'var(--color-danger)', padding: '1rem', textAlign: 'center' }}>
          {error}
          <br />
          <button className="btn" onClick={fetchDisks} style={{ marginTop: '0.75rem' }}>Retry</button>
        </div>
      </div>
    );
  }

  if (!disks || disks.length === 0) {
    return (
      <div className="card disks-card">
        <div style={{ color: 'var(--text-secondary)', padding: '2rem', textAlign: 'center' }}>
          No physical disks detected.
        </div>
      </div>
    );
  }

  return (
    <div className="card disks-card">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
        <h3 style={{ fontFamily: 'var(--font-heading)', margin: 0 }}>Disk Layout</h3>
        <button className="btn" onClick={fetchDisks} style={{ fontSize: '0.75rem', padding: '0.3rem 0.6rem' }}>
          🔄 Refresh
        </button>
      </div>

      <div className="disks-list">
        {disks.map((disk) => (
          <DiskRow key={disk.name} disk={disk} />
        ))}
      </div>
    </div>
  );
}

function DiskRow({ disk }) {
  const total = disk.total || 1;
  const pctClass = disk.percentage >= 90 ? 'danger' : disk.percentage >= 75 ? 'warning' : 'ok';

  return (
    <div className="disk-row">
      <div className="disk-row-header">
        <div className="disk-row-title">
          <span className="disk-row-icon">💾</span>
          <div>
            <strong>{disk.name}</strong>
            <span className="disk-row-model">({disk.model}, {formatBytes(disk.total, 2)})</span>
          </div>
        </div>
        <div className={`disk-row-pct ${pctClass}`}>{disk.percentage}%</div>
      </div>

      <div className="disk-bar">
        {disk.partitions.map((p, i) => {
          const w = Math.max(0.5, (p.total / total) * 100);
          const usedRatio = p.allocated && p.total > 0 ? Math.min(1, p.used / p.total) : 0;
          return (
            <div
              key={i}
              className={`disk-seg ${p.allocated ? 'alloc' : 'unalloc'}`}
              style={{ flexBasis: `${w}%` }}
              title={`${p.name} — ${formatBytes(p.total)}${p.allocated ? ` (${formatBytes(p.used)} used)` : ''}`}
            >
              {p.allocated && (
                <div className="disk-seg-fill" style={{ width: `${usedRatio * 100}%` }} />
              )}
            </div>
          );
        })}
      </div>

      <div className="disk-row-labels">
        {disk.partitions.map((p, i) => {
          const w = Math.max(0.5, (p.total / total) * 100);
          return (
            <div key={i} className="disk-row-label" style={{ flexBasis: `${w}%` }}>
              <div className="disk-row-label-name" title={p.name}>{p.name}</div>
              <div className="disk-row-label-size">{formatBytes(p.total, 2)}</div>
              {p.allocated && p.used > 0 && (
                <div className="disk-row-label-used">{formatBytes(p.used, 1)} used</div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
