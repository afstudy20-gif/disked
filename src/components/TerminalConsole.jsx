import React, { useState, useEffect, useRef } from 'react';
import { apiInvoke } from '../utils/api';

export default function TerminalConsole() {
  const [cwd, setCwd] = useState('~');
  const [input, setInput] = useState('');
  const [history, setHistory] = useState([
    { type: 'output', text: 'Welcome to Disk Analyzer Terminal.' },
    { type: 'output', text: 'Run custom commands securely. Directory changes are persisted.' }
  ]);
  const [commandHistory, setCommandHistory] = useState([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [executing, setExecuting] = useState(false);

  const bottomRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    // Scroll terminal output to bottom
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [history]);

  // Autofocus input on card click
  const handleTerminalClick = () => {
    inputRef.current?.focus();
  };

  const executeCommand = async (cmdText) => {
    if (!cmdText.trim()) return;

    setExecuting(true);
    const newHistory = [...history, { type: 'input', text: `${cwd} $ ${cmdText}` }];
    setHistory(newHistory);

    try {
      const data = await apiInvoke('run_terminal_command', {
        command: cmdText,
        cwd: cwd === '~' ? null : cwd
      });
      const outputs = [];

      if (data.stdout) {
        outputs.push({ type: 'output', text: data.stdout });
      }
      if (data.stderr) {
        outputs.push({ type: 'error', text: data.stderr });
      }
      if (!data.stdout && !data.stderr && !cmdText.trim().startsWith('cd')) {
        outputs.push({ type: 'output', text: '(No output returned)' });
      }

      // Update folder path
      if (data.cwd) {
        setCwd(data.cwd);
      }

      setHistory(prev => [...prev, ...outputs]);
      setCommandHistory(prev => [cmdText, ...prev]);
    } catch (err) {
      setHistory(prev => [...prev, { type: 'error', text: `Shell execution error: ${err}` }]);
    } finally {
      setExecuting(false);
      setHistoryIndex(-1);
      setInput('');
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') {
      executeCommand(input);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (commandHistory.length > 0 && historyIndex < commandHistory.length - 1) {
        const nextIdx = historyIndex + 1;
        setHistoryIndex(nextIdx);
        setInput(commandHistory[nextIdx]);
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (historyIndex > 0) {
        const nextIdx = historyIndex - 1;
        setHistoryIndex(nextIdx);
        setInput(commandHistory[nextIdx]);
      } else if (historyIndex === 0) {
        setHistoryIndex(-1);
        setInput('');
      }
    }
  };

  // Quick Command triggers
  const runQuickCommand = (cmdText) => {
    if (executing) return;
    executeCommand(cmdText);
  };

  const clearConsole = () => {
    setHistory([
      { type: 'output', text: 'Console cleared.' }
    ]);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', height: '100%', minHeight: '480px' }}>
      {/* Quick shortcuts header */}
      <div className="terminal-shortcuts" style={{ gap: '0.5rem' }}>
        <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', fontWeight: 'bold' }}>Quick Commands:</span>
        <button className="btn" onClick={() => runQuickCommand('df -h')} disabled={executing} title="Disk space usage">
          💾 Disk Space (df -h)
        </button>
        <button className="btn" onClick={() => runQuickCommand('du -sh *')} disabled={executing} title="Folder sizes in current dir">
          📂 Folder Sizes (du -sh *)
        </button>
        <button className="btn" onClick={() => runQuickCommand('diskutil list')} disabled={executing} title="List all disks and partitions">
          💿 List Disks (diskutil list)
        </button>
        <button className="btn" onClick={() => runQuickCommand('tmutil listlocalsnapshots /')} disabled={executing} title="List local Time Machine snapshots">
          📸 List Snapshots
        </button>
        <button className="btn" onClick={() => runQuickCommand('tmutil thinlocalsnapshots / 10000000000 4')} disabled={executing} title="Thin local snapshots to free space">
          🧹 Clean Snapshots
        </button>
        <button className="btn" onClick={() => runQuickCommand('ls -la')} disabled={executing} title="List files in current directory">
          📋 List Files (ls -la)
        </button>
        <button className="btn btn-danger" style={{ marginLeft: 'auto', padding: '0.3rem 0.6rem', fontSize: '0.82rem' }} onClick={clearConsole}>
          Clear
        </button>
      </div>

      {/* Terminal window */}
      <div className="terminal-window" onClick={handleTerminalClick}>
        <div className="terminal-header">
          <div className="terminal-dot red"></div>
          <div className="terminal-dot yellow"></div>
          <div className="terminal-dot green"></div>
          <span className="terminal-title">bash - {cwd}</span>
        </div>

        <div className="terminal-body">
          {history.map((line, i) => (
            <div key={i} className={`terminal-line ${line.type}`}>
              {line.text}
            </div>
          ))}
          {executing && (
            <div className="terminal-line output">
              <span className="spinner-inline"></span> Running command...
            </div>
          )}
          <div className="terminal-prompt-row">
            <span className="terminal-prompt">{cwd} $</span>
            <input
              ref={inputRef}
              type="text"
              className="terminal-input"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={executing}
              autoFocus
            />
          </div>
          <div ref={bottomRef} />
        </div>
      </div>
    </div>
  );
}
