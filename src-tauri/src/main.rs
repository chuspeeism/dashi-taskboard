#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use base64::Engine;
#[cfg(target_os = "macos")]
use dispatch2::{run_on_main, MainThreadBound};
use futures_util::StreamExt;
use minisign_verify::{PublicKey, Signature};
#[cfg(target_os = "macos")]
use objc2::{
    define_class, msg_send,
    rc::Retained,
    runtime::{AnyObject, NSObjectProtocol},
    sel, DefinedClass, MainThreadMarker, MainThreadOnly,
};
#[cfg(target_os = "macos")]
use objc2_app_kit::{
    NSAlert, NSApplication, NSButton, NSProgressIndicator, NSProgressIndicatorStyle,
    NSRunningApplication,
};
#[cfg(target_os = "macos")]
use objc2_foundation::{NSObject, NSSize, NSString};
use reqwest::header::{HeaderValue, ACCEPT};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
#[cfg(target_os = "macos")]
use std::cell::RefCell;
#[cfg(any(target_os = "macos", target_os = "linux"))]
use std::os::{fd::AsRawFd, unix::process::CommandExt};
use std::{
    fs::{self, File, OpenOptions},
    future::{poll_fn, Future},
    io::{BufRead, BufReader, Write},
    net::TcpListener,
    path::{Path, PathBuf},
    process::{Command as StdCommand, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    task::Poll,
    thread,
    time::{Duration, Instant},
};
#[cfg(target_os = "windows")]
use std::{os::windows::fs::OpenOptionsExt, process::ChildStdin};
#[cfg(target_os = "macos")]
use tauri::ActivationPolicy;
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager,
};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_updater::{Update, UpdaterExt};
use uuid::Uuid;
#[cfg(target_os = "windows")]
use windows::{
    core::PWSTR,
    Win32::{
        Foundation::{CloseHandle, ERROR_SUCCESS, FILETIME, WAIT_OBJECT_0},
        System::{
            RestartManager::{
                RmEndSession, RmRegisterResources, RmShutdown, RmStartSession, CCH_RM_SESSION_KEY,
                RM_UNIQUE_PROCESS,
            },
            Threading::{
                GetProcessTimes, OpenProcess, WaitForSingleObject,
                PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
            },
        },
    },
};

const STOP_TIMEOUT: Duration = Duration::from_secs(5);
#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
const LAUNCHER_STOP_TIMEOUT: Duration = Duration::from_secs(36);
const UPDATE_CHECK_INTERVAL: Duration = Duration::from_secs(30 * 60);
// Unique whole-directory snapshots shipped from app-v0.2.0 through v1.1.2.
const KNOWN_TASKBOARD_SKILL_DIGESTS: [&str; 6] = [
    "eeaaa5d71a2c47688bf62a5eb9f45e9138fe49eb636a46cfd6af8a0f8853e2e0",
    "c4ce3257bbf3efed1bb4d2d9f26436be8ba835d4ab4adf6fed38f5abbedafa59",
    "6f1b1bb3a731aa154018c97b0779442f6c461cb5dd3ea91ca49da4bb3b8a8ea0",
    "8ab19649d29cad0a39b0ab202b909bf03de07e37837b05cd5c3df5a4da0119f8",
    "27131c82ac63c2884c1fcb7dd22a4e1c75975c7d79eb3fa3483a7949dd5f284d",
    "ae74aec793decf6d9013c36f4b53e01723796a45567b77e9e9f22b4a168d3fbe",
];
const TASKBOARD_PREFERRED_PORT: u16 = 47823;
#[cfg(any(target_os = "macos", target_os = "linux"))]
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
    open_signal_pid: Option<u32>,
    open_request_pending: bool,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct LauncherPidRecord {
    pid: u32,
    node_path: PathBuf,
    injector_path: PathBuf,
}

#[derive(Deserialize)]
struct LauncherRuntimeDescriptor {
    url: String,
}

struct LauncherState {
    child: Mutex<Option<u32>>,
    snapshot: Mutex<LauncherSnapshot>,
    status_menu: Mutex<Option<MenuItem<tauri::Wry>>>,
    intentional_stop: AtomicBool,
    update_flow_in_progress: AtomicBool,
    update_in_progress: AtomicBool,
    generation: AtomicU64,
    lifecycle: Mutex<()>,
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    taskboard_listener: Mutex<Option<TcpListener>>,
    #[cfg(target_os = "macos")]
    codex_port: Mutex<Option<u16>>,
    #[cfg(target_os = "windows")]
    child_control: Mutex<Option<ChildStdin>>,
    _instance_lock: File,
    data_directory: PathBuf,
    log_path: PathBuf,
    pid_record_path: PathBuf,
}

#[cfg(target_os = "macos")]
struct UpdateDialogTargetIvars {
    response: RefCell<Option<std::sync::mpsc::Sender<bool>>>,
    cancel: RefCell<Option<(tauri::async_runtime::Sender<()>, Arc<AtomicBool>)>>,
}

#[cfg(target_os = "macos")]
define_class!(
    #[unsafe(super = NSObject)]
    #[name = "CodexTaskboardUpdateDialogTarget"]
    #[thread_kind = MainThreadOnly]
    #[ivars = UpdateDialogTargetIvars]
    struct UpdateDialogTarget;

    unsafe impl NSObjectProtocol for UpdateDialogTarget {}

    impl UpdateDialogTarget {
        #[unsafe(method(acceptUpdate:))]
        fn accept_update(&self, _sender: &AnyObject) {
            self.respond(true);
        }

        #[unsafe(method(deferUpdate:))]
        fn defer_update(&self, _sender: &AnyObject) {
            self.respond(false);
        }

        #[unsafe(method(cancelUpdate:))]
        fn cancel_update(&self, _sender: &AnyObject) {
            if let Some((cancel, cancel_requested)) = self.ivars().cancel.borrow_mut().take() {
                cancel_requested.store(true, Ordering::SeqCst);
                let _ = cancel.try_send(());
            }
        }
    }
);

#[cfg(target_os = "macos")]
impl UpdateDialogTarget {
    fn new(mtm: MainThreadMarker, response: std::sync::mpsc::Sender<bool>) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(UpdateDialogTargetIvars {
            response: RefCell::new(Some(response)),
            cancel: RefCell::new(None),
        });
        unsafe { msg_send![super(this), init] }
    }

    fn respond(&self, accepted: bool) {
        if let Some(response) = self.ivars().response.borrow_mut().take() {
            let _ = response.send(accepted);
        }
    }

    fn set_cancel(
        &self,
        cancel: tauri::async_runtime::Sender<()>,
        cancel_requested: Arc<AtomicBool>,
    ) {
        *self.ivars().cancel.borrow_mut() = Some((cancel, cancel_requested));
    }

    fn clear_cancel(&self) {
        self.ivars().cancel.borrow_mut().take();
    }
}

#[cfg(target_os = "macos")]
struct NativeUpdateDialog {
    alert: Retained<NSAlert>,
    progress_indicator: Retained<NSProgressIndicator>,
    install_button: Retained<NSButton>,
    defer_button: Retained<NSButton>,
    target: Retained<UpdateDialogTarget>,
}

#[cfg(target_os = "macos")]
#[derive(Clone)]
struct UpdateDialog {
    native: Arc<MainThreadBound<NativeUpdateDialog>>,
}

#[cfg(target_os = "macos")]
impl UpdateDialog {
    fn prompt(_app: &AppHandle, version: &str) -> Option<Self> {
        let message = format!("发现 Codex Taskboard {version}。是否现在下载、安装并重启？");
        let (response, result) = std::sync::mpsc::channel();
        let dialog = run_on_main(move |mtm| {
            let alert = NSAlert::new(mtm);
            let target = UpdateDialogTarget::new(mtm, response);
            let progress_indicator = NSProgressIndicator::new(mtm);
            progress_indicator.setStyle(NSProgressIndicatorStyle::Bar);
            progress_indicator.setMinValue(0.0);
            progress_indicator.setMaxValue(100.0);
            progress_indicator.setFrameSize(NSSize::new(280.0, 20.0));
            progress_indicator.sizeToFit();
            progress_indicator.setDisplayedWhenStopped(true);
            alert.setMessageText(&NSString::from_str("Codex Taskboard 更新"));
            alert.setInformativeText(&NSString::from_str(&message));
            let install_button = alert.addButtonWithTitle(&NSString::from_str("立即更新"));
            let defer_button = alert.addButtonWithTitle(&NSString::from_str("稍后"));
            unsafe {
                install_button.setTarget(Some(&target));
                install_button.setAction(Some(sel!(acceptUpdate:)));
                defer_button.setTarget(Some(&target));
                defer_button.setAction(Some(sel!(deferUpdate:)));
            }
            alert.layout();
            let window = alert.window();
            window.center();
            NSApplication::sharedApplication(mtm).activate();
            window.makeKeyAndOrderFront(None);
            Self {
                native: Arc::new(MainThreadBound::new(
                    NativeUpdateDialog {
                        alert,
                        progress_indicator,
                        install_button,
                        defer_button,
                        target,
                    },
                    mtm,
                )),
            }
        });
        if result.recv().unwrap() {
            Some(dialog)
        } else {
            dialog.close();
            None
        }
    }

    fn show_progress(
        &self,
        message: &str,
        cancel: tauri::async_runtime::Sender<()>,
        cancel_requested: Arc<AtomicBool>,
    ) {
        let native = Arc::clone(&self.native);
        let message = message.to_owned();
        run_on_main(move |mtm| {
            let native = native.get(mtm);
            native.target.set_cancel(cancel, cancel_requested);
            native
                .alert
                .setInformativeText(&NSString::from_str(&message));
            native.progress_indicator.setIndeterminate(false);
            native.progress_indicator.setDoubleValue(0.0);
            native
                .alert
                .setAccessoryView(Some(&native.progress_indicator));
            native.install_button.setHidden(true);
            native.defer_button.setTitle(&NSString::from_str("取消"));
            unsafe {
                native.defer_button.setAction(Some(sel!(cancelUpdate:)));
            }
            native.defer_button.setEnabled(true);
            native.defer_button.setHidden(false);
            native.alert.layout();
            native.progress_indicator.setNeedsDisplay(true);
            native.progress_indicator.displayIfNeeded();
        });
    }

    fn set_progress(&self, message: &str, progress: Option<u64>, cancellable: bool) {
        let native = Arc::clone(&self.native);
        let message = message.to_owned();
        run_on_main(move |mtm| {
            let native = native.get(mtm);
            native
                .alert
                .setInformativeText(&NSString::from_str(&message));
            native.progress_indicator.setIndeterminate(false);
            if let Some(progress) = progress {
                native.progress_indicator.setDoubleValue(progress as f64);
            }
            if !cancellable {
                native.target.clear_cancel();
                native.defer_button.setEnabled(false);
                native.defer_button.setHidden(true);
            }
            native.alert.layout();
            native.progress_indicator.setNeedsDisplay(true);
            native.progress_indicator.displayIfNeeded();
        });
    }

    fn close(&self) {
        let native = Arc::clone(&self.native);
        run_on_main(move |mtm| {
            let native = native.get(mtm);
            native.target.clear_cancel();
            native.alert.window().close();
        });
    }
}

#[cfg(target_os = "linux")]
#[derive(Clone)]
struct UpdateDialog;

#[cfg(target_os = "linux")]
impl UpdateDialog {
    fn prompt(app: &AppHandle, version: &str) -> Option<Self> {
        app.dialog()
            .message(format!(
                "发现 Codex Taskboard {version}。是否现在下载、安装并重启？"
            ))
            .title("Codex Taskboard 更新")
            .kind(MessageDialogKind::Info)
            .buttons(MessageDialogButtons::OkCancelCustom(
                "立即更新".into(),
                "稍后".into(),
            ))
            .blocking_show()
            .then_some(Self)
    }

    fn show_progress(
        &self,
        _message: &str,
        _cancel: tauri::async_runtime::Sender<()>,
        _cancel_requested: Arc<AtomicBool>,
    ) {
    }

    fn set_progress(&self, _message: &str, _progress: Option<u64>, _cancellable: bool) {}

    fn close(&self) {}
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
#[derive(Clone)]
struct UpdateDialog;

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
impl UpdateDialog {
    fn prompt(_app: &AppHandle, _version: &str) -> Option<Self> {
        None
    }

    fn show_progress(
        &self,
        _message: &str,
        _cancel: tauri::async_runtime::Sender<()>,
        _cancel_requested: Arc<AtomicBool>,
    ) {
    }

    fn set_progress(&self, _message: &str, _progress: Option<u64>, _cancellable: bool) {}

    fn close(&self) {}
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
                open_signal_pid: None,
                open_request_pending: false,
            }),
            status_menu: Mutex::new(None),
            intentional_stop: AtomicBool::new(false),
            update_flow_in_progress: AtomicBool::new(false),
            update_in_progress: AtomicBool::new(false),
            generation: AtomicU64::new(0),
            lifecycle: Mutex::new(()),
            #[cfg(any(target_os = "macos", target_os = "linux"))]
            taskboard_listener: Mutex::new(None),
            #[cfg(target_os = "macos")]
            codex_port: Mutex::new(None),
            #[cfg(target_os = "windows")]
            child_control: Mutex::new(None),
            _instance_lock: instance_lock,
            pid_record_path: data_directory.join("launcher-child.json"),
            data_directory,
            log_path: log_directory.join("codex-taskboard-launcher.log"),
        }
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
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

#[cfg(target_os = "windows")]
fn acquire_instance_lock(path: &Path) -> Result<Option<File>, std::io::Error> {
    match OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .share_mode(0)
        .open(path)
    {
        Ok(file) => Ok(Some(file)),
        Err(error) if error.raw_os_error() == Some(32) => Ok(None),
        Err(error) => Err(error),
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

fn collect_skill_files(
    root: &Path,
    directory: &Path,
    files: &mut Vec<PathBuf>,
) -> Result<bool, std::io::Error> {
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        if file_type.is_symlink() {
            return Ok(false);
        }
        if file_type.is_dir() {
            let file_count = files.len();
            if !collect_skill_files(root, &entry.path(), files)? {
                return Ok(false);
            }
            if files.len() == file_count {
                return Ok(false);
            }
        } else if file_type.is_file() {
            files.push(entry.path().strip_prefix(root).unwrap().to_path_buf());
        } else {
            return Ok(false);
        }
    }
    Ok(true)
}

fn skill_directory_digest(directory: &Path) -> Result<Option<String>, std::io::Error> {
    let mut files = Vec::new();
    if !collect_skill_files(directory, directory, &mut files)? {
        return Ok(None);
    }
    files.sort();
    let mut digest = Sha256::new();
    for relative_path in files {
        let contents = fs::read(directory.join(&relative_path))?;
        digest.update(relative_path.to_string_lossy().replace('\\', "/"));
        digest.update([0]);
        digest.update((contents.len() as u64).to_le_bytes());
        digest.update(contents);
    }
    Ok(Some(format!("{:x}", digest.finalize())))
}

fn reconcile_legacy_skill(
    home_directory: &Path,
    bundled_skill: &Path,
) -> Result<Option<(PathBuf, PathBuf)>, std::io::Error> {
    let legacy_skill = home_directory.join(".codex/skills/manage-taskboard");
    let metadata = match fs::symlink_metadata(&legacy_skill) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };

    if metadata.file_type().is_symlink() {
        fs::remove_dir_all(legacy_skill)?;
        return Ok(None);
    }

    if metadata.is_dir() {
        let legacy_digest = skill_directory_digest(&legacy_skill)?;
        let bundled_digest = skill_directory_digest(bundled_skill)?;
        let known_copy = legacy_digest.as_ref().is_some_and(|digest| {
            bundled_digest.as_ref() == Some(digest)
                || KNOWN_TASKBOARD_SKILL_DIGESTS.contains(&digest.as_str())
        });
        if known_copy {
            fs::remove_dir_all(legacy_skill)?;
            return Ok(None);
        }
    }

    let backup_path = home_directory
        .join(".codex/taskboard-skill-backups")
        .join(format!("manage-taskboard-{}", Uuid::new_v4()));
    Ok(Some((legacy_skill, backup_path)))
}

fn resolve_legacy_skill_conflict(
    app: &AppHandle,
    legacy_skill: &Path,
    backup_path: &Path,
) -> Result<bool, std::io::Error> {
    let proceed = app
        .dialog()
        .message(format!(
            "检测到旧位置中的 manage-taskboard Skill 与当前 App 内置版本不同，可能包含你的修改。\n\n为避免 Codex 同时发现两个版本，Taskboard 会把旧副本完整保留到：\n\n{}\n\n选择退出不会改动旧副本，也不会启动 Codex。",
            backup_path.display()
        ))
        .title("Codex Taskboard Skill 冲突")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "保留备份并继续".into(),
            "退出".into(),
        ))
        .blocking_show();
    if !proceed {
        return Ok(false);
    }

    fs::create_dir_all(backup_path.parent().unwrap())?;
    fs::rename(legacy_skill, backup_path)?;
    Ok(true)
}

fn loopback_listener() -> Result<TcpListener, String> {
    TcpListener::bind(("127.0.0.1", 0)).map_err(|error| error.to_string())
}

fn taskboard_loopback_listener() -> Result<TcpListener, String> {
    TcpListener::bind(("127.0.0.1", TASKBOARD_PREFERRED_PORT))
        .or_else(|_| TcpListener::bind(("127.0.0.1", 0)))
        .map_err(|error| error.to_string())
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn taskboard_listener(state: &LauncherState) -> Result<(Option<i32>, u16), String> {
    let mut listener = state.taskboard_listener.lock().unwrap();
    if listener.is_none() {
        *listener = Some(taskboard_loopback_listener()?);
    }
    let listener = listener.as_ref().unwrap();
    let port = listener
        .local_addr()
        .map_err(|error| error.to_string())?
        .port();
    Ok((Some(listener.as_raw_fd()), port))
}

#[cfg(target_os = "windows")]
fn taskboard_listener(_state: &LauncherState) -> Result<(Option<i32>, u16), String> {
    let listener = taskboard_loopback_listener()?;
    let port = listener
        .local_addr()
        .map_err(|error| error.to_string())?
        .port();
    drop(listener);
    Ok((None, port))
}

#[cfg(target_os = "macos")]
fn codex_port(state: &LauncherState) -> Result<u16, String> {
    let mut port = state.codex_port.lock().unwrap();
    if let Some(port) = *port {
        return Ok(port);
    }
    let listener = loopback_listener()?;
    let selected = listener
        .local_addr()
        .map_err(|error| error.to_string())?
        .port();
    *port = Some(selected);
    Ok(selected)
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
    let status_menu = state.status_menu.lock().unwrap().clone();
    if let Some(status_menu) = status_menu {
        let status_state = Arc::clone(state);
        let _ = app.run_on_main_thread(move || {
            let status = {
                let snapshot = status_state.snapshot.lock().unwrap();
                match snapshot.phase.as_str() {
                    "running" => "运行状态：正常",
                    "error" => "运行状态：异常",
                    _ => "运行状态：启动中",
                }
            };
            let _ = status_menu.set_text(status);
        });
    }
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

#[cfg(target_os = "macos")]
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

#[cfg(target_os = "macos")]
fn ordinary_codex_process(app_path: &Path) -> Result<Option<u32>, String> {
    let app_name = app_path
        .file_stem()
        .ok_or_else(|| "无法识别 Codex App 名称".to_string())?;
    let executable = app_path.join("Contents/MacOS").join(app_name);
    let output = StdCommand::new("/bin/ps")
        .args(["-ww", "-axo", "pid=,command="])
        .output()
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err("无法检查正在运行的 Codex".to_string());
    }

    let executable = executable.to_string_lossy();
    let mut ordinary_pid = None;
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        let line = line.trim_start();
        let Some(separator) = line.find(char::is_whitespace) else {
            continue;
        };
        let command = line[separator..].trim_start();
        if command != executable && !command.starts_with(&format!("{executable} ")) {
            continue;
        }
        if command.contains(" --remote-debugging-port=") {
            return Ok(None);
        }
        ordinary_pid = line[..separator].parse().ok();
    }
    Ok(ordinary_pid)
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn process_is_running(pid: u32) -> bool {
    unsafe { libc::kill(pid as i32, 0) == 0 }
}

#[cfg(target_os = "macos")]
fn quit_codex_normally(pid: u32) -> Result<(), String> {
    let application =
        NSRunningApplication::runningApplicationWithProcessIdentifier(pid as libc::pid_t)
            .ok_or_else(|| "无法找到正在运行的 Codex".to_string())?;
    if !application.terminate() {
        return Err("Codex 没有接受退出请求".to_string());
    }
    let deadline = Instant::now() + LAUNCHER_STOP_TIMEOUT;
    while process_is_running(pid) && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(100));
    }
    if process_is_running(pid) {
        return Err("Codex 尚未退出，任务面板没有启动".to_string());
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn find_codex_app(_home_directory: &Path) -> Option<PathBuf> {
    let output = StdCommand::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "(Get-AppxPackage -Name OpenAI.Codex).InstallLocation",
        ])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let install_location = String::from_utf8_lossy(&output.stdout);
    let candidate = PathBuf::from(install_location.trim())
        .join("app")
        .join("ChatGPT.exe");
    candidate.is_file().then_some(candidate)
}

#[cfg(target_os = "windows")]
fn ordinary_codex_process(app_path: &Path, codex_profile: &Path) -> Result<Option<u32>, String> {
    let output = StdCommand::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "$ErrorActionPreference = 'Stop'; $app = $env:CODEX_TASKBOARD_CODEX_APP_PATH; $profile = $env:CODEX_TASKBOARD_CODEX_PROFILE; $name = [IO.Path]::GetFileName($app); $all = @(Get-CimInstance Win32_Process -Filter \"Name = '$name'\" | Where-Object { $_.ExecutablePath -eq $app }); $pids = @{}; foreach ($item in $all) { $pids[[uint32]$item.ProcessId] = $true }; $process = $all | Where-Object { $command = [string]$_.CommandLine; $isRoot = -not $pids.ContainsKey([uint32]$_.ParentProcessId); $isManaged = $command.IndexOf('--remote-debugging-pipe', [StringComparison]::OrdinalIgnoreCase) -ge 0 -and $command.IndexOf(('--user-data-dir=' + $profile), [StringComparison]::OrdinalIgnoreCase) -ge 0; $isRoot -and -not $isManaged } | Select-Object -First 1; if ($null -ne $process) { [Console]::Out.Write($process.ProcessId) }",
        ])
        .env("CODEX_TASKBOARD_CODEX_APP_PATH", app_path)
        .env("CODEX_TASKBOARD_CODEX_PROFILE", codex_profile)
        .output()
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err("无法检查正在运行的 Codex".to_string());
    }
    let pid = String::from_utf8_lossy(&output.stdout);
    let pid = pid.trim();
    if pid.is_empty() {
        return Ok(None);
    }
    pid.parse()
        .map(Some)
        .map_err(|_| "无法检查正在运行的 Codex".to_string())
}

#[cfg(target_os = "windows")]
fn quit_codex_normally(pid: u32) -> Result<(), String> {
    let process = unsafe {
        OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
            false,
            pid,
        )
    }
    .map_err(|error| error.to_string())?;
    let mut creation_time = FILETIME::default();
    let mut exit_time = FILETIME::default();
    let mut kernel_time = FILETIME::default();
    let mut user_time = FILETIME::default();
    if unsafe {
        GetProcessTimes(
            process,
            &mut creation_time,
            &mut exit_time,
            &mut kernel_time,
            &mut user_time,
        )
    }
    .is_err()
    {
        let _ = unsafe { CloseHandle(process) };
        return Err("无法检查正在运行的 Codex".to_string());
    }

    let mut session = 0;
    let mut session_key = [0u16; CCH_RM_SESSION_KEY as usize + 1];
    let started = unsafe { RmStartSession(&mut session, None, PWSTR(session_key.as_mut_ptr())) };
    if started != ERROR_SUCCESS {
        let _ = unsafe { CloseHandle(process) };
        return Err("无法请求 Codex 退出".to_string());
    }
    let application = RM_UNIQUE_PROCESS {
        dwProcessId: pid,
        ProcessStartTime: creation_time,
    };
    let registered = unsafe { RmRegisterResources(session, None, Some(&[application]), None) };
    let shutdown = if registered == ERROR_SUCCESS {
        unsafe { RmShutdown(session, 0, None) }
    } else {
        registered
    };
    let _ = unsafe { RmEndSession(session) };
    if shutdown != ERROR_SUCCESS {
        let _ = unsafe { CloseHandle(process) };
        return Err("Codex 没有接受退出请求".to_string());
    }

    let exited = unsafe {
        WaitForSingleObject(
            process,
            LAUNCHER_STOP_TIMEOUT.as_millis().try_into().unwrap(),
        )
    } == WAIT_OBJECT_0;
    let _ = unsafe { CloseHandle(process) };
    if exited {
        Ok(())
    } else {
        Err("Codex 尚未退出，任务面板没有启动".to_string())
    }
}

#[cfg(target_os = "linux")]
fn find_codex_app(_home_directory: &Path) -> Option<PathBuf> {
    let candidate = PathBuf::from("/usr/lib/chatgpt/ChatGPT");
    candidate.is_file().then_some(candidate)
}

#[cfg(target_os = "linux")]
fn ordinary_codex_process(app_path: &Path, codex_profile: &Path) -> Result<Option<u32>, String> {
    let output = StdCommand::new("/bin/ps")
        .args(["-ww", "-axo", "pid=,ppid=,command="])
        .output()
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err("无法检查正在运行的 Codex".to_string());
    }

    let executable = app_path.to_string_lossy();
    let mut processes = Vec::new();
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        let line = line.trim_start();
        let Some(pid_separator) = line.find(char::is_whitespace) else {
            continue;
        };
        let Some(pid) = line[..pid_separator].parse::<u32>().ok() else {
            continue;
        };
        let parent_and_command = line[pid_separator..].trim_start();
        let Some(parent_separator) = parent_and_command.find(char::is_whitespace) else {
            continue;
        };
        let Some(parent_pid) = parent_and_command[..parent_separator].parse::<u32>().ok() else {
            continue;
        };
        let command = parent_and_command[parent_separator..].trim_start();
        if command != executable && !command.starts_with(&format!("{executable} ")) {
            continue;
        }
        processes.push((pid, parent_pid, command.to_string()));
    }

    let managed_profile = format!("--user-data-dir={}", codex_profile.display());
    Ok(processes
        .iter()
        .find(|(pid, parent_pid, command)| {
            !processes
                .iter()
                .any(|(candidate_pid, _, _)| candidate_pid == parent_pid && candidate_pid != pid)
                && !(command.contains(" --remote-debugging-pipe")
                    && command.contains(&format!(" {managed_profile}")))
        })
        .map(|(pid, _, _)| *pid))
}

#[cfg(target_os = "linux")]
fn quit_codex_normally(pid: u32) -> Result<(), String> {
    if unsafe { libc::kill(pid as i32, libc::SIGTERM) } != 0 {
        return Err("Codex 没有接受退出请求".to_string());
    }
    let deadline = Instant::now() + LAUNCHER_STOP_TIMEOUT;
    while process_is_running(pid) && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(100));
    }
    if process_is_running(pid) {
        return Err("Codex 尚未退出，任务面板没有启动".to_string());
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn missing_codex_app_message() -> String {
    "未找到官方 ChatGPT.app 或 Codex.app。请先安装到 Applications 文件夹。".to_string()
}

#[cfg(target_os = "windows")]
fn missing_codex_app_message() -> String {
    "未找到官方 Codex App。请先从 Microsoft Store 安装。".to_string()
}

#[cfg(target_os = "linux")]
fn missing_codex_app_message() -> String {
    "未找到官方 ChatGPT App。请先安装 Ubuntu x64 .deb。".to_string()
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn send_process_group_signal(pid: u32, signal: i32) {
    unsafe {
        if libc::kill(-(pid as i32), signal) != 0 {
            libc::kill(pid as i32, signal);
        }
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn process_group_is_running(pid: u32) -> bool {
    unsafe { libc::kill(-(pid as i32), 0) == 0 }
}

#[cfg(target_os = "windows")]
fn process_group_is_running(pid: u32) -> bool {
    StdCommand::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            &format!(
                "if (Get-Process -Id {pid} -ErrorAction SilentlyContinue) {{ exit 0 }} else {{ exit 1 }}"
            ),
        ])
        .status()
        .is_ok_and(|status| status.success())
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn signal_pending_taskboard_open(state: &LauncherState) -> Result<(), String> {
    let mut snapshot = state.snapshot.lock().unwrap();
    if !snapshot.open_request_pending {
        return Ok(());
    }
    let Some(pid) = snapshot.open_signal_pid else {
        return Ok(());
    };
    if unsafe { libc::kill(pid as i32, libc::SIGUSR2) } != 0 {
        snapshot.open_signal_pid = None;
        return Err(std::io::Error::last_os_error().to_string());
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn signal_pending_taskboard_open(state: &LauncherState) -> Result<(), String> {
    let mut snapshot = state.snapshot.lock().unwrap();
    if !snapshot.open_request_pending {
        return Ok(());
    }
    if snapshot.open_signal_pid.is_none() {
        return Ok(());
    }
    let result = state
        .child_control
        .lock()
        .unwrap()
        .as_mut()
        .ok_or_else(|| "Launcher control pipe is unavailable".to_string())
        .and_then(|control| {
            control
                .write_all(b"open\n")
                .and_then(|_| control.flush())
                .map_err(|error| error.to_string())
        });
    if result.is_err() {
        snapshot.open_signal_pid = None;
    }
    result
}

fn wait_for_process_group_exit(pid: u32, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while process_group_is_running(pid) && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(100));
    }
    !process_group_is_running(pid)
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn terminate_process_group(pid: u32) {
    send_process_group_signal(pid, libc::SIGTERM);
    if !wait_for_process_group_exit(pid, STOP_TIMEOUT) {
        send_process_group_signal(pid, libc::SIGKILL);
        let _ = wait_for_process_group_exit(pid, Duration::from_secs(1));
    }
}

#[cfg(target_os = "windows")]
fn terminate_process_group(pid: u32) {
    if process_group_is_running(pid) {
        let _ = StdCommand::new("taskkill.exe")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .status();
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn stop_launcher_process_group(pid: u32) {
    unsafe {
        libc::kill(pid as i32, libc::SIGTERM);
    }
    if !wait_for_process_group_exit(pid, LAUNCHER_STOP_TIMEOUT) {
        send_process_group_signal(pid, libc::SIGKILL);
        let _ = wait_for_process_group_exit(pid, Duration::from_secs(1));
    }
}

#[cfg(target_os = "windows")]
fn stop_launcher_process_group(pid: u32) {
    terminate_process_group(pid);
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
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

#[cfg(target_os = "windows")]
fn process_matches_record(record: &LauncherPidRecord) -> bool {
    let output = StdCommand::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            &format!(
                "(Get-CimInstance Win32_Process -Filter 'ProcessId = {}').CommandLine",
                record.pid
            ),
        ])
        .output();
    let Ok(output) = output else {
        return false;
    };
    let command = String::from_utf8_lossy(&output.stdout);
    command.contains(&*record.node_path.to_string_lossy())
        && command.contains(r"scripts\codex-injector.mjs")
}

fn stop_recorded_child(state: &LauncherState) {
    let record = fs::read_to_string(&state.pid_record_path)
        .ok()
        .and_then(|content| serde_json::from_str::<LauncherPidRecord>(&content).ok());
    if let Some(record) = record {
        if process_matches_record(&record) {
            stop_launcher_process_group(record.pid);
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
    #[cfg(target_os = "windows")]
    if let Some(mut control) = state.child_control.lock().unwrap().take() {
        let _ = control.write_all(b"stop\n").and_then(|_| control.flush());
    }
    if let Some(pid) = state.child.lock().unwrap().take() {
        append_log(state, &format!("Stopping launcher child {pid}"));
        #[cfg(target_os = "windows")]
        if !wait_for_process_group_exit(pid, STOP_TIMEOUT) {
            terminate_process_group(pid);
        }
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        stop_launcher_process_group(pid);
        clear_pid_record(state, pid);
    }
    update_snapshot(app, state, |snapshot| {
        snapshot.phase = "stopped".into();
        snapshot.message = "任务面板已停止。".into();
        snapshot.child_pid = None;
        snapshot.open_signal_pid = None;
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
    pid: u32,
    generation: u64,
) {
    thread::spawn(move || {
        for line in BufReader::new(reader).lines().map_while(Result::ok) {
            append_log(&state, &line);
            if is_stderr && line.contains("Waiting for Codex") {
                update_snapshot(&app, &state, |snapshot| {
                    if state.generation.load(Ordering::SeqCst) == generation
                        && snapshot.child_pid == Some(pid)
                    {
                        snapshot.phase = "starting".into();
                        snapshot.message = "正在等待 Codex 窗口…".into();
                    }
                });
            } else if !is_stderr && line.contains("Codex Taskboard listening") {
                update_snapshot(&app, &state, |snapshot| {
                    if state.generation.load(Ordering::SeqCst) == generation
                        && snapshot.child_pid == Some(pid)
                    {
                        snapshot.phase = "starting".into();
                        snapshot.message = "任务面板服务已启动，正在注入 Codex…".into();
                    }
                });
            } else if !is_stderr && line.contains("\"openTaskboardSignalReady\":true") {
                let snapshot = update_snapshot(&app, &state, |snapshot| {
                    if state.generation.load(Ordering::SeqCst) == generation
                        && snapshot.child_pid == Some(pid)
                    {
                        snapshot.open_signal_pid = Some(pid);
                    }
                });
                if snapshot.child_pid == Some(pid) && snapshot.open_signal_pid == Some(pid) {
                    if let Err(error) = signal_pending_taskboard_open(&state) {
                        append_log(&state, &format!("Taskboard open signal failed: {error}"));
                    }
                }
            } else if !is_stderr && line.contains("\"openTaskboardSignalQueued\":true") {
                let mut snapshot = state.snapshot.lock().unwrap();
                if state.generation.load(Ordering::SeqCst) == generation
                    && snapshot.child_pid == Some(pid)
                    && snapshot.open_signal_pid == Some(pid)
                {
                    snapshot.open_request_pending = false;
                }
            } else if !is_stderr && line.contains("\"openedTaskboardInExistingCodex\":true") {
                update_snapshot(&app, &state, |snapshot| {
                    if state.generation.load(Ordering::SeqCst) == generation
                        && snapshot.child_pid == Some(pid)
                    {
                        snapshot.phase = "running".into();
                        snapshot.message = "任务面板已在现有 Codex 的浏览面板中打开。".into();
                    }
                });
            } else if !is_stderr && line.contains("\"injected\"") {
                update_snapshot(&app, &state, |snapshot| {
                    if state.generation.load(Ordering::SeqCst) == generation
                        && snapshot.child_pid == Some(pid)
                    {
                        snapshot.phase = "running".into();
                        snapshot.message = "任务面板已在 Codex 客户端中打开。".into();
                    }
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
    let codex_app = find_codex_app(&home_directory).ok_or_else(missing_codex_app_message)?;
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
        .join(if cfg!(target_os = "windows") {
            "node.exe"
        } else if cfg!(target_os = "linux") {
            "codex-taskboard-node"
        } else {
            "node"
        });
    let codex_profile = state.data_directory.join("codex-profile");
    stop_recorded_child(state);
    #[cfg(target_os = "macos")]
    let ordinary_codex_pid = ordinary_codex_process(&codex_app)?;
    #[cfg(target_os = "windows")]
    let ordinary_codex_pid = ordinary_codex_process(&codex_app, &codex_profile)?;
    #[cfg(target_os = "linux")]
    let ordinary_codex_pid = ordinary_codex_process(&codex_app, &codex_profile)?;
    if let Some(codex_pid) = ordinary_codex_pid {
        let restart = app
            .dialog()
            .message("需要重新启动 Codex 才能显示任务面板")
            .title("Codex Taskboard")
            .kind(MessageDialogKind::Info)
            .buttons(MessageDialogButtons::OkCancelCustom(
                "重新启动 Codex".into(),
                "取消".into(),
            ))
            .blocking_show();
        if !restart {
            append_log(state, "Codex restart canceled by user");
            return Ok(update_snapshot(app, state, |snapshot| {
                snapshot.phase = "stopped".into();
                snapshot.message = "已取消重新启动 Codex，任务面板未注入。".into();
                snapshot.app_path = Some(codex_app.display().to_string());
                snapshot.open_signal_pid = None;
                snapshot.open_request_pending = false;
            }));
        }
        append_log(
            state,
            &format!("Requesting normal Codex exit for PID {codex_pid}"),
        );
        quit_codex_normally(codex_pid)?;
    }
    let generation = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
    state.intentional_stop.store(false, Ordering::SeqCst);
    update_snapshot(app, state, |snapshot| {
        snapshot.phase = "starting".into();
        snapshot.message = "正在启动任务面板服务…".into();
        snapshot.app_path = Some(codex_app.display().to_string());
        snapshot.open_signal_pid = None;
    });

    #[cfg(target_os = "macos")]
    let path_value = format!(
        "{}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
        resource_directory.join("bin").display()
    );
    #[cfg(any(target_os = "windows", target_os = "linux"))]
    let path_value = {
        let current_path = std::env::var_os("PATH").unwrap_or_default();
        std::env::join_paths(
            std::iter::once(resource_directory.join("bin"))
                .chain(std::env::split_paths(&current_path)),
        )
        .map_err(|error| error.to_string())?
    };
    let (_taskboard_listener_fd, taskboard_port) = taskboard_listener(state)?;
    #[cfg(target_os = "macos")]
    let codex_port = codex_port(state)?.to_string();
    let instance_token = Uuid::new_v4().to_string();
    let instance_secret = Uuid::new_v4().to_string();
    let version = state.snapshot.lock().unwrap().version.clone();
    let manage_taskboard_skill_path =
        home_directory.join(".agents/skills/manage-taskboard/SKILL.md");
    #[cfg(target_os = "macos")]
    let codex_source_profile = home_directory.join("Library/Application Support/Codex");
    #[cfg(target_os = "windows")]
    let codex_source_profile = std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .ok_or_else(|| "APPDATA is unavailable".to_string())?
        .join("Codex/web/Codex");
    #[cfg(target_os = "linux")]
    let codex_source_profile = std::env::var_os("XDG_CONFIG_HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| home_directory.join(".config"))
        .join("Codex");
    let mut command = StdCommand::new(&node_path);
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    command.arg(&injector_path);
    #[cfg(target_os = "windows")]
    command.arg(r"scripts\codex-injector.mjs");
    #[cfg(target_os = "macos")]
    command.args(["--launch", "--watch", "--open", "--port", &codex_port]);
    #[cfg(any(target_os = "windows", target_os = "linux"))]
    command.args(["--launch", "--watch", "--open", "--cdp-pipe"]);
    command
        .args(["--startup-token", &instance_token, "--app-path"])
        .arg(&codex_app)
        .env("CODEX_TASKBOARD_DATA_DIR", &state.data_directory)
        .env(
            "CODEX_TASKBOARD_RUNTIME_FILE",
            state.data_directory.join("launcher-runtime.json"),
        )
        .env("CODEX_TASKBOARD_HOST", "127.0.0.1")
        .env("CODEX_TASKBOARD_PORT", taskboard_port.to_string())
        .env("CODEX_TASKBOARD_INSTANCE_TOKEN", &instance_token)
        .env("CODEX_TASKBOARD_INSTANCE_SECRET", &instance_secret)
        .env("CODEX_TASKBOARD_VERSION", &version)
        .env("CODEX_TASKBOARD_SKILL_PATH", &manage_taskboard_skill_path)
        .env_remove("CODEX_API_KEY")
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
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(target_os = "windows")]
    command.stdin(Stdio::piped());
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    unsafe {
        let taskboard_listener_fd = _taskboard_listener_fd.unwrap();
        command
            .env("CODEX_TASKBOARD_LISTEN_FD", TASKBOARD_LISTEN_FD.to_string())
            .process_group(0);
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
    #[cfg(target_os = "windows")]
    let child_control = child.stdin.take();
    if let Err(error) = write_pid_record(state, pid, node_path, injector_path) {
        terminate_process_group(pid);
        let _ = child.wait();
        return Err(error);
    }
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    *state.child.lock().unwrap() = Some(pid);
    #[cfg(target_os = "windows")]
    {
        *state.child_control.lock().unwrap() = child_control;
    }
    let snapshot = update_snapshot(app, state, |snapshot| {
        snapshot.child_pid = Some(pid);
    });
    #[cfg(target_os = "macos")]
    append_log(
        state,
        &format!(
            "Started launcher child {pid} on Taskboard {taskboard_port} with Codex CDP {codex_port}"
        ),
    );
    #[cfg(any(target_os = "windows", target_os = "linux"))]
    append_log(
        state,
        &format!(
            "Started launcher child {pid} on Taskboard {taskboard_port} with a private Codex CDP pipe"
        ),
    );
    if let Some(stdout) = stdout {
        watch_launcher_output(stdout, false, app.clone(), state.clone(), pid, generation);
    }
    if let Some(stderr) = stderr {
        watch_launcher_output(stderr, true, app.clone(), state.clone(), pid, generation);
    }

    let event_app = app.clone();
    let event_state = state.clone();
    thread::spawn(move || {
        let status = child.wait();
        let recovery_token = {
            let mut current_child = event_state.child.lock().unwrap();
            if *current_child != Some(pid) {
                None
            } else {
                let recovery_token = generation + 1;
                if event_state
                    .generation
                    .compare_exchange(
                        generation,
                        recovery_token,
                        Ordering::SeqCst,
                        Ordering::SeqCst,
                    )
                    .is_ok()
                {
                    *current_child = None;
                    Some(recovery_token)
                } else {
                    None
                }
            }
        };
        #[cfg(target_os = "windows")]
        if recovery_token.is_some() {
            let _ = event_state.child_control.lock().unwrap().take();
        }
        let Some(recovery_token) = recovery_token else {
            append_log(
                &event_state,
                &format!("Launcher child {pid} exited: {status:?}"),
            );
            terminate_process_group(pid);
            return;
        };
        let intentional = event_state.intentional_stop.load(Ordering::SeqCst);
        update_snapshot(&event_app, &event_state, |snapshot| {
            if event_state.generation.load(Ordering::SeqCst) == recovery_token
                && snapshot.child_pid == Some(pid)
            {
                snapshot.child_pid = None;
                snapshot.open_signal_pid = None;
                if !intentional {
                    snapshot.phase = "error".into();
                    snapshot.message = "任务面板进程已退出，正在恢复…".into();
                }
            }
        });
        append_log(
            &event_state,
            &format!("Launcher child {pid} exited: {status:?}"),
        );
        terminate_process_group(pid);
        clear_pid_record(&event_state, pid);
        if intentional {
            return;
        }
        thread::sleep(Duration::from_secs(2));
        let (recovery_result, recovery_generation) = {
            let _lifecycle = event_state.lifecycle.lock().unwrap();
            if event_state.generation.load(Ordering::SeqCst) != recovery_token
                || event_state.intentional_stop.load(Ordering::SeqCst)
                || event_state.update_in_progress.load(Ordering::SeqCst)
            {
                return;
            }
            let result = start_launcher_locked(&event_app, &event_state);
            let generation = event_state.generation.load(Ordering::SeqCst);
            (result, generation)
        };
        if let Err(error) = recovery_result {
            append_log(&event_state, &format!("Launcher recovery failed: {error}"));
            update_snapshot(&event_app, &event_state, |snapshot| {
                if event_state.generation.load(Ordering::SeqCst) == recovery_generation
                    && snapshot.child_pid.is_none()
                {
                    snapshot.phase = "error".into();
                    snapshot.message = error.clone();
                    snapshot.open_signal_pid = None;
                }
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
    let (result, result_generation) = {
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
        state.intentional_stop.store(false, Ordering::SeqCst);
        let generation = state.generation.load(Ordering::SeqCst);
        (result, generation)
    };
    if let Err(error) = &result {
        let error = error.clone();
        update_snapshot(app, state, |snapshot| {
            if state.generation.load(Ordering::SeqCst) == result_generation
                && snapshot.child_pid.is_none()
            {
                snapshot.phase = "error".into();
                snapshot.message = format!("任务面板启动失败：{error}");
                snapshot.open_signal_pid = None;
            }
        });
    }
    result
}

fn open_taskboard(state: &LauncherState) -> Result<(), String> {
    state.snapshot.lock().unwrap().open_request_pending = true;
    signal_pending_taskboard_open(state)
}

fn open_taskboard_in_browser(state: &LauncherState) -> Result<(), String> {
    let descriptor = fs::read_to_string(state.data_directory.join("launcher-runtime.json"))
        .map_err(|error| error.to_string())?;
    let descriptor: LauncherRuntimeDescriptor =
        serde_json::from_str(&descriptor).map_err(|error| error.to_string())?;
    let url = format!("{}/", descriptor.url.trim_end_matches('/'));
    #[cfg(target_os = "macos")]
    let status = StdCommand::new("/usr/bin/open")
        .arg(&url)
        .status()
        .map_err(|error| error.to_string())?;
    #[cfg(target_os = "windows")]
    let status = StdCommand::new("rundll32.exe")
        .args(["url.dll,FileProtocolHandler", &url])
        .status()
        .map_err(|error| error.to_string())?;
    #[cfg(target_os = "linux")]
    let status = StdCommand::new("xdg-open")
        .arg(&url)
        .status()
        .map_err(|error| error.to_string())?;
    status
        .success()
        .then_some(())
        .ok_or_else(|| "系统默认浏览器没有打开任务面板".to_string())
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

async fn download_update<C: FnMut(usize, Option<u64>), D: FnOnce()>(
    app: &AppHandle,
    update: &Update,
    cancel_requested: &AtomicBool,
    mut on_chunk: C,
    on_download_finish: D,
) -> Result<Option<Vec<u8>>, String> {
    let pubkey = app
        .config()
        .plugins
        .0
        .get("updater")
        .and_then(|value| value.get("pubkey"))
        .and_then(serde_json::Value::as_str)
        .ok_or("Updater public key is unavailable")?;
    let mut headers = update.headers.clone();
    if !headers.contains_key(ACCEPT) {
        headers.insert(ACCEPT, HeaderValue::from_static("application/octet-stream"));
    }
    let mut request = reqwest::Client::builder().user_agent("tauri-plugin-updater/2.10.1");
    if let Some(timeout) = update.timeout {
        request = request.timeout(timeout);
    }
    if update.no_proxy {
        request = request.no_proxy();
    } else if let Some(proxy) = &update.proxy {
        request =
            request.proxy(reqwest::Proxy::all(proxy.as_str()).map_err(|error| error.to_string())?);
    }
    let response = request
        .build()
        .map_err(|error| error.to_string())?
        .get(update.download_url.clone())
        .headers(headers)
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        return Err(format!(
            "Download request failed with status: {}",
            response.status()
        ));
    }
    let content_length = response
        .headers()
        .get("Content-Length")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse().ok());
    let mut buffer = Vec::new();
    let mut stream = response.bytes_stream();
    loop {
        if cancel_requested.load(Ordering::SeqCst) {
            return Ok(None);
        }
        let Some(chunk) = stream.next().await else {
            break;
        };
        let chunk = chunk.map_err(|error| error.to_string())?;
        if cancel_requested.load(Ordering::SeqCst) {
            return Ok(None);
        }
        on_chunk(chunk.len(), content_length);
        if cancel_requested.load(Ordering::SeqCst) {
            return Ok(None);
        }
        buffer.extend_from_slice(&chunk);
    }
    if cancel_requested.load(Ordering::SeqCst) {
        return Ok(None);
    }
    on_download_finish();
    if cancel_requested.load(Ordering::SeqCst) {
        return Ok(None);
    }
    let pubkey = base64::engine::general_purpose::STANDARD
        .decode(pubkey)
        .map_err(|error| error.to_string())?;
    let pubkey = std::str::from_utf8(&pubkey).map_err(|error| error.to_string())?;
    let pubkey = PublicKey::decode(pubkey).map_err(|error| error.to_string())?;
    let signature = base64::engine::general_purpose::STANDARD
        .decode(&update.signature)
        .map_err(|error| error.to_string())?;
    let signature = std::str::from_utf8(&signature).map_err(|error| error.to_string())?;
    let signature = Signature::decode(signature).map_err(|error| error.to_string())?;
    pubkey
        .verify(&buffer, &signature, true)
        .map_err(|error| error.to_string())?;
    Ok(Some(buffer))
}

async fn install_update(
    app: &AppHandle,
    state: &Arc<LauncherState>,
    update: Update,
    update_dialog: &UpdateDialog,
) -> Result<(), String> {
    let update_version = update.version.clone();
    state.update_in_progress.store(true, Ordering::SeqCst);
    let snapshot = update_snapshot(app, state, |snapshot| {
        snapshot.update_message = format!("正在下载 {update_version}…");
        snapshot.update_available = false;
    });
    let (cancel, mut cancel_receiver) = tauri::async_runtime::channel(1);
    let cancel_requested = Arc::new(AtomicBool::new(false));
    update_dialog.show_progress(
        &snapshot.update_message,
        cancel,
        Arc::clone(&cancel_requested),
    );
    let progress_app = app.clone();
    let progress_state = Arc::clone(state);
    let progress_version = update_version.clone();
    let progress_dialog = update_dialog.clone();
    let finish_app = app.clone();
    let finish_state = Arc::clone(state);
    let finish_dialog = update_dialog.clone();
    let mut downloaded = 0_u64;
    let download_result = {
        let download = download_update(
            app,
            &update,
            &cancel_requested,
            move |chunk_length, content_length| {
                downloaded = downloaded.saturating_add(chunk_length as u64);
                let progress = content_length.filter(|total| *total > 0).map(|total| {
                    downloaded
                        .saturating_mul(100)
                        .saturating_div(total)
                        .min(100)
                });
                let snapshot = update_snapshot(&progress_app, &progress_state, |snapshot| {
                    snapshot.update_message = match progress {
                        Some(progress) => {
                            format!("正在下载 {progress_version} · {progress}%")
                        }
                        None => format!("正在下载 {progress_version}…"),
                    };
                });
                progress_dialog.set_progress(&snapshot.update_message, progress, true);
            },
            move || {
                let snapshot = update_snapshot(&finish_app, &finish_state, |snapshot| {
                    snapshot.update_message = "正在验证更新…".into();
                });
                finish_dialog.set_progress(&snapshot.update_message, Some(100), false);
            },
        );
        let mut download = std::pin::pin!(download);
        poll_fn(|cx| {
            if cancel_requested.load(Ordering::SeqCst)
                || matches!(cancel_receiver.poll_recv(cx), Poll::Ready(Some(())))
            {
                return Poll::Ready(Ok(None));
            }
            match download.as_mut().poll(cx) {
                Poll::Ready(result) => {
                    if cancel_requested.load(Ordering::SeqCst)
                        || matches!(cancel_receiver.poll_recv(cx), Poll::Ready(Some(())))
                    {
                        Poll::Ready(Ok(None))
                    } else {
                        Poll::Ready(result)
                    }
                }
                Poll::Pending => Poll::Pending,
            }
        })
        .await
    };
    let bytes = match download_result {
        Ok(None) => {
            append_log(
                state,
                &format!("Update {update_version} download cancelled by user"),
            );
            state.update_in_progress.store(false, Ordering::SeqCst);
            update_snapshot(app, state, |snapshot| {
                snapshot.update_message = "更新已取消。".into();
                snapshot.update_available = true;
            });
            return Ok(());
        }
        Ok(Some(bytes)) => bytes,
        Err(error) => {
            append_log(state, &format!("Update download failed: {error}"));
            state.update_in_progress.store(false, Ordering::SeqCst);
            update_snapshot(app, state, |snapshot| {
                snapshot.update_message = format!("更新下载或签名验证失败：{error}");
                snapshot.update_available = true;
            });
            return Err(error);
        }
    };

    let snapshot = update_snapshot(app, state, |snapshot| {
        snapshot.update_message = "正在安装更新…".into();
    });
    update_dialog.set_progress(&snapshot.update_message, None, false);
    {
        let _lifecycle = state.lifecycle.lock().unwrap();
        if state.intentional_stop.load(Ordering::SeqCst) {
            return Err("App exit is in progress".into());
        }
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
    let snapshot = update_snapshot(app, state, |snapshot| {
        snapshot.update_message = "正在重启…".into();
    });
    update_dialog.set_progress(&snapshot.update_message, None, false);
    app.restart()
}

fn finish_update_flow(
    state: &LauncherState,
    check_update: &MenuItem<tauri::Wry>,
    quit: &MenuItem<tauri::Wry>,
) {
    state.update_in_progress.store(false, Ordering::SeqCst);
    check_update.set_text("检查更新").unwrap();
    check_update.set_enabled(true).unwrap();
    quit.set_enabled(true).unwrap();
    state.update_flow_in_progress.store(false, Ordering::SeqCst);
}

async fn offer_update(
    app: &AppHandle,
    state: &Arc<LauncherState>,
    check_update: &MenuItem<tauri::Wry>,
    quit: &MenuItem<tauri::Wry>,
    show_current_version: bool,
) {
    if cfg!(target_os = "windows") {
        update_snapshot(app, state, |snapshot| {
            snapshot.update_message = "Windows 版本暂不支持自动更新。".into();
            snapshot.update_available = false;
        });
        check_update
            .set_text("检查更新（Windows 暂不支持）")
            .unwrap();
        check_update.set_enabled(false).unwrap();
        return;
    }
    if state
        .update_flow_in_progress
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return;
    }
    check_update.set_enabled(false).unwrap();
    let update = match check_for_startup_update(app, state).await {
        Ok(update) => update,
        Err(error) => {
            append_log(state, &format!("Update check failed: {error}"));
            update_snapshot(app, state, |snapshot| {
                snapshot.update_message = format!("更新检查失败：{error}");
                snapshot.update_available = false;
            });
            if show_current_version {
                show_error_dialog(
                    app,
                    "Codex Taskboard 更新检查失败",
                    &format!("无法检查更新。请稍后重试。\n\n{error}"),
                );
            }
            finish_update_flow(state, check_update, quit);
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
        finish_update_flow(state, check_update, quit);
        return;
    };

    let version = update.version.clone();
    append_log(state, &format!("Showing update prompt for {version}"));
    let Some(update_dialog) = UpdateDialog::prompt(app, &version) else {
        append_log(state, &format!("Update {version} deferred by user"));
        finish_update_flow(state, check_update, quit);
        return;
    };
    append_log(state, &format!("Update {version} accepted by user"));
    quit.set_enabled(false).unwrap();
    match install_update(app, state, update, &update_dialog).await {
        Ok(()) => {
            update_dialog.close();
            finish_update_flow(state, check_update, quit);
        }
        Err(error) => {
            append_log(state, &format!("Update installation failed: {error}"));
            let service_recovered = state.snapshot.lock().unwrap().child_pid.is_some();
            let service_message = if service_recovered {
                "任务面板服务已恢复。"
            } else {
                "任务面板服务未能恢复，请重新打开 App。"
            };
            update_dialog.close();
            show_error_dialog(
                app,
                "Codex Taskboard 更新失败",
                &format!(
                    "更新未完成。{service_message}\n\n请稍后重试。详情见启动日志。\n\n{error}"
                ),
            );
            finish_update_flow(state, check_update, quit);
        }
    }
}

fn main() {
    let app = tauri::Builder::default()
        .enable_macos_default_menu(false)
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(ActivationPolicy::Accessory);
            let home_directory = app.path().home_dir()?;
            let bundled_skill = app
                .path()
                .resource_dir()?
                .join("app/skills/manage-taskboard");
            let legacy_skill_conflict = reconcile_legacy_skill(&home_directory, &bundled_skill)?;
            let global_skill = home_directory.join(".agents/skills/manage-taskboard");
            if global_skill.exists() {
                fs::remove_dir_all(&global_skill)?;
            }
            copy_directory(&bundled_skill, &global_skill)?;
            #[cfg(target_os = "macos")]
            let data_directory = home_directory.join("Library/Application Support/Codex Taskboard");
            #[cfg(target_os = "macos")]
            let log_directory = home_directory.join("Library/Logs/Codex Taskboard");
            #[cfg(target_os = "windows")]
            let data_directory = std::env::var_os("APPDATA")
                .map(PathBuf::from)
                .ok_or_else(|| std::io::Error::other("APPDATA is unavailable"))?
                .join("Codex Taskboard");
            #[cfg(target_os = "windows")]
            let log_directory = std::env::var_os("LOCALAPPDATA")
                .map(PathBuf::from)
                .ok_or_else(|| std::io::Error::other("LOCALAPPDATA is unavailable"))?
                .join("Codex Taskboard/Logs");
            #[cfg(target_os = "linux")]
            let data_directory = std::env::var_os("XDG_DATA_HOME")
                .filter(|value| !value.is_empty())
                .map(PathBuf::from)
                .unwrap_or_else(|| home_directory.join(".local/share"))
                .join("Codex Taskboard");
            #[cfg(target_os = "linux")]
            let log_directory = std::env::var_os("XDG_STATE_HOME")
                .filter(|value| !value.is_empty())
                .map(PathBuf::from)
                .unwrap_or_else(|| home_directory.join(".local/state"))
                .join("Codex Taskboard");
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
                version.clone(),
                instance_lock,
            ));
            app.manage(state.clone());

            let app_info = MenuItem::with_id(
                app,
                "app-info",
                format!("{} - {version}", app.package_info().name),
                false,
                None::<&str>,
            )?;
            let launcher_status = MenuItem::with_id(
                app,
                "launcher-status",
                "运行状态：启动中",
                false,
                None::<&str>,
            )?;
            *state.status_menu.lock().unwrap() = Some(launcher_status.clone());
            let open_taskboard_item =
                MenuItem::with_id(app, "open-taskboard", "打开任务面板", true, None::<&str>)?;
            let open_taskboard_web = MenuItem::with_id(
                app,
                "open-taskboard-web",
                "在网页打开任务面板",
                true,
                None::<&str>,
            )?;
            let check_update =
                MenuItem::with_id(app, "check-update", "检查更新", false, None::<&str>)?;
            let restart_codex =
                MenuItem::with_id(app, "restart-codex", "重新打开 Codex", true, None::<&str>)?;
            let autostart_enabled = app.autolaunch().is_enabled()?;
            let autostart = CheckMenuItem::with_id(
                app,
                "autostart",
                "开机自启动",
                true,
                autostart_enabled,
                None::<&str>,
            )?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let tray_menu = Menu::with_items(
                app,
                &[
                    &app_info,
                    &launcher_status,
                    &open_taskboard_item,
                    &open_taskboard_web,
                    &restart_codex,
                    &check_update,
                    &autostart,
                    &quit,
                ],
            )?;
            let check_update_menu = check_update.clone();
            let quit_menu = quit.clone();
            let autostart_menu = autostart.clone();
            let autostart_confirmed = Arc::new(AtomicBool::new(autostart_enabled));
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
                        let state = Arc::clone(state.inner());
                        let app = app.clone();
                        let check_update = check_update_menu.clone();
                        let quit = quit_menu.clone();
                        tauri::async_runtime::spawn(async move {
                            offer_update(&app, &state, &check_update, &quit, true).await;
                        });
                    }
                    "open-taskboard" => {
                        let Some(state) = app.try_state::<Arc<LauncherState>>() else {
                            return;
                        };
                        let state = Arc::clone(state.inner());
                        let app = app.clone();
                        tauri::async_runtime::spawn_blocking(move || {
                            if let Err(error) = open_taskboard(&state) {
                                append_log(&state, &format!("Launcher menu open failed: {error}"));
                                show_error_dialog(
                                    &app,
                                    "Codex Taskboard 打开失败",
                                    &format!("{error}\n\n请确认 Codex 正在运行。"),
                                );
                            }
                        });
                    }
                    "open-taskboard-web" => {
                        let Some(state) = app.try_state::<Arc<LauncherState>>() else {
                            return;
                        };
                        let state = Arc::clone(state.inner());
                        let app = app.clone();
                        tauri::async_runtime::spawn_blocking(move || {
                            if let Err(error) = open_taskboard_in_browser(&state) {
                                append_log(
                                    &state,
                                    &format!("Launcher menu browser open failed: {error}"),
                                );
                                show_error_dialog(&app, "Codex Taskboard 网页打开失败", &error);
                            }
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
                    "autostart" => {
                        let manager = app.autolaunch();
                        let previous = autostart_confirmed.load(Ordering::SeqCst);
                        let mut confirmed_before = previous;
                        let operation_error = match manager.is_enabled() {
                            Ok(enabled) => {
                                confirmed_before = enabled;
                                autostart_confirmed.store(enabled, Ordering::SeqCst);
                                let result = if enabled {
                                    manager.disable()
                                } else {
                                    manager.enable()
                                };
                                result.err().map(|error| error.to_string())
                            }
                            Err(error) => Some(error.to_string()),
                        };
                        let sync_error = match manager.is_enabled() {
                            Ok(enabled) => {
                                autostart_confirmed.store(enabled, Ordering::SeqCst);
                                autostart_menu.set_checked(enabled).unwrap();
                                None
                            }
                            Err(error) => {
                                autostart_menu.set_checked(confirmed_before).unwrap();
                                autostart_confirmed.store(confirmed_before, Ordering::SeqCst);
                                Some(error.to_string())
                            }
                        };
                        if let Some(error) = operation_error.or(sync_error) {
                            show_error_dialog(app, "Codex Taskboard 自启动设置失败", &error);
                        }
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

            let periodic_update_app = app.handle().clone();
            let periodic_update_state = Arc::clone(&state);
            let periodic_check_update = check_update.clone();
            let periodic_quit = quit.clone();
            thread::spawn(move || loop {
                thread::sleep(UPDATE_CHECK_INTERVAL);
                let app_handle = periodic_update_app.clone();
                let state = Arc::clone(&periodic_update_state);
                let check_update = periodic_check_update.clone();
                let quit = periodic_quit.clone();
                tauri::async_runtime::spawn(async move {
                    offer_update(&app_handle, &state, &check_update, &quit, false).await;
                });
            });

            let app_handle = app.handle().clone();
            let startup_check_update = check_update.clone();
            let startup_quit = quit.clone();
            tauri::async_runtime::spawn(async move {
                if let Some((legacy_skill, backup_path)) = legacy_skill_conflict {
                    match resolve_legacy_skill_conflict(&app_handle, &legacy_skill, &backup_path) {
                        Ok(true) => {}
                        Ok(false) => {
                            app_handle.exit(0);
                            return;
                        }
                        Err(error) => {
                            show_error_dialog(
                                &app_handle,
                                "Codex Taskboard Skill 更新失败",
                                &format!("无法保留旧 Skill：{error}"),
                            );
                            app_handle.exit(1);
                            return;
                        }
                    }
                }
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
                offer_update(
                    &app_handle,
                    &state,
                    &startup_check_update,
                    &startup_quit,
                    false,
                )
                .await;
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
            let result = start_launcher(app_handle, &state).and_then(|_| open_taskboard(&state));
            if let Err(error) = result {
                append_log(&state, &format!("Launcher panel reopen failed: {error}"));
                show_error_dialog(
                    app_handle,
                    "Codex Taskboard 打开失败",
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
                #[cfg(any(target_os = "macos", target_os = "linux"))]
                unsafe {
                    libc::flock(state._instance_lock.as_raw_fd(), libc::LOCK_UN);
                }
            }
        }
        _ => {}
    });
}
