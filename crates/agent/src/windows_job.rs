//! Windows Job Object ownership for Agent-launched PTY sessions.
//! A job is created with KILL_ON_JOB_CLOSE and assigned immediately after
//! the shell spawns. Failure to attach is fatal; never run an uncontained PTY.
//! This closes the lifetime/cleanup gap after assignment, but it does NOT
//! eliminate the spawn-to-assignment race or cover arbitrary process_kill PIDs.
use anyhow::{anyhow, Context, Result};
use std::{ffi::c_void, io, mem, ptr};
use windows_sys::Win32::{
    Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE},
    System::{
        JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
            SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        },
    },
};

pub struct WindowsJob(HANDLE);

// A Windows kernel handle is an opaque, ref-counted OS resource; CloseHandle
// is safe from any thread. This type owns its one handle exclusively.
unsafe impl Send for WindowsJob {}
unsafe impl Sync for WindowsJob {}

impl WindowsJob {
    pub fn attach(process_handle: HANDLE) -> Result<Self> {
        // Use the exact retained child HANDLE, not OpenProcess(pid): a PID
        // can be recycled after the child exits and must never become authority
        // to assign or kill an unrelated process.
        if process_handle.is_null() || process_handle == INVALID_HANDLE_VALUE {
            return Err(anyhow!("invalid owned PTY child handle"));
        }
        let handle = unsafe { CreateJobObjectW(ptr::null(), ptr::null()) };
        if handle.is_null() {
            return Err(io::Error::last_os_error()).context("create PTY job object");
        }
        let job = Self(handle);
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let configured = unsafe {
            SetInformationJobObject(
                job.0,
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast::<c_void>(),
                mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if configured == 0 {
            return Err(io::Error::last_os_error()).context("configure PTY job kill-on-close");
        }
        if unsafe { AssignProcessToJobObject(job.0, process_handle) } == 0 {
            return Err(io::Error::last_os_error()).context("assign PTY process to kill-on-close job");
        }
        Ok(job)
    }
}

impl Drop for WindowsJob {
    fn drop(&mut self) {
        // Windows terminates every process remaining in the job when its last
        // handle closes, including descendants spawned after assignment.
        unsafe { CloseHandle(self.0) };
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        os::windows::io::AsRawHandle,
        process::Command,
        time::{Duration, Instant},
    };
    use sysinfo::{Pid, ProcessesToUpdate, System};

    #[test]
    fn job_close_terminates_child_and_late_descendant() {
        // The second ping starts after assignment and therefore inherits the
        // job. The test never touches an unrelated PID or production machine.
        let mut child = Command::new("cmd.exe")
            .args(["/D", "/C", "ping -n 3 127.0.0.1 > NUL & ping -n 30 127.0.0.1 > NUL"])
            .spawn()
            .expect("spawn disposable PTY-like command");
        let job = match WindowsJob::attach(child.as_raw_handle()) {
            Ok(job) => job,
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                panic!("job attachment failed closed: {error}");
            }
        };
        let deadline = Instant::now() + Duration::from_secs(8);
        let mut first = None;
        let mut observed = None;
        while Instant::now() < deadline {
            let mut system = System::new();
            system.refresh_processes(ProcessesToUpdate::All, true);
            for (pid, process) in system.processes() {
                if process.parent() == Some(Pid::from_u32(child.id()))
                    && process.name().to_string_lossy().eq_ignore_ascii_case("ping.exe")
                {
                    if first.is_none() {
                        first = Some(*pid);
                    } else if first != Some(*pid) {
                        // The second ping was spawned after job assignment.
                        observed = Some((*pid, process.start_time()));
                    }
                }
            }
            if observed.is_some() {
                break;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        let (descendant, started) = observed.expect("expected a late ping descendant");
        drop(job);
        let deadline = Instant::now() + Duration::from_secs(5);
        let exited = loop {
            let mut system = System::new();
            system.refresh_processes(ProcessesToUpdate::All, true);
            if system.process(descendant).is_none_or(|p| p.start_time() != started) {
                break true;
            }
            if Instant::now() >= deadline {
                break false;
            }
            std::thread::sleep(Duration::from_millis(25));
        };
        if !exited {
            let _ = child.kill();
        }
        let _ = child.wait();
        assert!(exited, "job close did not terminate the owned descendant");
    }
}
