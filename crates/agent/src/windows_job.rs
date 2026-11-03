//! Windows Job Object ownership for Agent-launched PTY sessions.
//! A job is created with KILL_ON_JOB_CLOSE and assigned immediately after
//! the shell spawns. Failure to attach is fatal; never run an uncontained PTY.
//! This closes the lifetime/cleanup gap after assignment. For PTY sessions the
//! spawn-to-assignment interval remains (portable-pty spawns the child); for
//! process_exec and background tasks `contain_suspended` closes it: the child
//! is created suspended, assigned, and only then resumed, so no code of the
//! command runs outside the job. Arbitrary process_kill PIDs are not covered.
use anyhow::{anyhow, Context, Result};
use std::{ffi::c_void, io, mem, ptr};
use windows_sys::Win32::{
    Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE, WAIT_OBJECT_0, WAIT_TIMEOUT},
    System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    },
    System::Threading::WaitForSingleObject,
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
            return Err(io::Error::last_os_error())
                .context("assign PTY process to kill-on-close job");
        }
        Ok(job)
    }

    pub fn terminate(&self) -> Result<()> {
        // An explicit stop must not acknowledge success merely because the
        // PTY root exited while other clients still hold Arc<Session>.
        if unsafe { TerminateJobObject(self.0, 1) } == 0 {
            return Err(io::Error::last_os_error()).context("terminate owned PTY job");
        }
        match unsafe { WaitForSingleObject(self.0, 3000) } {
            WAIT_OBJECT_0 => Ok(()),
            WAIT_TIMEOUT => Err(anyhow!("owned PTY job did not terminate within 3 seconds")),
            _ => Err(io::Error::last_os_error()).context("wait for owned PTY job termination"),
        }
    }
}

/// Assign a child created with `CREATE_SUSPENDED` to a new kill-on-close job
/// and then resume its (single) initial thread. On any failure the child is
/// terminated through the job (or directly) and an error is returned, so an
/// uncontained command never runs.
pub fn contain_suspended(process_handle: HANDLE, pid: u32) -> Result<WindowsJob> {
    let job = match WindowsJob::attach(process_handle) {
        Ok(job) => job,
        Err(error) => {
            unsafe { windows_sys::Win32::System::Threading::TerminateProcess(process_handle, 1) };
            return Err(error);
        }
    };
    if let Err(error) = resume_initial_threads(pid) {
        let _ = job.terminate();
        return Err(error);
    }
    Ok(job)
}

fn resume_initial_threads(pid: u32) -> Result<()> {
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
    };
    use windows_sys::Win32::System::Threading::{OpenThread, ResumeThread, THREAD_SUSPEND_RESUME};
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error()).context("snapshot threads of suspended child");
    }
    let mut entry = THREADENTRY32 {
        dwSize: mem::size_of::<THREADENTRY32>() as u32,
        ..Default::default()
    };
    let mut resumed = 0;
    let mut ok = unsafe { Thread32First(snapshot, &mut entry) } != 0;
    while ok {
        if entry.th32OwnerProcessID == pid {
            let thread = unsafe { OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID) };
            if !thread.is_null() {
                let previous = unsafe { ResumeThread(thread) };
                unsafe { CloseHandle(thread) };
                if previous != u32::MAX {
                    resumed += 1;
                }
            }
        }
        ok = unsafe { Thread32Next(snapshot, &mut entry) } != 0;
    }
    unsafe { CloseHandle(snapshot) };
    if resumed == 0 {
        return Err(anyhow!("suspended child thread could not be resumed"));
    }
    Ok(())
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
    fn invalid_child_handle_is_rejected_without_job_creation() {
        assert!(WindowsJob::attach(ptr::null_mut()).is_err());
        assert!(WindowsJob::attach(INVALID_HANDLE_VALUE).is_err());
    }

    #[test]
    fn job_close_terminates_child_and_late_descendant() {
        // The second ping starts after assignment and therefore inherits the
        // job. The test never touches an unrelated PID or production machine.
        let mut child = Command::new("cmd.exe")
            .args([
                "/D",
                "/C",
                "ping -n 3 127.0.0.1 > NUL & ping -n 30 127.0.0.1 > NUL",
            ])
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
                    && process
                        .name()
                        .to_string_lossy()
                        .eq_ignore_ascii_case("ping.exe")
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
            if system
                .process(descendant)
                .is_none_or(|p| p.start_time() != started)
            {
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
