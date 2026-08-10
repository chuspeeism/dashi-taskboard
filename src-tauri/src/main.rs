#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File, OpenOptions},
    io::{BufRead, BufReader, Write},
    net::TcpListener,
    os::{fd::AsRawFd, unix::process::CommandExt},
    path::{Path, PathBuf},
    process::{Command as StdCommand, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    ActivationPolicy, AppHandle, Emitter, Manager,
};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_updater::{Update, UpdaterExt};
use uuid::Uuid;

const STOP_TIMEOUT: Duration = Duration::from_secs(5);
const TASKBOARD_LISTEN_FD: i32 = 5;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LauncherSnapshot {
    phase: String,
    message: String,
    update_message: String,
    update_available: bool,
    version: String,
    app_path: Option<String>,
    child_pid: Option<u32>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct LauncherPidRecord {
    pid: u32,
    node_path: PathBuf,
    injector_path: PathBuf,
}

struct LauncherState {
    child: Mutex<Option<u32>>,
    snapshot: Mutex<LauncherSnapshot>,
    intentional_stop: AtomicBool,
    update_flow_in_progress: AtomicBool,
    update_in_progress: AtomicBool,
    generation: AtomicU64,
    lifecycle: Mutex<()>,
    taskboard_listener: Mutex<Option<TcpListener>>,
    _instance_lock: File,
    data_directory: PathBuf,
    log_path: PathBuf,
    pid_record_path: PathBuf,
}

impl LauncherState {
    fn new(
        data_directory: PathBuf,
        log_directory: PathBuf,
        version: String,
        instance_lock: File,
    ) -> Self {
        Self {
            child: Mutex::new(None),
            snapshot: Mutex::new(LauncherSnapshot {
                phase: "starting".into(),
                message: "正在启动任务面板…".into(),
                update_message: "启动后将自动检查更新。".into(),
                update_available: false,
                version,
                app_path: None,
                child_pid: None,
            }),
            intentional_stop: AtomicBool::new(false),
            update_flow_in_progress: AtomicBool::new(false),
            update_in_progress: AtomicBool::new(false),
            generation: AtomicU64::new(0),
            lifecycle: Mutex::new(()),
            taskboard_listener: Mutex::new(None),
            _instance_lock: instance_lock,
            pid_record_path: data_directory.join("launcher-child.json"),
            data_directory,
            log_path: log_directory.join("codex-taskboard-launcher.log"),
        }
    }
}

fn acquire_instance_lock(path: &Path) -> Result<Option<File>, std::io::Error> {
    let file = OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .open(path)?;
    let result = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
    if result == 0 {
        Ok(Some(file))
    } else {
        let error = std::io::Error::last_os_error();
        if error.kind() == std::io::ErrorKind::WouldBlock {
            Ok(None)
        } else {
            Err(error)
        }
    }
}

fn copy_directory(source: &Path, destination: &Path) -> Result<(), std::io::Error> {
    fs::create_dir_all(destination)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let destination = destination.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_directory(&entry.path(), &destination)?;
        } else {
            fs::copy(entry.path(), destination)?;
        }
    }
    Ok(())
}

fn taskboard_listener(state: &LauncherState) -> Result<(i32, u16), String> {
    let mut listener = state.taskboard_listener.lock().unwrap();
    if listener.is_none() {
        *listener = Some(TcpListener::bind(("127.0.0.1", 0)).map_err(|error| error.to_string())?);
    }
    let listener = listener.as_ref().unwrap();
    let port = listener
        .local_addr()
        .map_err(|error| error.to_string())?
        .port();
    Ok((listener.as_raw_fd(), port))
}

fn update_snapshot(
    app: &AppHandle,
    state: &Arc<LauncherState>,
    update: impl FnOnce(&mut LauncherSnapshot),
) -> LauncherSnapshot {
    let snapshot = {
        let mut snapshot = state.snapshot.lock().unwrap();
        update(&mut snapshot);
        snapshot.clone()
    };
    let _ = app.emit("launcher-status", snapshot.clone());
    snapshot
}

fn append_log(state: &LauncherState, line: &str) {
    if let Ok(mut file) = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&state.log_path)
    {
        let _ = writeln!(file, "{line}");
    }
}

fn show_error_dialog(app: &AppHandle, title: &str, message: &str) {
    app.dialog()
        .message(message)
        .title(title)
        .kind(MessageDialogKind::Error)
        .buttons(MessageDialogButtons::OkCustom("关闭".into()))
        .blocking_show();
}

fn find_codex_app(home_directory: &Path) -> Option<PathBuf> {
    [
        PathBuf::from("/Applications/ChatGPT.app"),
        home_directory.join("Applications/ChatGPT.app"),
        PathBuf::from("/Applications/Codex.app"),
        home_directory.join("Applications/Codex.app"),
    ]
    .into_iter()
    .find(|candidate| candidate.is_dir())
}

fn send_process_group_signal(pid: u32, signal: i32) {
    unsafe {
        if libc::kill(-(pid as i32), signal) != 0 {
            libc::kill(pid as i32, signal);
        }
    }
}

fn process_group_is_running(pid: u32) -> bool {
    unsafe { libc::kill(-(pid as i32), 0) == 0 }
}

fn wait_for_process_group_exit(pid: u32, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while process_group_is_running(pid) && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(100));
    }
    !process_group_is_running(pid)
}

fn terminate_process_group(pid: u32) {
    send_process_group_signal(pid, libc::SIGTERM);
    if !wait_for_process_group_exit(pid, STOP_TIMEOUT) {
        send_process_group_signal(pid, libc::SIGKILL);
        let _ = wait_for_process_group_exit(pid, Duration::from_secs(1));
    }
}

fn process_matches_record(record: &LauncherPidRecord) -> bool {
    let output = StdCommand::new("/bin/ps")
        .args(["-p", &record.pid.to_string(), "-o", "command="])
        .output();
    let Ok(output) = output else {
        return false;
    };
    let command = String::from_utf8_lossy(&output.stdout);
    let command = command.trim_start();
    command.starts_with(&*record.node_path.to_string_lossy())
        && command.contains(&*record.injector_path.to_string_lossy())
}

fn stop_recorded_child(state: &LauncherState) {
    let record = fs::read_to_string(&state.pid_record_path)
        .ok()
        .and_then(|content| serde_json::from_str::<LauncherPidRecord>(&content).ok());
    if let Some(record) = record {
        if process_matches_record(&record) {
            terminate_process_group(record.pid);
        }
    }
    let _ = fs::remove_file(&state.pid_record_path);
}

fn write_pid_record(
    state: &LauncherState,
    pid: u32,
    node_path: PathBuf,
    injector_path: PathBuf,
) -> Result<(), String> {
    let record = LauncherPidRecord {
        pid,
        node_path,
        injector_path,
    };
    let content = serde_json::to_vec(&record).map_err(|error| error.to_string())?;
    fs::write(&state.pid_record_path, content).map_err(|error| error.to_string())
}

fn clear_pid_record(state: &LauncherState, pid: u32) {
    let matches = fs::read_to_string(&state.pid_record_path)
        .ok()
        .and_then(|content| serde_json::from_str::<LauncherPidRecord>(&content).ok())
        .is_some_and(|record| record.pid == pid);
    if matches {
        let _ = fs::remove_file(&state.pid_record_path);
    }
}

fn stop_managed_child_locked(app: &AppHandle, state: &Arc<LauncherState>) {
    state.generation.fetch_add(1, Ordering::SeqCst);
    state.intentional_stop.store(true, Ordering::SeqCst);
    if let Some(pid) = state.child.lock().unwrap().take() {
        append_log(state, &format!("Stopping launcher child {pid}"));
        terminate_process_group(pid);
        clear_pid_record(state, pid);
    }
    update_snapshot(app, state, |snapshot| {
        snapshot.phase = "stopped".into();
        snapshot.message = "任务面板已停止。".into();
        snapshot.child_pid = None;
    });
}

fn stop_managed_child(app: &AppHandle, state: &Arc<LauncherState>) {
    let _lifecycle = state.lifecycle.lock().unwrap();
    stop_managed_child_locked(app, state);
}

fn watch_launcher_output<R: std::io::Read + Send + 'static>(
    reader: R,
    is_stderr: bool,
    app: AppHandle,
    state: Arc<LauncherState>,
) {
    thread::spawn(move || {
        for line in BufReader::new(reader).lines().map_while(Result::ok) {
            append_log(&state, &line);
            if is_stderr && line.contains("Waiting for Codex") {
                update_snapshot(&app, &state, |snapshot| {
                    snapshot.phase = "starting".into();
                    snapshot.message = "正在等待 Codex 窗口…".into();
                });
            } else if !is_stderr && line.contains("Codex Taskboard listening") {
                update_snapshot(&app, &state, |snapshot| {
                    snapshot.phase = "starting".into();
                    snapshot.message = "任务面板服务已启动，正在注入 Codex…".into();
                });
            } else if !is_stderr && line.contains("\"injected\"") {
                update_snapshot(&app, &state, |snapshot| {
                    snapshot.phase = "running".into();
                    snapshot.message = "任务面板已在 Codex 客户端中打开。".into();
                });
            }
        }
    });
}

fn start_launcher_locked(
    app: &AppHandle,
    state: &Arc<LauncherState>,
) -> Result<LauncherSnapshot, String> {
    if state.child.lock().unwrap().is_some() {
        return Ok(state.snapshot.lock().unwrap().clone());
    }

    let home_directory = app.path().home_dir().map_err(|error| error.to_string())?;
    let codex_app = find_codex_app(&home_directory).ok_or_else(|| {
        "未找到官方 ChatGPT.app 或 Codex.app。请先安装到 Applications 文件夹。".to_string()
    })?;
    let resource_directory = app
        .path()
        .resource_dir()
        .map_err(|error| error.to_string())?;
    let app_root = resource_directory.join("app");
    let injector_path = app_root.join("scripts/codex-injector.mjs");
    let node_path = std::env::current_exe()
        .map_err(|error| error.to_string())?
        .parent()
        .ok_or_else(|| "无法定位 App 可执行文件目录".to_string())?
        .join("node");
    stop_recorded_child(state);
    let generation = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
    state.intentional_stop.store(false, Ordering::SeqCst);
    update_snapshot(app, state, |snapshot| {
        snapshot.phase = "starting".into();
        snapshot.message = "正在启动任务面板服务…".into();
        snapshot.app_path = Some(codex_app.display().to_string());
    });

    let path_value = format!(
        "{}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
        resource_directory.join("bin").display()
    );
    let (taskboard_listener_fd, taskboard_port) = taskboard_listener(state)?;
    let instance_token = Uuid::new_v4().to_string();
    let instance_secret = Uuid::new_v4().to_string();
    let version = state.snapshot.lock().unwrap().version.clone();
    let codex_profile = state.data_directory.join("codex-profile");
    let codex_source_profile = home_directory.join("Library/Application Support/Codex");
    let mut command = StdCommand::new(&node_path);
    command
        .arg(&injector_path)
        .args(["--launch", "--watch", "--open", "--cdp-pipe"])
        .args(["--startup-token", &instance_token, "--app-path"])
        .arg(&codex_app)
        .env("CODEX_TASKBOARD_DATA_DIR", &state.data_directory)
        .env(
            "CODEX_TASKBOARD_RUNTIME_FILE",
            state.data_directory.join("launcher-runtime.json"),
        )
        .env("CODEX_TASKBOARD_LISTEN_FD", TASKBOARD_LISTEN_FD.to_string())
        .env("CODEX_TASKBOARD_HOST", "127.0.0.1")
        .env("CODEX_TASKBOARD_PORT", taskboard_port.to_string())
        .env("CODEX_TASKBOARD_INSTANCE_TOKEN", &instance_token)
        .env("CODEX_TASKBOARD_INSTANCE_SECRET", &instance_secret)
        .env("CODEX_TASKBOARD_VERSION", &version)
        .env(
            "CODEX_TASKBOARD_CODEX_PROFILE",
            codex_profile.to_string_lossy().as_ref(),
        )
        .env(
            "CODEX_TASKBOARD_CODEX_SOURCE_PROFILE",
            codex_source_profile.to_string_lossy().as_ref(),
        )
        .env("HOST", "127.0.0.1")
        .env("PATH", path_value)
        .current_dir(&app_root)
        .process_group(0)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    unsafe {
        command.pre_exec(move || {
            if libc::dup2(taskboard_listener_fd, TASKBOARD_LISTEN_FD) < 0 {
                return Err(std::io::Error::last_os_error());
            }
            if libc::fcntl(TASKBOARD_LISTEN_FD, libc::F_SETFD, 0) < 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let mut child = command.spawn().map_err(|error| error.to_string())?;
    let pid = child.id();
    if let Err(error) = write_pid_record(state, pid, node_path, injector_path) {
        send_process_group_signal(pid, libc::SIGKILL);
        let _ = child.wait();
        return Err(error);
    }
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    *state.child.lock().unwrap() = Some(pid);
    let snapshot = update_snapshot(app, state, |snapshot| {
        snapshot.child_pid = Some(pid);
    });
    append_log(
        state,
        &format!(
            "Started launcher child {pid} on Taskboard {taskboard_port} with private CDP pipe"
        ),
    );
    if let Some(stdout) = stdout {
        watch_launcher_output(stdout, false, app.clone(), state.clone());
    }
    if let Some(stderr) = stderr {
        watch_launcher_output(stderr, true, app.clone(), state.clone());
    }

    let event_app = app.clone();
    let event_state = state.clone();
    thread::spawn(move || {
        let status = child.wait();
        append_log(
            &event_state,
            &format!("Launcher child {pid} exited: {status:?}"),
        );
        terminate_process_group(pid);
        if event_state.generation.load(Ordering::SeqCst) != generation {
            return;
        }
        let mut current_child = event_state.child.lock().unwrap();
        if *current_child != Some(pid) {
            return;
        }
        *current_child = None;
        drop(current_child);
        clear_pid_record(&event_state, pid);
        let intentional = event_state.intentional_stop.load(Ordering::SeqCst);
        update_snapshot(&event_app, &event_state, |snapshot| {
            snapshot.child_pid = None;
            if !intentional {
                snapshot.phase = "error".into();
                snapshot.message = "任务面板进程已退出，正在恢复…".into();
            }
        });
        if intentional {
            return;
        }
        thread::sleep(Duration::from_secs(2));
        let recovery_result = {
            let _lifecycle = event_state.lifecycle.lock().unwrap();
            if event_state.generation.load(Ordering::SeqCst) != generation
                || event_state.intentional_stop.load(Ordering::SeqCst)
                || event_state.update_in_progress.load(Ordering::SeqCst)
            {
                return;
            }
            start_launcher_locked(&event_app, &event_state)
        };
        if let Err(error) = recovery_result {
            append_log(&event_state, &format!("Launcher recovery failed: {error}"));
            update_snapshot(&event_app, &event_state, |snapshot| {
                snapshot.phase = "error".into();
                snapshot.message = error.clone();
            });
            show_error_dialog(
                &event_app,
                "Codex Taskboard 恢复失败",
                &format!("任务面板进程无法恢复：{error}\n\n请重新打开 App。"),
            );
        }
    });
    Ok(snapshot)
}

fn start_launcher(app: &AppHandle, state: &Arc<LauncherState>) -> Result<LauncherSnapshot, String> {
    let _lifecycle = state.lifecycle.lock().unwrap();
    if state.intentional_stop.load(Ordering::SeqCst)
        || state.update_in_progress.load(Ordering::SeqCst)
    {
        return Ok(state.snapshot.lock().unwrap().clone());
    }
    start_launcher_locked(app, state)
}

fn restart_launcher(
    app: &AppHandle,
    state: &Arc<LauncherState>,
) -> Result<LauncherSnapshot, String> {
    let _lifecycle = state.lifecycle.lock().unwrap();
    if state.intentional_stop.load(Ordering::SeqCst) {
        return Ok(state.snapshot.lock().unwrap().clone());
    }
    if state.update_in_progress.load(Ordering::SeqCst) {
        append_log(state, "Launcher reopen ignored during update installation");
        return Ok(state.snapshot.lock().unwrap().clone());
    }
    stop_managed_child_locked(app, state);
    let result = start_launcher_locked(app, state);
    if result.is_err() {
        state.intentional_stop.store(false, Ordering::SeqCst);
    }
    result
}

async fn check_for_startup_update(
    app: &AppHandle,
    state: &Arc<LauncherState>,
) -> Result<Option<Update>, String> {
    update_snapshot(app, state, |snapshot| {
        snapshot.update_message = "正在检查更新…".into();
        snapshot.update_available = false;
    });
    let update = app
        .updater()
        .map_err(|error| error.to_string())?
        .check()
        .await
        .map_err(|error| error.to_string())?;
    match &update {
        Some(update) => {
            append_log(state, &format!("Update {} is available", update.version));
            update_snapshot(app, state, |snapshot| {
                snapshot.update_message =
                    format!("发现新版本 {}，可以下载并安装。", update.version);
                snapshot.update_available = true;
            });
        }
        None => {
            append_log(state, "No update is available");
            update_snapshot(app, state, |snapshot| {
                snapshot.update_message = "当前已是最新版本。".into();
                snapshot.update_available = false;
            });
        }
    }
    Ok(update)
}

async fn install_update(
    app: &AppHandle,
    state: &Arc<LauncherState>,
    update: Update,
) -> Result<(), String> {
    let update_version = update.version.clone();
    update_snapshot(app, state, |snapshot| {
        snapshot.update_message = format!("正在下载版本 {update_version}…");
        snapshot.update_available = false;
    });
    let progress_app = app.clone();
    let progress_state = Arc::clone(state);
    let progress_version = update_version.clone();
    let finish_app = app.clone();
    let finish_state = Arc::clone(state);
    let mut downloaded = 0_u64;
    let bytes = match update
        .download(
            move |chunk_length, content_length| {
                downloaded = downloaded.saturating_add(chunk_length as u64);
                update_snapshot(&progress_app, &progress_state, |snapshot| {
                    snapshot.update_message = match content_length.filter(|total| *total > 0) {
                        Some(total) => format!(
                            "正在下载版本 {progress_version}：{}%",
                            downloaded
                                .saturating_mul(100)
                                .saturating_div(total)
                                .min(100)
                        ),
                        None => format!("正在下载版本 {progress_version}…"),
                    };
                });
            },
            move || {
                update_snapshot(&finish_app, &finish_state, |snapshot| {
                    snapshot.update_message = "下载完成，正在验证更新签名…".into();
                });
            },
        )
        .await
    {
        Ok(bytes) => bytes,
        Err(error) => {
            append_log(state, &format!("Update download failed: {error}"));
            update_snapshot(app, state, |snapshot| {
                snapshot.update_message = format!("更新下载或签名验证失败：{error}");
                snapshot.update_available = true;
            });
            return Err(error.to_string());
        }
    };

    update_snapshot(app, state, |snapshot| {
        snapshot.update_message = "更新签名验证通过，正在安装…".into();
    });
    {
        let _lifecycle = state.lifecycle.lock().unwrap();
        if state.intentional_stop.load(Ordering::SeqCst) {
            return Err("App exit is in progress".into());
        }
        state.update_in_progress.store(true, Ordering::SeqCst);
        stop_managed_child_locked(app, state);
    }
    if let Err(error) = update.install(&bytes) {
        append_log(state, &format!("Update installation failed: {error}"));
        let restart_error = {
            let _lifecycle = state.lifecycle.lock().unwrap();
            let restart_error = start_launcher_locked(app, state).err();
            state.intentional_stop.store(false, Ordering::SeqCst);
            state.update_in_progress.store(false, Ordering::SeqCst);
            restart_error
        };
        if let Some(restart_error) = &restart_error {
            append_log(
                state,
                &format!("Taskboard restart after update failure failed: {restart_error}"),
            );
        } else {
            append_log(
                state,
                "Taskboard restarted after update installation failure",
            );
        }
        update_snapshot(app, state, |snapshot| {
            snapshot.update_message = format!("更新安装失败：{error}");
            snapshot.update_available = true;
            if let Some(restart_error) = &restart_error {
                snapshot.phase = "error".into();
                snapshot.message = format!("任务面板恢复失败：{restart_error}");
            }
        });
        return Err(error.to_string());
    }

    append_log(
        state,
        &format!("Installed update {update_version}; restarting"),
    );
    update_snapshot(app, state, |snapshot| {
        snapshot.update_message = format!("版本 {update_version} 已安装，正在重启…");
    });
    app.restart()
}

fn finish_update_flow(state: &LauncherState, check_update: &MenuItem<tauri::Wry>) {
    state.update_flow_in_progress.store(false, Ordering::SeqCst);
    check_update.set_enabled(true).unwrap();
}

async fn offer_update(
    app: &AppHandle,
    state: &Arc<LauncherState>,
    check_update: &MenuItem<tauri::Wry>,
    show_current_version: bool,
) {
    if state
        .update_flow_in_progress
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return;
    }
    let update = match check_for_startup_update(app, state).await {
        Ok(update) => update,
        Err(error) => {
            append_log(state, &format!("Update check failed: {error}"));
            if show_current_version {
                show_error_dialog(
                    app,
                    "Codex Taskboard 更新检查失败",
                    &format!("无法检查更新。请稍后重试。\n\n{error}"),
                );
            }
            finish_update_flow(state, check_update);
            return;
        }
    };
    let Some(update) = update else {
        if show_current_version {
            app.dialog()
                .message("当前已是最新版本。")
                .title("Codex Taskboard 更新")
                .buttons(MessageDialogButtons::Ok)
                .blocking_show();
        }
        finish_update_flow(state, check_update);
        return;
    };

    let version = update.version.clone();
    append_log(state, &format!("Showing update prompt for {version}"));
    let install_now = app
        .dialog()
        .message(format!(
            "发现 Codex Taskboard {version}。是否现在下载、安装并重启？"
        ))
        .title("Codex Taskboard 更新")
        .buttons(MessageDialogButtons::OkCancelCustom(
            "立即更新".into(),
            "稍后".into(),
        ))
        .blocking_show();
    if !install_now {
        append_log(state, &format!("Update {version} deferred by user"));
        finish_update_flow(state, check_update);
        return;
    }
    append_log(state, &format!("Update {version} accepted by user"));
    if let Err(error) = install_update(app, state, update).await {
        append_log(state, &format!("Update installation failed: {error}"));
        let service_recovered = state.snapshot.lock().unwrap().child_pid.is_some();
        let service_message = if service_recovered {
            "任务面板服务已恢复。"
        } else {
            "任务面板服务未能恢复，请重新打开 App。"
        };
        show_error_dialog(
            app,
            "Codex Taskboard 更新失败",
            &format!("更新未完成。{service_message}\n\n请稍后重试。详情见启动日志。\n\n{error}"),
        );
        finish_update_flow(state, check_update);
    }
}

fn main() {
    let app = tauri::Builder::default()
        .enable_macos_default_menu(false)
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            app.set_activation_policy(ActivationPolicy::Accessory);
            let home_directory = app.path().home_dir()?;
            let bundled_skill = app
                .path()
                .resource_dir()?
                .join("app/skills/manage-taskboard");
            let global_skill = home_directory.join(".agents/skills/manage-taskboard");
            if global_skill.exists() {
                fs::remove_dir_all(&global_skill)?;
            }
            copy_directory(&bundled_skill, &global_skill)?;
            let data_directory = home_directory.join("Library/Application Support/Codex Taskboard");
            let log_directory = home_directory.join("Library/Logs/Codex Taskboard");
            fs::create_dir_all(&data_directory)?;
            fs::create_dir_all(&log_directory)?;
            let Some(instance_lock) = acquire_instance_lock(&data_directory.join("launcher.lock"))?
            else {
                app.handle().exit(0);
                return Ok(());
            };
            let version = app.package_info().version.to_string();
            let state = Arc::new(LauncherState::new(
                data_directory,
                log_directory,
                version,
                instance_lock,
            ));
            app.manage(state.clone());

            let check_update =
                MenuItem::with_id(app, "check-update", "检查更新", false, None::<&str>)?;
            let restart_codex =
                MenuItem::with_id(app, "restart-codex", "重新启动 Codex", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let tray_menu = Menu::with_items(app, &[&check_update, &restart_codex, &quit])?;
            let check_update_menu = check_update.clone();
            TrayIconBuilder::new()
                .icon(tauri::include_image!("icons/tray-codex.png"))
                .icon_as_template(true)
                .tooltip("Codex Taskboard")
                .menu(&tray_menu)
                .on_menu_event(move |app, event| match event.id().as_ref() {
                    "check-update" => {
                        let Some(state) = app.try_state::<Arc<LauncherState>>() else {
                            return;
                        };
                        check_update_menu.set_enabled(false).unwrap();
                        let state = Arc::clone(state.inner());
                        let app = app.clone();
                        let check_update = check_update_menu.clone();
                        tauri::async_runtime::spawn(async move {
                            offer_update(&app, &state, &check_update, true).await;
                        });
                    }
                    "restart-codex" => {
                        let Some(state) = app.try_state::<Arc<LauncherState>>() else {
                            return;
                        };
                        let state = Arc::clone(state.inner());
                        let app = app.clone();
                        tauri::async_runtime::spawn_blocking(move || {
                            if let Err(error) = restart_launcher(&app, &state) {
                                append_log(
                                    &state,
                                    &format!("Launcher menu restart failed: {error}"),
                                );
                                show_error_dialog(
                                    &app,
                                    "Codex Taskboard 启动失败",
                                    &format!("{error}\n\n请确认官方 Codex/ChatGPT App 已安装。"),
                                );
                            }
                        });
                    }
                    "quit" => {
                        let Some(state) = app.try_state::<Arc<LauncherState>>() else {
                            return;
                        };
                        let lifecycle = state.lifecycle.lock().unwrap();
                        if state.update_in_progress.load(Ordering::SeqCst) {
                            return;
                        }
                        stop_managed_child_locked(app, &state);
                        drop(lifecycle);
                        app.exit(0);
                    }
                    _ => {}
                })
                .build(app)?;

            let app_handle = app.handle().clone();
            let startup_check_update = check_update.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(error) = start_launcher(&app_handle, &state) {
                    append_log(&state, &format!("Launcher startup failed: {error}"));
                    update_snapshot(&app_handle, &state, |snapshot| {
                        snapshot.phase = "error".into();
                        snapshot.message = error.clone();
                    });
                    show_error_dialog(
                        &app_handle,
                        "Codex Taskboard 启动失败",
                        &format!(
                            "{error}\n\n请确认官方 Codex/ChatGPT App 已安装。详情见启动日志。"
                        ),
                    );
                }
                offer_update(&app_handle, &state, &startup_check_update, false).await;
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build Codex Taskboard");

    app.run(|app_handle, event| match event {
        #[cfg(target_os = "macos")]
        tauri::RunEvent::Reopen { .. } => {
            let Some(state) = app_handle.try_state::<Arc<LauncherState>>() else {
                return;
            };
            if let Err(error) = restart_launcher(app_handle, &state) {
                append_log(&state, &format!("Launcher reopen failed: {error}"));
                show_error_dialog(
                    app_handle,
                    "Codex Taskboard 启动失败",
                    &format!("{error}\n\n请确认官方 Codex/ChatGPT App 已安装。"),
                );
            }
        }
        tauri::RunEvent::ExitRequested { code, api, .. } => {
            if let Some(state) = app_handle.try_state::<Arc<LauncherState>>() {
                let _lifecycle = state.lifecycle.lock().unwrap();
                if code != Some(tauri::RESTART_EXIT_CODE)
                    && state.update_in_progress.load(Ordering::SeqCst)
                {
                    api.prevent_exit();
                    return;
                }
                stop_managed_child_locked(app_handle, &state);
            }
        }
        tauri::RunEvent::Exit => {
            if let Some(state) = app_handle.try_state::<Arc<LauncherState>>() {
                stop_managed_child(app_handle, &state);
                unsafe {
                    libc::flock(state._instance_lock.as_raw_fd(), libc::LOCK_UN);
                }
            }
        }
        _ => {}
    });
}
