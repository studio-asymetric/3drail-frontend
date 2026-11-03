// Debug window component to show loading/rendering status and data sizes

import React from 'react';

export interface DebugInfo {
  osmRailData: {
    loaded: boolean;
    count: number;
    sizeKB: number;
    loading: boolean;
  };
  elevationData: {
    loaded: boolean;
    resolution: string;
    sizeKB: number;
    loading: boolean;
  };
  trainMatching: {
    totalTrains: number;
    matchedTrains: number;
    osmRoutes: number;
    totalSegments: number;
  };
  rendering: {
    osmLines: number;
    gtfsLines: number;
    trains: number;
  };
  performance: {
    frameTime: number;
    memoryUsage?: number;
  };
  animation: {
    statuses: Record<string, 'searching' | 'finished' | 'failed'>;
    warnings: string[];
    pendingWorkerRequests: number;
    pendingResolvers: number;
    pendingTrains: string[];
  };
}

interface DebugWindowProps {
  debugInfo: DebugInfo;
  visible: boolean;
  onToggle: () => void;
  osmStatus: {
    tilesLoaded: number;
    lastStatus: string;
    lastFetch: string;
    loading: boolean;
  };
  cameraDistance: number;
  boundingBoxActive: boolean;
  animatedTrainCount: number;
  purgeOsmCache: () => void;
  useLiveApi: boolean;
  onToggleLiveApi: (enabled: boolean) => void;
}

export const DebugWindow: React.FC<DebugWindowProps> = ({
  debugInfo,
  visible,
  onToggle,
  osmStatus,
  cameraDistance,
  boundingBoxActive,
  animatedTrainCount,
  purgeOsmCache,
  useLiveApi,
  onToggleLiveApi,
}) => {
  const renderFootnote = () => (
    <div className="train-selector-panel__footnote">
      <label className="train-selector-panel__checkbox">
        <input
          type="checkbox"
          checked={useLiveApi}
          onChange={(event) => onToggleLiveApi(event.target.checked)}
        />
        <span>Use proxy live API (server handles cookies)</span>
      </label>
      <div className="train-selector-panel__status">
        {useLiveApi
          ? 'Proxy is serving gtall updates every 60s'
          : 'Showing static GTFS mirror until proxy is enabled'}
      </div>
    </div>
  );

  if (!visible) {
    return (
      <button onClick={onToggle} className="debug-toggle-btn">
        🔍 Show Debug
      </button>
    );
  }

  return (
    <div className="debug-window-panel">
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
        <h3 style={{ margin: 0, color: '#00ff00' }}>🐛 Debug Info</h3>
        <button onClick={onToggle} className="debug-window__close">
          ✕
        </button>
      </div>

      <div style={{ marginBottom: '1rem' }}>
        <h4 style={{ margin: '0 0 0.5rem 0', color: '#ffff00' }}>📡 OSM Rail Data</h4>
        <div>Status: {debugInfo.osmRailData.loading ? '⏳ Loading...' : debugInfo.osmRailData.loaded ? '✅ Loaded' : '❌ Not Loaded'}</div>
        <div>Ways: {debugInfo.osmRailData.count}</div>
        <div>Size: {debugInfo.osmRailData.sizeKB.toFixed(2)} KB</div>
        <div style={{ marginTop: '0.25rem', color: '#ffffff' }}>
          <div>Loaded: {osmStatus.tilesLoaded}</div>
          <div>Status: {osmStatus.lastStatus}</div>
          <div>Last fetch: {osmStatus.lastFetch}</div>
          <div>Camera distance: {cameraDistance.toFixed(1)}</div>
          <div>Animation zone: {boundingBoxActive ? 'active' : 'idle'}</div>
          <div>Animated trains: {animatedTrainCount}</div>
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginTop: '0.5rem' }}>
            <button
              onClick={purgeOsmCache}
              disabled={osmStatus.loading}
              style={{
                padding: '0.35rem 0.75rem',
                borderRadius: 4,
                border: '1px solid #f87171',
                background: osmStatus.loading ? 'rgba(248, 113, 113, 0.4)' : 'transparent',
                color: '#f87171',
                cursor: osmStatus.loading ? 'not-allowed' : 'pointer',
              }}
            >
              Purge cache & reload
            </button>
            <span>{osmStatus.loading ? 'loading…' : 'idle'}</span>
          </div>
        </div>
      </div>

      <div style={{ marginBottom: '1rem' }}>
        <h4 style={{ margin: '0 0 0.5rem 0', color: '#ffff00' }}>🎨 Rendering</h4>
        <div>OSM Lines: {debugInfo.rendering.osmLines}</div>
        <div>GTFS Lines: {debugInfo.rendering.gtfsLines}</div>
        <div>Trains: {debugInfo.rendering.trains}</div>
      </div>

      <div>
        <h4 style={{ margin: '0 0 0.5rem 0', color: '#ffff00' }}>⚡ Performance</h4>
        <div>Frame Time: {debugInfo.performance.frameTime.toFixed(2)}ms</div>
        {debugInfo.performance.memoryUsage && (
          <div>Memory: {(debugInfo.performance.memoryUsage / 1024 / 1024).toFixed(2)} MB</div>
        )}
      </div>
      <div style={{ marginTop: '1rem' }}>
        <h4 style={{ margin: '0 0 0.5rem 0', color: '#ffff00' }}>🚆 Animated Trains</h4>
        {Object.keys(debugInfo.animation.statuses).length === 0 ? (
          <div>No animated trains</div>
        ) : (
          <div style={{ fontSize: '12px' }}>
            {Object.entries(debugInfo.animation.statuses).map(([trainNumber, status]) => {
              const label =
                status === 'searching'
                  ? '🔄 Searching path'
                  : status === 'finished'
                    ? '✅ Path ready'
                    : '❌ Path failed';
              const color = status === 'failed' ? '#f87171' : status === 'finished' ? '#34d399' : '#facc15';
              return (
                <div key={trainNumber} style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem' }}>
                  <span>{trainNumber}</span>
                  <span style={{ color }}>{label}</span>
                </div>
              );
            })}
          </div>
        )}
        {debugInfo.animation.warnings.length > 0 && (
          <div style={{ marginTop: '0.5rem', fontSize: '10px', color: '#f87171' }}>
            <div>Warnings:</div>
            {debugInfo.animation.warnings.map((warning) => (
              <div key={warning}>{warning}</div>
            ))}
          </div>
        )}
        <div style={{ marginTop: '0.5rem', fontSize: '11px' }}>
          <div>Pending worker requests: {debugInfo.animation.pendingWorkerRequests}</div>
          <div>Pending resolvers: {debugInfo.animation.pendingResolvers}</div>
          {debugInfo.animation.pendingTrains.length > 0 && (
            <div style={{ marginTop: '0.25rem', color: '#facc15' }}>
              Active requests: {debugInfo.animation.pendingTrains.join(', ')}
            </div>
          )}
        </div>
        {renderFootnote()}
      </div>
    </div>
  );
};

