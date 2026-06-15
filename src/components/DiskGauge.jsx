import React from 'react';

// Format bytes into readable string
export const formatBytes = (bytes, decimals = 2) => {
  if (bytes === 0) return '0 Bytes';
  const k = 1000; // macOS standard (base-10 decimal GB)
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
};

export default function DiskGauge({ total, used, available, other = 0, percentage, reclaimSize = 0 }) {
  const radius = 80;
  const circumference = 2 * Math.PI * radius; // ~502.65

  // Calculations for preview
  const totalUsedPercentage = percentage; // e.g. 83%

  // Reclaim calculations
  const reclaimPercentage = total > 0 ? (reclaimSize / total) * 100 : 0;
  // Capped at totalUsedPercentage
  const cappedReclaimPercent = Math.min(reclaimPercentage, totalUsedPercentage);
  const newUsedPercentage = Math.max(0, totalUsedPercentage - cappedReclaimPercent);

  // Dash offsets
  const baseOffset = circumference - (totalUsedPercentage / 100) * circumference;
  const newOffset = circumference - (newUsedPercentage / 100) * circumference;
  const reclaimOffset = circumference - (cappedReclaimPercent / 100) * circumference;

  let colorClass = 'success';
  if (newUsedPercentage >= 90) {
    colorClass = 'danger';
  } else if (newUsedPercentage >= 75) {
    colorClass = 'warning';
  }

  const isLowSpace = available < 1024 * 1024 * 1024 * 5; // Less than 5GB available

  return (
    <div className="card gauge-card">
      <h3 style={{ marginBottom: '0.5rem', alignSelf: 'flex-start' }}>Disk Usage</h3>
      
      <div className="gauge-svg-container">
        <svg className="gauge-svg" viewBox="0 0 200 200">
          <circle 
            className="gauge-track" 
            cx="100" 
            cy="100" 
            r={radius} 
          />
        </svg>
        <div className="gauge-text">
          {reclaimSize > 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
              <span className="gauge-free-title">Free Space</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.2rem', margin: '0.2rem 0' }}>
                <span className="gauge-free-old">{formatBytes(available)}</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.2rem' }}>
                <span style={{ fontSize: '1rem', color: 'var(--color-success)', fontWeight: 'bold' }}>→</span>
                <span className="gauge-free-new" style={{ color: 'var(--color-success)', fontWeight: 'bold' }}>
                  {formatBytes(available + reclaimSize)}
                </span>
              </div>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
              <span className="gauge-free-val">{formatBytes(available)}</span>
              <span className="gauge-free-label">Free</span>
            </div>
          )}
        </div>
      </div>

      {isLowSpace && (
        <div className="critical-banner">
          <span>⚠️</span>
          <div style={{ textAlign: 'left' }}>
            <strong>Low Disk Space!</strong>
            <div>Only {formatBytes(available)} free. Clean caches or large files to avoid system crash.</div>
          </div>
        </div>
      )}

      <div className="gauge-stats-details">
        <div className="gauge-stat-item">
          <span className="gauge-stat-title">My Files</span>
          <span className="gauge-stat-value">{formatBytes(used)}</span>
        </div>
        {other > 0 && (
          <div className="gauge-stat-item">
            <span className="gauge-stat-title">Other Volumes</span>
            <span className="gauge-stat-value" style={{ opacity: 0.8 }}>{formatBytes(other)}</span>
          </div>
        )}
        <div className="gauge-stat-item">
          <span className="gauge-stat-title">Free Space</span>
          <span className={`gauge-stat-value ${isLowSpace ? 'danger' : ''}`}>
            {formatBytes(available)}
          </span>
        </div>
        <div className="gauge-stat-item">
          <span className="gauge-stat-title">Total Capacity</span>
          <span className="gauge-stat-value">{formatBytes(total, 0)}</span>
        </div>
      </div>
      
      {reclaimSize > 0 && (
        <div className="reclaim-preview-pill">
          🧹 Selecting <strong>{formatBytes(reclaimSize)}</strong> to reclaim
        </div>
      )}
    </div>
  );
}
