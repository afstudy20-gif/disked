use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::path::{Path, PathBuf};
use std::fs;
use std::time::{SystemTime, UNIX_EPOCH, Instant};
use tauri::{AppHandle, Emitter, Manager, State};

// ----------------- DATA STRUCTURES -----------------

#[derive(Clone, Serialize)]
pub struct FileNode {
    pub name: String,
    pub path: String,
    #[serde(rename = "isDirectory")]
    pub is_directory: bool,
    pub size: u64,
    #[serde(rename = "updatedAt")]
    pub updated_at: u64, // epoch millis
}

#[derive(Clone, Serialize)]
pub struct FolderNode {
    pub name: String,
    pub path: String,
    pub size: u64,
    #[serde(rename = "isDirectory")]
    pub is_directory: bool,
    pub children: Vec<FileNode>,
}

#[derive(Clone, Serialize)]
pub struct ScanProgress {
    pub active: bool,
    pub cancelled: bool,
    #[serde(rename = "currentPath")]
    pub current_path: String,
    #[serde(rename = "foldersScanned")]
    pub folders_scanned: u32,
    #[serde(rename = "filesScanned")]
    pub files_scanned: u32,
    #[serde(rename = "totalSizeCalculated")]
    pub total_size_calculated: u64,
    #[serde(rename = "topFiles")]
    pub top_files: Vec<FileNode>,
    pub error: Option<String>,
}

pub struct AppState {
    pub scan_cancelled: Arc<AtomicBool>,
    pub scan_active: Arc<AtomicBool>,
    pub progress: Arc<Mutex<ScanProgress>>,
    pub tree: Arc<Mutex<HashMap<String, FolderNode>>>,
}

#[derive(Serialize)]
pub struct DiskSpaceInfo {
    pub total: u64,
    pub used: u64,
    pub available: u64,
    pub other: u64,
    pub percentage: u32,
    #[serde(rename = "homeDir")]
    pub home_dir: String,
}

#[derive(Serialize)]
pub struct SmartTarget {
    pub id: String,
    pub name: String,
    pub path: String,
    pub description: String,
    pub size: u64,
    pub exists: bool,
}

#[derive(Serialize)]
pub struct DeletionItemResult {
    pub path: String,
    pub status: String, // "success", "skipped", "error"
    pub size: u64,
    pub reason: String,
}

#[derive(Serialize)]
pub struct DeletionSummary {
    pub message: String,
    pub results: Vec<DeletionItemResult>,
    #[serde(rename = "spaceFreed")]
    pub space_freed: u64,
}

#[derive(Serialize)]
pub struct TerminalResult {
    pub stdout: String,
    pub stderr: String,
    pub cwd: String,
}

#[derive(Serialize)]
pub struct DockerPruneResult {
    pub success: bool,
    pub log: String,
    pub error: String,
}

#[derive(Serialize)]
pub struct ScanResults {
    pub tree: HashMap<String, FolderNode>,
    #[serde(rename = "topFiles")]
    pub top_files: Vec<FileNode>,
    #[serde(rename = "totalSize")]
    pub total_size: u64,
    #[serde(rename = "filesCount")]
    pub files_count: u32,
    #[serde(rename = "foldersCount")]
    pub folders_count: u32,
}

// ----------------- CONFIG & CONSTANTS -----------------

const LEAF_DIRECTORIES: &[&str] = &[
    "node_modules",
    ".git",
    ".venv",
    "venv",
    "env",
    ".idea",
    ".vscode",
    ".next",
    ".nuxt",
];

// Helper to prepare macOS commands with `/usr/local/bin` and `/opt/homebrew/bin` in the PATH
fn prepare_command(program: &str) -> std::process::Command {
    let mut cmd = std::process::Command::new(program);
    if cfg!(target_os = "macos") {
        if let Ok(path) = std::env::var("PATH") {
            let mut paths = std::env::split_paths(&path).collect::<Vec<_>>();
            let extra_paths = vec!["/usr/local/bin", "/opt/homebrew/bin"];
            for ep in extra_paths {
                let ep_buf = std::path::PathBuf::from(ep);
                if !paths.contains(&ep_buf) {
                    paths.push(ep_buf);
                }
            }
            if let Ok(new_path) = std::env::join_paths(paths) {
                cmd.env("PATH", new_path);
            }
        }
    }
    cmd
}

fn get_epoch_millis(time: SystemTime) -> u64 {
    time.duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn is_excluded(path: &Path, home_dir: &str) -> bool {
    let path_str = path.to_string_lossy();
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
    
    let excluded_names = ["Saved Application State", "Autosave Information", ".Trash"];
    if excluded_names.contains(&name) {
        return true;
    }
    
    let system_paths = [
        "/System",
        "/Volumes",
        "/dev",
        "/cores",
        "/private",
        "/Network",
        "/usr",
        "/bin",
        "/sbin",
    ];
    if system_paths.iter().any(|&p| path_str == p || path_str.starts_with(&format!("{}{}", p, std::path::MAIN_SEPARATOR))) {
        return true;
    }
    
    if !home_dir.is_empty() {
        let cloud_storage = format!("{}/Library/CloudStorage", home_dir);
        let icloud_drive = format!("{}/Library/Mobile Documents", home_dir);
        if path_str == cloud_storage || path_str.starts_with(&format!("{}{}", cloud_storage, std::path::MAIN_SEPARATOR)) {
            return true;
        }
        if path_str == icloud_drive || path_str.starts_with(&format!("{}{}", icloud_drive, std::path::MAIN_SEPARATOR)) {
            return true;
        }
    }
    
    false
}

// ----------------- HELPERS & WORKERS -----------------

fn get_folder_size_fast(dir_path: &Path, cancelled: &Arc<AtomicBool>) -> u64 {
    if cancelled.load(Ordering::Relaxed) {
        return 0;
    }
    let mut total_size = 0;
    if let Ok(entries) = fs::read_dir(dir_path) {
        for entry in entries.flatten() {
            if cancelled.load(Ordering::Relaxed) {
                return 0;
            }
            if let Ok(file_type) = entry.file_type() {
                if file_type.is_symlink() {
                    continue;
                }
                if file_type.is_dir() {
                    total_size += get_folder_size_fast(&entry.path(), cancelled);
                } else if file_type.is_file() {
                    if let Ok(metadata) = entry.metadata() {
                        total_size += metadata.len();
                    }
                }
            }
        }
    }
    total_size
}

fn scan_directory_recursive(
    dir_path: &Path,
    home_dir: &str,
    state: &Arc<Mutex<ScanProgress>>,
    tree: &Arc<Mutex<HashMap<String, FolderNode>>>,
    cancelled: &Arc<AtomicBool>,
    app_handle: &AppHandle,
    last_emit: &Arc<Mutex<Instant>>,
) -> u64 {
    if cancelled.load(Ordering::Relaxed) {
        return 0;
    }

    let dir_path_str = dir_path.to_string_lossy().to_string();

    {
        let mut progress = state.lock().unwrap();
        progress.current_path = dir_path_str.clone();
        progress.folders_scanned += 1;
    }

    // Throttle progress emissions to prevent front-end lags
    {
        let mut last_emit_lock = last_emit.lock().unwrap();
        if last_emit_lock.elapsed() >= std::time::Duration::from_millis(150) {
            *last_emit_lock = Instant::now();
            let progress = state.lock().unwrap();
            let _ = app_handle.emit("scan-progress", &*progress);
        }
    }

    let mut total_size = 0;
    let mut children = Vec::new();

    if let Ok(entries) = fs::read_dir(dir_path) {
        for entry in entries.flatten() {
            if cancelled.load(Ordering::Relaxed) {
                return 0;
            }

            let path = entry.path();
            if is_excluded(&path, home_dir) {
                continue;
            }

            if let Ok(file_type) = entry.file_type() {
                if file_type.is_symlink() {
                    continue;
                }

                let name = entry.file_name().to_string_lossy().to_string();
                let path_str = path.to_string_lossy().to_string();

                if file_type.is_dir() {
                    let is_leaf = LEAF_DIRECTORIES.contains(&name.as_str());
                    let sub_size = if is_leaf {
                        get_folder_size_fast(&path, cancelled)
                    } else {
                        scan_directory_recursive(
                            &path,
                            home_dir,
                            state,
                            tree,
                            cancelled,
                            app_handle,
                            last_emit,
                        )
                    };

                    let mtime = entry.metadata().ok()
                        .and_then(|m| m.modified().ok())
                        .map(get_epoch_millis)
                        .unwrap_or(0);

                    total_size += sub_size;
                    
                    children.push(FileNode {
                        name,
                        path: path_str,
                        is_directory: true,
                        size: sub_size,
                        updated_at: mtime,
                    });
                } else if file_type.is_file() {
                    if let Ok(metadata) = entry.metadata() {
                        let size = metadata.len();
                        total_size += size;
                        
                        let mtime = metadata.modified().ok()
                            .map(get_epoch_millis)
                            .unwrap_or(0);

                        let file_node = FileNode {
                            name: name.clone(),
                            path: path_str.clone(),
                            is_directory: false,
                            size,
                            updated_at: mtime,
                        };

                        {
                            let mut progress = state.lock().unwrap();
                            progress.files_scanned += 1;
                            progress.total_size_calculated += size;
                            
                            // Insert into top files (sorted descending by size)
                            let insert_pos = progress.top_files.binary_search_by(|probe| probe.size.cmp(&size).reverse())
                                .unwrap_or_else(|e| e);
                            if insert_pos < 100 {
                                progress.top_files.insert(insert_pos, file_node.clone());
                                if progress.top_files.len() > 100 {
                                    progress.top_files.pop();
                                }
                            }
                        }

                        children.push(file_node);
                    }
                }
            }
        }
    }

    children.sort_by(|a, b| b.size.cmp(&a.size));

    let folder_node = FolderNode {
        name: dir_path.file_name().and_then(|n| n.to_str()).unwrap_or(&dir_path_str).to_string(),
        path: dir_path_str.clone(),
        size: total_size,
        is_directory: true,
        children,
    };

    {
        let mut tree_lock = tree.lock().unwrap();
        tree_lock.insert(dir_path_str, folder_node);
    }

    total_size
}

fn is_safe_to_delete(path_str: &str, home_dir: &str) -> bool {
    let path = Path::new(path_str);
    let resolved_target = match path.canonicalize() {
        Ok(p) => p,
        Err(_) => return false,
    };
    
    let home_path = Path::new(home_dir);
    let resolved_home = match home_path.canonicalize() {
        Ok(p) => p,
        Err(_) => return false,
    };

    if resolved_target == resolved_home {
        return false;
    }

    let blocked_paths = [
        "/",
        "/System",
        "/Library",
        "/bin",
        "/sbin",
        "/usr",
        "/var",
        "/etc",
        "/private",
        "/cores",
        "/dev",
        "/opt",
        "/Applications",
        "/Users",
    ];

    let target_str = resolved_target.to_string_lossy();
    if blocked_paths.iter().any(|&bp| target_str == bp) {
        return false;
    }

    if cfg!(target_os = "windows") {
        if target_str.len() <= 3 {
            return false;
        }
        let blocked_win = ["C:\\Windows", "C:\\Program Files", "C:\\Program Files (x86)", "C:\\Users"];
        if blocked_win.iter().any(|&bp| target_str.eq_ignore_ascii_case(bp)) {
            return false;
        }
    }

    let key_home_folders = [
        resolved_home.clone(),
        resolved_home.join("Desktop"),
        resolved_home.join("Documents"),
        resolved_home.join("Downloads"),
        resolved_home.join("Library"),
        resolved_home.join("Applications"),
    ];

    if key_home_folders.iter().any(|kh| resolved_target == *kh) {
        return false;
    }

    if resolved_target.starts_with(&resolved_home) || resolved_target == resolved_home.join(".npm") || resolved_target == resolved_home.join(".cargo") {
        return true;
    }

    false
}

// ----------------- TAURI COMMANDS -----------------

#[tauri::command]
fn get_disk_space(app_handle: AppHandle) -> Result<DiskSpaceInfo, String> {
    let home_path = app_handle.path().home_dir().unwrap_or_else(|_| PathBuf::from("/"));
    let home_dir_str = home_path.to_string_lossy().to_string();

    // If macOS, try to run `df -k` for exact APFS shared container spaces matching node backend
    if cfg!(target_os = "macos") {
        if let Ok(output) = prepare_command("df")
            .args(&["-k", &home_dir_str])
            .output()
        {
            if output.status.success() {
                let stdout = String::from_utf8_lossy(&output.stdout);
                let lines: Vec<&str> = stdout.trim().split('\n').collect();
                if lines.len() >= 2 {
                    let parts: Vec<&str> = lines[1].split_whitespace().collect();
                    if parts.len() >= 4 {
                        let total_kb: u64 = parts[1].parse().unwrap_or(0);
                        let volume_used_kb: u64 = parts[2].parse().unwrap_or(0);
                        let available_kb: u64 = parts[3].parse().unwrap_or(0);
                        
                        let other_kb = total_kb.saturating_sub(available_kb).saturating_sub(volume_used_kb);
                        let percentage = if total_kb > 0 {
                            (((total_kb.saturating_sub(available_kb)) as f64 / total_kb as f64) * 100.0) as u32
                        } else {
                            0
                        };

                        return Ok(DiskSpaceInfo {
                            total: total_kb * 1024,
                            used: volume_used_kb * 1024,
                            available: available_kb * 1024,
                            other: other_kb * 1024,
                            percentage,
                            home_dir: home_dir_str,
                        });
                    }
                }
            }
        }
    }

    // Fallback/Windows/Android: Use sysinfo
    use sysinfo::Disks;
    let disks = Disks::new_with_refreshed_list();
    let mut best_match = None;
    let mut best_len = 0;

    for disk in &disks {
        let mount_path = disk.mount_point();
        if home_path.starts_with(mount_path) {
            let len = mount_path.to_string_lossy().len();
            if len > best_len {
                best_len = len;
                best_match = Some(disk);
            }
        }
    }

    if let Some(disk) = best_match {
        let total = disk.total_space();
        let available = disk.available_space();
        let used = total.saturating_sub(available);
        let percentage = if total > 0 {
            ((used as f64 / total as f64) * 100.0) as u32
        } else {
            0
        };

        Ok(DiskSpaceInfo {
            total,
            used,
            available,
            other: 0,
            percentage,
            home_dir: home_dir_str,
        })
    } else {
        Err("Unable to retrieve disk information".to_string())
    }
}

#[tauri::command]
fn start_scan(
    scan_path: String,
    state: State<'_, AppState>,
    app_handle: AppHandle,
) -> Result<String, String> {
    let target_path = PathBuf::from(&scan_path);
    if !target_path.exists() {
        return Err("Target path does not exist".to_string());
    }

    // Cancel active scan
    if state.scan_active.load(Ordering::Relaxed) {
        state.scan_cancelled.store(true, Ordering::Relaxed);
        std::thread::sleep(std::time::Duration::from_millis(300));
    }

    state.scan_active.store(true, Ordering::Relaxed);
    state.scan_cancelled.store(false, Ordering::Relaxed);

    {
        let mut progress = state.progress.lock().unwrap();
        progress.active = true;
        progress.cancelled = false;
        progress.current_path = scan_path.clone();
        progress.folders_scanned = 0;
        progress.files_scanned = 0;
        progress.total_size_calculated = 0;
        progress.top_files.clear();
        progress.error = None;
    }

    {
        let mut tree = state.tree.lock().unwrap();
        tree.clear();
    }

    let scan_cancelled = state.scan_cancelled.clone();
    let scan_active = state.scan_active.clone();
    let progress_state = state.progress.clone();
    let tree_state = state.tree.clone();
    let handle_clone = app_handle.clone();

    std::thread::spawn(move || {
        let home = handle_clone.path().home_dir().unwrap_or_else(|_| PathBuf::from("/"));
        let home_dir_str = home.to_string_lossy().to_string();
        let last_emit = Arc::new(Mutex::new(Instant::now()));

        scan_directory_recursive(
            &target_path,
            &home_dir_str,
            &progress_state,
            &tree_state,
            &scan_cancelled,
            &handle_clone,
            &last_emit,
        );

        let is_cancelled = scan_cancelled.load(Ordering::Relaxed);
        scan_active.store(false, Ordering::Relaxed);

        {
            let mut progress = progress_state.lock().unwrap();
            progress.active = false;
            progress.cancelled = is_cancelled;
        }

        let final_progress = progress_state.lock().unwrap();
        let _ = handle_clone.emit("scan-progress", &*final_progress);
    });

    Ok("Scan started".to_string())
}

#[tauri::command]
fn cancel_scan(state: State<'_, AppState>) -> Result<String, String> {
    if state.scan_active.load(Ordering::Relaxed) {
        state.scan_cancelled.store(true, Ordering::Relaxed);
        state.scan_active.store(false, Ordering::Relaxed);
        {
            let mut progress = state.progress.lock().unwrap();
            progress.active = false;
            progress.cancelled = true;
        }
        return Ok("Scan cancellation requested".to_string());
    }
    Ok("No active scan to cancel".to_string())
}

#[tauri::command]
fn get_scan_results(state: State<'_, AppState>) -> Result<ScanResults, String> {
    if state.scan_active.load(Ordering::Relaxed) {
        return Err("Scan is still running".to_string());
    }

    let progress = state.progress.lock().unwrap();
    let tree = state.tree.lock().unwrap();

    Ok(ScanResults {
        tree: tree.clone(),
        top_files: progress.top_files.clone(),
        total_size: progress.total_size_calculated,
        files_count: progress.files_scanned,
        folders_count: progress.folders_scanned,
    })
}

#[tauri::command]
fn delete_paths(paths: Vec<String>, app_handle: AppHandle) -> DeletionSummary {
    let home = app_handle.path().home_dir().unwrap_or_else(|_| PathBuf::from("/"));
    let home_dir_str = home.to_string_lossy().to_string();
    
    let mut results = Vec::new();
    let mut space_freed = 0;
    let cancelled = Arc::new(AtomicBool::new(false));

    for target_path_str in paths {
        let p = Path::new(&target_path_str);
        if !p.exists() {
            results.push(DeletionItemResult {
                path: target_path_str.clone(),
                status: "skipped".to_string(),
                size: 0,
                reason: "Path does not exist".to_string(),
            });
            continue;
        }

        if !is_safe_to_delete(&target_path_str, &home_dir_str) {
            results.push(DeletionItemResult {
                path: target_path_str.clone(),
                status: "error".to_string(),
                size: 0,
                reason: "Access denied: System folder protection active".to_string(),
            });
            continue;
        }

        let metadata = match p.symlink_metadata() {
            Ok(m) => m,
            Err(e) => {
                results.push(DeletionItemResult {
                    path: target_path_str.clone(),
                    status: "error".to_string(),
                    size: 0,
                    reason: e.to_string(),
                });
                continue;
            }
        };

        let mut size = metadata.len();
        let is_dir = metadata.is_dir();

        if is_dir {
            size = get_folder_size_fast(p, &cancelled);
            match fs::remove_dir_all(p) {
                Ok(_) => {
                    space_freed += size;
                    results.push(DeletionItemResult {
                        path: target_path_str.clone(),
                        status: "success".to_string(),
                        size,
                        reason: "".to_string(),
                    });
                }
                Err(e) => {
                    results.push(DeletionItemResult {
                        path: target_path_str.clone(),
                        status: "error".to_string(),
                        size: 0,
                        reason: e.to_string(),
                    });
                }
            }
        } else {
            match fs::remove_file(p) {
                Ok(_) => {
                    space_freed += size;
                    results.push(DeletionItemResult {
                        path: target_path_str.clone(),
                        status: "success".to_string(),
                        size,
                        reason: "".to_string(),
                    });
                }
                Err(e) => {
                    results.push(DeletionItemResult {
                        path: target_path_str.clone(),
                        status: "error".to_string(),
                        size: 0,
                        reason: e.to_string(),
                    });
                }
            }
        }
    }

    DeletionSummary {
        message: "Deletion completed".to_string(),
        results,
        space_freed,
    }
}

#[tauri::command]
fn get_smart_scan_targets(app_handle: AppHandle) -> Vec<SmartTarget> {
    let home = app_handle.path().home_dir().unwrap_or_else(|_| PathBuf::from("/"));
    let mut targets = Vec::new();
    
    if cfg!(target_os = "macos") {
        targets.push(SmartTarget {
            id: "npm".to_string(),
            name: "NPM Cache".to_string(),
            path: home.join(".npm").to_string_lossy().to_string(),
            description: "NPM package registry local cache".to_string(),
            size: 0,
            exists: false,
        });
        targets.push(SmartTarget {
            id: "pip".to_string(),
            name: "Pip Cache".to_string(),
            path: home.join("Library/Caches/pip").to_string_lossy().to_string(),
            description: "Python package download cache".to_string(),
            size: 0,
            exists: false,
        });
        targets.push(SmartTarget {
            id: "yarn".to_string(),
            name: "Yarn Cache".to_string(),
            path: home.join("Library/Caches/Yarn").to_string_lossy().to_string(),
            description: "Yarn package caching directory".to_string(),
            size: 0,
            exists: false,
        });
        targets.push(SmartTarget {
            id: "cargo".to_string(),
            name: "Cargo Cache".to_string(),
            path: home.join(".cargo/registry").to_string_lossy().to_string(),
            description: "Rust Cargo dependency cache".to_string(),
            size: 0,
            exists: false,
        });
        targets.push(SmartTarget {
            id: "xcode".to_string(),
            name: "Xcode DerivedData".to_string(),
            path: home.join("Library/Developer/Xcode/DerivedData").to_string_lossy().to_string(),
            description: "Xcode build outputs and indexes".to_string(),
            size: 0,
            exists: false,
        });
        targets.push(SmartTarget {
            id: "caches".to_string(),
            name: "System Cache".to_string(),
            path: home.join("Library/Caches").to_string_lossy().to_string(),
            description: "General applications caches".to_string(),
            size: 0,
            exists: false,
        });
        targets.push(SmartTarget {
            id: "logs".to_string(),
            name: "User Logs".to_string(),
            path: home.join("Library/Logs").to_string_lossy().to_string(),
            description: "User applications debug logs".to_string(),
            size: 0,
            exists: false,
        });
        targets.push(SmartTarget {
            id: "trash".to_string(),
            name: "Trash Bin".to_string(),
            path: home.join(".Trash").to_string_lossy().to_string(),
            description: "Files moved to trash".to_string(),
            size: 0,
            exists: false,
        });
    } else if cfg!(target_os = "windows") {
        let appdata = std::env::var("APPDATA").map(PathBuf::from).unwrap_or_else(|_| home.clone());
        let localappdata = std::env::var("LOCALAPPDATA").map(PathBuf::from).unwrap_or_else(|_| home.clone());
        
        targets.push(SmartTarget {
            id: "npm".to_string(),
            name: "NPM Cache".to_string(),
            path: appdata.join("npm-cache").to_string_lossy().to_string(),
            description: "NPM package registry local cache".to_string(),
            size: 0,
            exists: false,
        });
        targets.push(SmartTarget {
            id: "pip".to_string(),
            name: "Pip Cache".to_string(),
            path: localappdata.join("pip/Cache").to_string_lossy().to_string(),
            description: "Python package download cache".to_string(),
            size: 0,
            exists: false,
        });
        targets.push(SmartTarget {
            id: "cargo".to_string(),
            name: "Cargo Cache".to_string(),
            path: home.join(".cargo/registry").to_string_lossy().to_string(),
            description: "Rust Cargo dependency cache".to_string(),
            size: 0,
            exists: false,
        });
        targets.push(SmartTarget {
            id: "caches".to_string(),
            name: "System Temp".to_string(),
            path: localappdata.join("Temp").to_string_lossy().to_string(),
            description: "Windows temporary files".to_string(),
            size: 0,
            exists: false,
        });
    } else {
        // Fallback / Linux
        targets.push(SmartTarget {
            id: "npm".to_string(),
            name: "NPM Cache".to_string(),
            path: home.join(".npm").to_string_lossy().to_string(),
            description: "NPM package registry local cache".to_string(),
            size: 0,
            exists: false,
        });
        targets.push(SmartTarget {
            id: "cargo".to_string(),
            name: "Cargo Cache".to_string(),
            path: home.join(".cargo/registry").to_string_lossy().to_string(),
            description: "Rust Cargo dependency cache".to_string(),
            size: 0,
            exists: false,
        });
    }
    
    // Calculate sizes
    let cancelled = Arc::new(AtomicBool::new(false));
    for t in &mut targets {
        let p = Path::new(&t.path);
        if p.exists() {
            t.exists = true;
            t.size = get_folder_size_fast(p, &cancelled);
        }
    }
    
    targets
}

#[tauri::command]
fn run_docker_prune() -> Result<DockerPruneResult, String> {
    let docker_info = prepare_command("docker")
        .arg("info")
        .output();

    match docker_info {
        Ok(output) if output.status.success() => {
            let prune_output = prepare_command("docker")
                .args(&["system", "prune", "-af", "--volumes"])
                .output();

            match prune_output {
                Ok(out) => Ok(DockerPruneResult {
                    success: out.status.success(),
                    log: String::from_utf8_lossy(&out.stdout).to_string(),
                    error: String::from_utf8_lossy(&out.stderr).to_string(),
                }),
                Err(e) => Err(format!("Failed to run docker system prune: {}", e)),
            }
        }
        _ => {
            Err("Docker is not running or not accessible. Make sure Docker Desktop is started.".to_string())
        }
    }
}

#[tauri::command]
fn run_terminal_command(
    command: String,
    cwd: Option<String>,
    app_handle: AppHandle,
) -> TerminalResult {
    let home = app_handle.path().home_dir().unwrap_or_else(|_| PathBuf::from("/"));
    let current_cwd = cwd
        .map(PathBuf::from)
        .and_then(|p| p.canonicalize().ok())
        .unwrap_or_else(|| home.clone());

    let trimmed = command.trim();
    if trimmed.starts_with("cd ") || trimmed == "cd" {
        let mut target_dir = home;
        if trimmed.starts_with("cd ") {
            target_dir = current_cwd.join(trimmed[3..].trim());
        }

        if target_dir.exists() {
            if target_dir.is_dir() {
                return TerminalResult {
                    stdout: "".to_string(),
                    stderr: "".to_string(),
                    cwd: target_dir.to_string_lossy().to_string(),
                };
            } else {
                return TerminalResult {
                    stdout: "".to_string(),
                    stderr: format!("cd: not a directory: {}", target_dir.to_string_lossy()),
                    cwd: current_cwd.to_string_lossy().to_string(),
                };
            }
        } else {
            return TerminalResult {
                stdout: "".to_string(),
                stderr: format!("cd: no such file or directory: {}", target_dir.to_string_lossy()),
                cwd: current_cwd.to_string_lossy().to_string(),
            };
        }
    }

    let output_res = if cfg!(target_os = "windows") {
        prepare_command("cmd")
            .args(&["/C", trimmed])
            .current_dir(&current_cwd)
            .output()
    } else {
        prepare_command("sh")
            .args(&["-c", trimmed])
            .current_dir(&current_cwd)
            .output()
    };

    match output_res {
        Ok(output) => TerminalResult {
            stdout: String::from_utf8_lossy(&output.stdout).to_string(),
            stderr: String::from_utf8_lossy(&output.stderr).to_string(),
            cwd: current_cwd.to_string_lossy().to_string(),
        },
        Err(err) => TerminalResult {
            stdout: "".to_string(),
            stderr: err.to_string(),
            cwd: current_cwd.to_string_lossy().to_string(),
        },
    }
}

// ----------------- TAURI INITIALIZATION -----------------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_log::Builder::default().build())
        .manage(AppState {
            scan_cancelled: Arc::new(AtomicBool::new(false)),
            scan_active: Arc::new(AtomicBool::new(false)),
            progress: Arc::new(Mutex::new(ScanProgress {
                active: false,
                cancelled: false,
                current_path: "".to_string(),
                folders_scanned: 0,
                files_scanned: 0,
                total_size_calculated: 0,
                top_files: Vec::new(),
                error: None,
            })),
            tree: Arc::new(Mutex::new(HashMap::new())),
        })
        .invoke_handler(tauri::generate_handler![
            get_disk_space,
            start_scan,
            cancel_scan,
            get_scan_results,
            delete_paths,
            get_smart_scan_targets,
            run_docker_prune,
            run_terminal_command
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
