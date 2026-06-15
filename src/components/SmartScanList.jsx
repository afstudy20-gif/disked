import React, { useEffect, useState } from 'react';
import { apiInvoke } from '../utils/api';
import { formatBytes } from './DiskGauge';

// Safety guidelines gathered from official documentation and developer consensus
const targetHints = {
  npm: {
    safety: 'safe',
    safetyLabel: 'Güvenli ✅',
    consequence: 'NPM paket depolarını bilgisayarınızdan siler. Bir sonraki projenizde "npm install" çalıştırdığınızda paketler internetten tekrar indirileceği için ilk yükleme biraz daha uzun sürer.'
  },
  pip: {
    safety: 'safe',
    safetyLabel: 'Güvenli ✅',
    consequence: 'Python paket önbelleklerini temizler. Bir sonraki "pip install" işleminde paketler PyPI üzerinden tekrar indirilir, sisteminize zarar vermez.'
  },
  yarn: {
    safety: 'safe',
    safetyLabel: 'Güvenli ✅',
    consequence: 'Yarn paket önbelleklerini temizler. Bir sonraki "yarn install" işleminde paketler internetten indirileceği için ilk yükleme süresi biraz uzar.'
  },
  cargo: {
    safety: 'safe',
    safetyLabel: 'Güvenli ✅',
    consequence: 'Rust Cargo registry önbelleğini temizler. Bir sonraki Rust projesi derlemenizde kütüphaneler tekrar indirileceği için ilk derleme biraz daha uzun sürer.'
  },
  xcode: {
    safety: 'safe',
    safetyLabel: 'Güvenli ✅ (Çözümcü)',
    consequence: 'Xcode derleme çıktıları ve dizinleme dosyalarını siler. Kodunuz silinmez. Xcode projeyi bir sonraki derlemede sıfırdan derleyeceği için ilk derleme uzun sürer ama Xcode derleme hatalarının %90\'ını çözer.'
  },
  caches: {
    safety: 'caution',
    safetyLabel: 'Dikkatli Olunmalı ⚠️',
    consequence: 'Chrome, Spotify vb. uygulamaların yerel önbelleğini siler. Uygulamalar açıldığında bu önbellekleri sıfırdan oluşturur. Sildikten sonra bilgisayarı yeniden başlatmanız önerilir.'
  },
  logs: {
    safety: 'safe',
    safetyLabel: 'Güvenli ✅',
    consequence: 'Uygulamaların geçmişte ürettiği hata günlüklerini (log) siler. Sistem çalışmasına olumsuz bir etkisi yoktur, geçmiş hataları incelemenizi zorlaştırır.'
  },
  trash: {
    safety: 'safe',
    safetyLabel: 'Güvenli ✅',
    consequence: 'Çöp sepetindeki dosyaları kalıcı olarak silerek anında yer açar. Bu işlem geri alınamaz.'
  }
};

export default function SmartScanList({ selectedPaths, togglePathSelection, onRefreshTrigger }) {
  const [targets, setTargets] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [expandedDetails, setExpandedDetails] = useState(new Set());

  const fetchTargets = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiInvoke('get_smart_scan_targets');
      setTargets(data);
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchTargets();
  }, [onRefreshTrigger]);

  const toggleDetails = (id, e) => {
    e.stopPropagation();
    const next = new Set(expandedDetails);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    setExpandedDetails(next);
  };

  if (loading) {
    return (
      <div className="card" style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '200px' }}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1rem' }}>
          <div className="spinner" style={{ width: '30px', height: '30px' }}></div>
          <span style={{ color: 'var(--text-secondary)' }}>Calculating cache sizes...</span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="card" style={{ color: 'var(--color-danger)', padding: '2rem', textAlign: 'center' }}>
        Error checking smart targets: {error}
        <br />
        <button className="btn" onClick={fetchTargets} style={{ marginTop: '1rem' }}>Retry</button>
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
        <h3 style={{ fontFamily: 'var(--font-heading)' }}>Quick Clean Recommendation</h3>
        <button className="btn" onClick={fetchTargets} style={{ fontSize: '0.8rem', padding: '0.4rem 0.8rem' }}>
          🔄 Recalculate
        </button>
      </div>
      <div className="smart-scan-grid">
        {targets.map((target) => {
          const isChecked = selectedPaths.has(target.path);
          const isExpanded = expandedDetails.has(target.id);
          const isHeavy = target.size > 1024 * 1024 * 1024 * 5; // >5GB
          const isCritical = target.size > 1024 * 1024 * 1024 * 15; // >15GB
          
          let sizeClass = '';
          if (isCritical) sizeClass = 'critical';
          else if (isHeavy) sizeClass = 'heavy';

          const hint = targetHints[target.id];

          return (
            <div 
              key={target.id} 
              className={`smart-target-card ${isChecked ? 'selected' : ''} ${!target.exists ? 'empty-target' : ''}`}
              onClick={() => target.exists && togglePathSelection(target.path, target.size)}
              style={{ cursor: target.exists ? 'pointer' : 'default', flexDirection: 'column', alignItems: 'stretch' }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div className="smart-target-info" style={{ overflow: 'hidden' }}>
                  <span className="smart-target-name">
                    {target.id === 'trash' ? '🗑️' : '📁'} {target.name}
                  </span>
                  <span className="smart-target-desc" style={{ textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap' }}>
                    {target.exists ? target.description : 'Sistemde bulunamadı veya boş'}
                  </span>
                  <span onClick={(e) => toggleDetails(target.id, e)} className="details-toggle-btn" style={{ cursor: 'pointer' }}>
                    ℹ️ {isExpanded ? 'Gizle' : 'Detaylar ve Güvenlik'}
                  </span>
                </div>
                
                <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                  <span className={`smart-target-size ${sizeClass}`} style={{ whiteSpace: 'nowrap' }}>
                    {target.exists ? formatBytes(target.size) : '0 B'}
                  </span>
                  {target.exists && (
                    <div className="checkbox-wrapper">
                      <div className={`custom-checkbox ${isChecked ? 'checked' : ''}`} />
                    </div>
                  )}
                </div>
              </div>

              {isExpanded && hint && (
                <div className="smart-target-expanded-info" onClick={(e) => e.stopPropagation()}>
                  <div style={{ marginBottom: '0.4rem' }}>
                    <strong>Güvenlik Derecesi:</strong>{' '}
                    <span style={{ color: hint.safety === 'safe' ? 'var(--color-success)' : 'var(--color-warning)', fontWeight: '600' }}>
                      {hint.safetyLabel}
                    </span>
                  </div>
                  <div>
                    <strong>Silinince Ne Olur?:</strong>{' '}
                    <span style={{ color: 'var(--text-secondary)', lineHeight: '1.4' }}>
                      {hint.consequence}
                    </span>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
