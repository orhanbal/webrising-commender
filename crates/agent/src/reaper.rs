//! Linux command reaper (parity 2C: detached Unix descendants).
//!
//! `process_exec` and background tasks put the command in its own process
//! group, but a descendant can leave that group (`setsid`, double fork, a
//! daemonizing tool) and survive a timeout, a cancel or the end of the
//! command. On Linux the Agent therefore runs each command under a short-lived
//! copy of itself in reaper mode:
//!
//! ```text
//! webrising-commender __wecommander-reaper -- /bin/sh -lc <command>
//! ```
//!
//! The reaper marks itself `PR_SET_CHILD_SUBREAPER`, so every orphaned
//! descendant, detached or not, is re-parented to it rather than to init.
//! When the shell exits, or the reaper receives SIGTERM/SIGINT/SIGHUP (timeout,
//! cancel), or its parent Agent process disappears (its parent pid changes;
//! `PR_SET_PDEATHSIG` is not used because it fires on the death of the
//! spawning *thread*, which may be a short-lived runtime thread), it SIGKILLs its whole
//! descendant tree and reaps it before exiting with the shell's status. Stdio
//! is inherited, so output capture is unchanged. It runs before the async
//! runtime starts and uses only libc and /proc.
//!
//! Known limit: a descendant that is reparented elsewhere by something other
//! than orphaning (none exist in Linux userspace without privileges) is not
//! covered; macOS has no subreaper and keeps the process-group behaviour.

use std::{
    collections::{HashMap, HashSet},
    ffi::CString,
    fs,
    os::unix::ffi::OsStrExt,
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};

use crate::process_ops::REAPER_ARG;

static TERMINATE: AtomicBool = AtomicBool::new(false);

extern "C" fn on_terminate(_: libc::c_int) {
    TERMINATE.store(true, Ordering::SeqCst);
}

/// If the process was started in reaper mode, run it and return the exit code.
pub fn run_if_requested() -> Option<i32> {
    let args: Vec<std::ffi::OsString> = std::env::args_os().collect();
    if args.get(1).map(|a| a.as_bytes()) != Some(REAPER_ARG.as_bytes()) {
        return None;
    }
    if args.get(2).map(|a| a.as_bytes()) != Some(b"--".as_slice()) || args.len() < 4 {
        eprintln!("reaper: usage: {REAPER_ARG} -- program [args...]");
        return Some(127);
    }
    Some(run(&args[3..]))
}

fn run(argv: &[std::ffi::OsString]) -> i32 {
    unsafe {
        if libc::prctl(libc::PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) != 0 {
            eprintln!("reaper: PR_SET_CHILD_SUBREAPER failed");
            return 126;
        }
        for signal in [libc::SIGTERM, libc::SIGINT, libc::SIGHUP] {
            let mut action: libc::sigaction = std::mem::zeroed();
            action.sa_sigaction = on_terminate as extern "C" fn(libc::c_int) as usize;
            libc::sigemptyset(&mut action.sa_mask);
            action.sa_flags = 0; // no SA_RESTART: waitpid must return EINTR
            libc::sigaction(signal, &action, std::ptr::null_mut());
        }
    }
    let parent = unsafe { libc::getppid() };
    if parent == 1 {
        return 125;
    }

    let c_args: Vec<CString> = match argv.iter().map(|a| CString::new(a.as_bytes())).collect() {
        Ok(v) => v,
        Err(_) => return 127,
    };
    let mut ptrs: Vec<*const libc::c_char> = c_args.iter().map(|a| a.as_ptr()).collect();
    ptrs.push(std::ptr::null());

    let main_child = unsafe { libc::fork() };
    if main_child < 0 {
        return 126;
    }
    if main_child == 0 {
        unsafe {
            // Restore default dispositions for the command.
            for signal in [libc::SIGTERM, libc::SIGINT, libc::SIGHUP] {
                libc::signal(signal, libc::SIG_DFL);
            }
            libc::execv(ptrs[0], ptrs.as_ptr());
            libc::_exit(127);
        }
    }

    loop {
        // Timeout/cancel signal, or the Agent process is gone (re-parented).
        if TERMINATE.load(Ordering::SeqCst) || unsafe { libc::getppid() } != parent {
            kill_descendants(libc::SIGTERM);
            std::thread::sleep(Duration::from_millis(200));
            kill_all_and_reap();
            return 143;
        }
        let mut status: libc::c_int = 0;
        let pid = unsafe { libc::waitpid(-1, &mut status, libc::WNOHANG) };
        if pid == main_child {
            // The command is done; nothing it started may outlive it.
            kill_all_and_reap();
            return decode_status(status);
        }
        if pid < 0 {
            match std::io::Error::last_os_error().raw_os_error() {
                Some(libc::EINTR) => continue,
                _ => return 126,
            }
        }
        if pid == 0 {
            std::thread::sleep(Duration::from_millis(25));
        }
        // pid > 0: an adopted orphan exited; keep waiting for the command.
    }
}

fn decode_status(status: libc::c_int) -> i32 {
    if libc::WIFEXITED(status) {
        libc::WEXITSTATUS(status)
    } else if libc::WIFSIGNALED(status) {
        128 + libc::WTERMSIG(status)
    } else {
        1
    }
}

/// Parent pid of every process visible in /proc.
fn process_parents() -> HashMap<i32, i32> {
    let mut parents = HashMap::new();
    let Ok(entries) = fs::read_dir("/proc") else {
        return parents;
    };
    for entry in entries.flatten() {
        let Ok(pid) = entry.file_name().to_string_lossy().parse::<i32>() else {
            continue;
        };
        let Ok(stat) = fs::read_to_string(format!("/proc/{pid}/stat")) else {
            continue;
        };
        // comm may contain spaces and ')' — the fields after the last ')' are fixed.
        if let Some(rest) = stat.rsplit_once(')').map(|(_, r)| r) {
            let mut fields = rest.split_whitespace();
            let _state = fields.next();
            if let Some(ppid) = fields.next().and_then(|p| p.parse::<i32>().ok()) {
                parents.insert(pid, ppid);
            }
        }
    }
    parents
}

/// All transitive descendants of this reaper.
fn descendants() -> Vec<i32> {
    let me = unsafe { libc::getpid() };
    let parents = process_parents();
    let mut children: HashMap<i32, Vec<i32>> = HashMap::new();
    for (pid, ppid) in &parents {
        children.entry(*ppid).or_default().push(*pid);
    }
    let mut found = Vec::new();
    let mut seen = HashSet::new();
    let mut stack = vec![me];
    while let Some(pid) = stack.pop() {
        for child in children.get(&pid).into_iter().flatten() {
            if seen.insert(*child) {
                found.push(*child);
                stack.push(*child);
            }
        }
    }
    found
}

fn kill_descendants(signal: libc::c_int) -> usize {
    let pids = descendants();
    for pid in &pids {
        unsafe {
            libc::kill(*pid, signal);
        }
    }
    pids.len()
}

/// SIGKILL the tree repeatedly (it may fork while being killed) and reap every
/// child, until /proc shows no descendant and waitpid reports none, or 5 s pass.
fn kill_all_and_reap() {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let remaining = kill_descendants(libc::SIGKILL);
        loop {
            let mut status = 0;
            let pid = unsafe { libc::waitpid(-1, &mut status, libc::WNOHANG) };
            if pid <= 0 {
                break;
            }
        }
        if remaining == 0 || Instant::now() >= deadline {
            return;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}
