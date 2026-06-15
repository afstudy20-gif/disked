import React from 'react';
import { formatBytes } from './DiskGauge';

export default function LargestFiles({ topFiles, selectedPaths, togglePathSelection }) {
  if (!topFiles || topFiles.length === 0) {
    return (
      <div className="no-results">
        <div className="no-results-icon">🔍</div>
        <div>No large files scanned yet. Start a scan to find the heaviest files.</div>
      </div>
    );
  }

  return (
    <div className="large-files-list">
      {topFiles.map((file, idx) => {
        const isChecked = selectedPaths.has(file.path);
        const isHeavy = file.size > 1024 * 1024 * 500; // > 500MB
        const isCritical = file.size > 1024 * 1024 * 1024 * 2; // > 2GB
        
        let sizeClass = '';
        if (isCritical) sizeClass = 'critical';
        else if (isHeavy) sizeClass = 'heavy';

        // Extract folder path for display
        const folderPath = file.path.substring(0, file.path.lastIndexOf('/'));

        return (
          <div 
            key={file.path} 
            className={`file-item-card ${isChecked ? 'selected' : ''}`}
            onClick={() => togglePathSelection(file.path, file.size)}
            style={{ cursor: 'pointer' }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flex: 1, minWidth: 0 }}>
              <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)', fontWeight: 'bold', minWidth: '24px' }}>
                #{idx + 1}
              </span>
              <div className="file-item-info">
                <span className="file-item-name" title={file.name}>
                  📄 {file.name}
                </span>
                <span className="file-item-path" title={file.path}>
                  {folderPath}
                </span>
              </div>
            </div>

            <div className="file-item-right">
              <span className={`file-item-size ${sizeClass}`}>{formatBytes(file.size)}</span>
              <div className="checkbox-wrapper" onClick={(e) => e.stopPropagation()}>
                <div 
                  className={`custom-checkbox ${isChecked ? 'checked' : ''}`}
                  onClick={() => togglePathSelection(file.path, file.size)}
                />
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
