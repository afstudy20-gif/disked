import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

export const isTauri = () => {
  return window.__TAURI_INTERNALS__ !== undefined || window.__TAURI__ !== undefined;
};

export const apiInvoke = async (commandName, args = {}) => {
  if (isTauri()) {
    return await invoke(commandName, args);
  } else {
    // Map Tauri command names to Express REST API endpoints
    const mapping = {
      'get_disk_space': { path: '/api/disk-space', method: 'GET' },
      'start_scan': { path: '/api/scan', method: 'POST' },
      'cancel_scan': { path: '/api/scan/cancel', method: 'POST' },
      'get_scan_results': { path: '/api/scan-results', method: 'GET' },
      'delete_paths': { path: '/api/delete', method: 'POST' },
      'list_applications': { path: '/api/applications', method: 'GET' },
      'find_app_leftovers': { path: '/api/app-leftovers', method: 'POST' },
      'uninstall_paths': { path: '/api/uninstall', method: 'POST' },
      'reveal_in_explorer': { path: '/api/reveal', method: 'POST' },
      'get_smart_scan_targets': { path: '/api/smart-scan-targets', method: 'GET' },
      'run_docker_prune': { path: '/api/docker-prune', method: 'POST' },
      'run_terminal_command': { path: '/api/terminal/run', method: 'POST' }
    };

    const route = mapping[commandName];
    if (!route) {
      throw new Error(`Unknown command mapping: ${commandName}`);
    }

    const options = {
      method: route.method,
      headers: {}
    };

    if (route.method === 'POST') {
      options.headers['Content-Type'] = 'application/json';
      
      let body = {};
      if (commandName === 'start_scan') {
        body.scanPath = args.scanPath;
      } else if (commandName === 'delete_paths' || commandName === 'uninstall_paths') {
        body.paths = args.paths;
      } else if (commandName === 'find_app_leftovers') {
        body.appPath = args.appPath;
      } else if (commandName === 'reveal_in_explorer') {
        body.targetPath = args.targetPath;
      } else if (commandName === 'run_terminal_command') {
        body.command = args.command;
        body.cwd = args.cwd;
      } else {
        body = args;
      }
      options.body = JSON.stringify(body);
    }

    const res = await fetch(route.path, options);
    const contentType = res.headers.get('content-type');
    
    let data = {};
    if (contentType && contentType.includes('application/json')) {
      data = await res.json();
    } else {
      const text = await res.text();
      throw new Error(text || `Server returned status ${res.status}`);
    }

    if (!res.ok) {
      throw new Error(data.error || data.details || `Request failed with status ${res.status}`);
    }

    return data;
  }
};

export const apiListen = async (eventName, callback) => {
  if (isTauri()) {
    return await listen(eventName, (event) => {
      callback(event.payload);
    });
  } else {
    if (eventName === 'scan-progress') {
      const eventSource = new EventSource('/api/scan-progress');
      
      eventSource.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          callback(data);
        } catch (e) {
          console.error('Error parsing SSE progress data:', e);
        }
      };

      eventSource.onerror = (err) => {
        console.error('SSE EventSource error:', err);
        eventSource.close();
        // If stream ended or failed, notify client that scanning is inactive so it stops loading
        callback({ active: false });
      };

      // Return unlisten callback matching Tauri's API
      return () => {
        eventSource.close();
      };
    }
    
    return () => {};
  }
};
