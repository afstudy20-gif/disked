import React, { useState } from 'react';
import { formatBytes } from './DiskGauge';

export default function FileTree({ treeData, rootPath, selectedPaths, togglePathSelection }) {
  const [expandedPaths, setExpandedPaths] = useState(new Set());
  const [sortBy, setSortBy] = useState('size'); // 'size' | 'name' | 'date'
  const [sortOrder, setSortOrder] = useState('desc'); // 'asc' | 'desc'

  const toggleExpand = (path, e) => {
    if (e) e.stopPropagation();
    const next = new Set(expandedPaths);
    if (next.has(path)) {
      next.delete(path);
    } else {
      next.add(path);
    }
    setExpandedPaths(next);
  };

  // Helper to dynamically sort directories/files in UI
  const sortChildren = (childrenList) => {
    if (!childrenList) return [];
    const sorted = [...childrenList];
    sorted.sort((a, b) => {
      let valA, valB;
      if (sortBy === 'size') {
        valA = a.size || 0;
        valB = b.size || 0;
      } else if (sortBy === 'name') {
        valA = a.name.toLowerCase();
        valB = b.name.toLowerCase();
      } else if (sortBy === 'date') {
        valA = new Date(a.updatedAt || 0).getTime();
        valB = new Date(b.updatedAt || 0).getTime();
      }

      if (valA < valB) return sortOrder === 'asc' ? -1 : 1;
      if (valA > valB) return sortOrder === 'asc' ? 1 : -1;
      return 0;
    });
    return sorted;
  };

  const renderNode = (nodePath, depth = 0) => {
    const node = treeData[nodePath];
    if (!node) return null;

    const isExpanded = expandedPaths.has(nodePath);
    const hasChildren = node.children && node.children.length > 0;

    return (
      <div key={nodePath} className="tree-node" style={{ paddingLeft: `${depth > 0 ? 16 : 0}px` }}>
        <div 
          className={`tree-row ${selectedPaths.has(nodePath) ? 'selected' : ''}`}
          onClick={(e) => toggleExpand(nodePath, e)} // Clicking folder row expands/collapses it
          style={{ cursor: 'pointer' }}
        >
          <div className="tree-node-left">
            {node.isDirectory ? (
              <span 
                className={`chevron ${isExpanded ? 'open' : ''}`} 
                onClick={(e) => toggleExpand(nodePath, e)}
                style={{ visibility: hasChildren ? 'visible' : 'hidden' }}
              >
                ▶
              </span>
            ) : (
              <span style={{ width: '16px' }}></span>
            )}
            
            <span className="node-icon">
              {node.isDirectory ? '📁' : '📄'}
            </span>
            
            <span className="node-name" title={nodePath}>
              {node.name}
            </span>
          </div>

          <div className="tree-node-right" onClick={(e) => e.stopPropagation()}> {/* Stop propagation to avoid toggling expand when checking */}
            <span className="node-size">{formatBytes(node.size)}</span>
            <div className="checkbox-wrapper">
              <div 
                className={`custom-checkbox ${selectedPaths.has(nodePath) ? 'checked' : ''}`}
                onClick={() => togglePathSelection(nodePath, node.size)}
              />
            </div>
          </div>
        </div>

        {isExpanded && hasChildren && (
          <div className="tree-children" style={{ marginTop: '2px', marginBottom: '2px' }}>
            {sortChildren(node.children).map((child) => {
              // If the child is a directory and exists in the flat map, render it recursively
              if (child.isDirectory && treeData[child.path]) {
                return renderNode(child.path, depth + 1);
              }
              
              // If it's a file, render a simple row that selects on click
              const isChildChecked = selectedPaths.has(child.path);
              return (
                <div 
                  key={child.path} 
                  className={`tree-row ${isChildChecked ? 'selected' : ''}`}
                  style={{ paddingLeft: `${(depth + 1) * 16 + 16}px` }}
                  onClick={() => togglePathSelection(child.path, child.size)} // Files select directly on row click
                >
                  <div className="tree-node-left">
                    <span style={{ width: '16px' }}></span>
                    <span className="node-icon">{child.isDirectory ? '📁' : '📄'}</span>
                    <span className="node-name" title={child.path}>{child.name}</span>
                  </div>
                  <div className="tree-node-right" onClick={(e) => e.stopPropagation()}>
                    <span className="node-size">{formatBytes(child.size)}</span>
                    <div className="checkbox-wrapper">
                      <div 
                        className={`custom-checkbox ${isChildChecked ? 'checked' : ''}`}
                        onClick={() => togglePathSelection(child.path, child.size)}
                      />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  };

  if (!treeData || !rootPath || !treeData[rootPath]) {
    return (
      <div className="no-results">
        <div className="no-results-icon">📂</div>
        <div>No scanned data. Start a scan to view the folder tree structure.</div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      {/* Finder-like controls */}
      <div 
        style={{ 
          display: 'flex', 
          alignItems: 'center', 
          gap: '1rem', 
          background: 'rgba(255, 255, 255, 0.02)', 
          padding: '0.6rem 1rem', 
          borderRadius: '10px', 
          border: '1px solid var(--border-light)',
          fontSize: '0.88rem'
        }}
      >
        <span style={{ color: 'var(--text-secondary)', fontWeight: '500' }}>Sıralama Ölçütü:</span>
        <select 
          className="path-input" 
          value={sortBy} 
          onChange={(e) => setSortBy(e.target.value)} 
          style={{ width: 'auto', padding: '0.3rem 0.6rem', fontSize: '0.85rem' }}
        >
          <option value="size">Boyut (Size)</option>
          <option value="name">Ad (Name)</option>
          <option value="date">Değiştirme Tarihi (Date)</option>
        </select>

        <select 
          className="path-input" 
          value={sortOrder} 
          onChange={(e) => setSortOrder(e.target.value)} 
          style={{ width: 'auto', padding: '0.3rem 0.6rem', fontSize: '0.85rem' }}
        >
          <option value="desc">Azalan (Desc)</option>
          <option value="asc">Artan (Asc)</option>
        </select>
      </div>

      <div className="file-tree-container">
        {renderNode(rootPath)}
      </div>
    </div>
  );
}
