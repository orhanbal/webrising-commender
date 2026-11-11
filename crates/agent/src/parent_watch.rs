//! Ends the agent when the app that started it is gone.
//!
//! The WECOMMANDER app runs the agent as a child process and passes its own
//! process id in `WECOMMANDER_PARENT_PID`. If the app is ended any way at all
//! (quit, crash, Task Manager, an installer replacing it), the agent exits
//! too, so it never keeps the app's files locked or runs on without the app.
//! Agents started any other way (service, LaunchAgent, systemd) do not get
//! the variable and are not affected.

pub const PARENT_ENV: &str = "WECOMMANDER_PARENT_PID";

/// The parent process id from the environment, if it is a valid one.
pub fn parent_from_env() -> Option<u32> {
    parse(std::env::var(PARENT_ENV).ok().as_deref())
}

fn parse(value: Option<&str>) -> Option<u32> {
    value?.trim().parse::<u32>().ok().filter(|pid| *pid > 1)
}

/// Starts a background thread that exits the process once `pid` is gone.
pub fn exit_with(pid: u32) {
    std::thread::Builder::new()
        .name("parent-watch".into())
        .spawn(move || {
            wait_for_exit(pid);
            tracing::info!("the app that started the agent has exited; stopping");
            std::process::exit(0);
        })
        .ok();
}

#[cfg(windows)]
fn wait_for_exit(pid: u32) {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{
        OpenProcess, WaitForSingleObject, INFINITE, PROCESS_SYNCHRONIZE,
    };
    // SAFETY: plain Win32 calls on a handle owned by this function.
    unsafe {
        let handle = OpenProcess(PROCESS_SYNCHRONIZE, 0, pid);
        if handle.is_null() {
            // Already gone (or not ours to wait on): nothing keeps us alive.
            return;
        }
        WaitForSingleObject(handle, INFINITE);
        CloseHandle(handle);
    }
}

#[cfg(unix)]
fn wait_for_exit(pid: u32) {
    // When the parent dies the child is re-parented (to launchd/init), so its
    // parent id changes; checking it every second needs no extra rights.
    loop {
        if std::os::unix::process::parent_id() != pid {
            return;
        }
        std::thread::sleep(std::time::Duration::from_secs(1));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_only_real_parent_ids() {
        assert_eq!(parse(Some("4242")), Some(4242));
        assert_eq!(parse(Some(" 77 \n")), Some(77));
        assert_eq!(parse(Some("1")), None);
        assert_eq!(parse(Some("0")), None);
        assert_eq!(parse(Some("abc")), None);
        assert_eq!(parse(None), None);
    }
}
