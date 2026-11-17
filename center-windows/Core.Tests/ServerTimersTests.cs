using System.Text.Json;
using Wecommander.Center.Core;
using Xunit;

namespace Wecommander.Center.Core.Tests;

/// <summary>The timers page: the core's JSON (a disabled DEVAGENT timer included), its badges, schedule text, form checks and the commands it confirms.</summary>
public class ServerTimersTests
{
    // What `server.timers` returns for the real server: a disabled, not-loaded timer, a running one, a WECOMMANDER one, cron read only.
    private const string Json = """
    {"privilege":"sudo","loginUser":"wecommander","systemd":true,
     "timers":[
      {"unit":"devagent-local-ci.timer","scope":"system","description":"Check DEVAGENT branch for new commits every 15 minutes","unitFileState":"disabled","activeState":"inactive","subState":"dead",
       "calendar":[],"monotonic":["OnUnitInactiveUSec=15min","OnBootUSec=3min"],"schedule":"OnUnitInactiveUSec=15min ; OnBootUSec=3min","nextRun":null,"lastRun":null,
       "service":"devagent-local-ci.service","serviceDescription":"DEVAGENT offline-safe local CI acceptance (no GitHub Actions)","command":"/usr/local/libexec/devagent-ci-poll","user":"devagent-ci",
       "result":"success","exitStatus":0,"lastExit":null,"serviceState":"inactive","fragmentPath":"/etc/systemd/system/devagent-local-ci.timer","persistent":true,"managed":null},
      {"unit":"logrotate.timer","scope":"system","description":"Daily rotation of log files","unitFileState":"enabled","activeState":"active","subState":"waiting",
       "calendar":["*-*-* 00:00:00"],"monotonic":[],"schedule":"OnCalendar=*-*-* 00:00:00","nextRun":1794960000,"lastRun":1794873601,
       "service":"logrotate.service","serviceDescription":"Rotate log files","command":"/usr/sbin/logrotate /etc/logrotate.conf","user":"root",
       "result":"exit-code","exitStatus":1,"lastExit":1794873602,"serviceState":"failed","fragmentPath":"/usr/lib/systemd/system/logrotate.timer","persistent":true,"managed":null},
      {"unit":"nightly-backup.timer","scope":"system","description":"Nightly backup","unitFileState":"enabled","activeState":"active","subState":"waiting",
       "calendar":["*-*-* 03:00:00"],"monotonic":[],"schedule":"OnCalendar=*-*-* 03:00:00","nextRun":1794970800,"lastRun":null,
       "service":"nightly-backup.service","serviceDescription":"Nightly backup","command":"/bin/sh -c echo hi","user":"backup",
       "result":"success","exitStatus":0,"lastExit":null,"serviceState":"activating","fragmentPath":"/etc/systemd/system/nightly-backup.timer","persistent":true,
       "managed":{"name":"nightly-backup","description":"Nightly backup","command":"echo hi","user":"backup","calendar":"*-*-* 03:00:00"}},
      {"unit":"mine.timer","scope":"user","description":"","unitFileState":"enabled","activeState":"active","subState":"waiting","calendar":["hourly"],"monotonic":[],"schedule":"","nextRun":null,"lastRun":null,
       "service":"mine.service","serviceDescription":"","command":"","user":"","result":"","exitStatus":null,"lastExit":null,"serviceState":"inactive","fragmentPath":"","persistent":false,"managed":null}
     ],
     "cron":[
      {"source":"/etc/cron.d/certbot","schedule":"0 */12 * * *","user":"root","command":"certbot -q renew"},
      {"source":"/etc/cron.d/secret","schedule":"","user":"","command":""},
      {"source":"/etc/cron.daily","schedule":"daily","user":"root","command":"/etc/cron.daily/logrotate"}
     ],
     "crontab":"not-readable","crontabMessage":"fopen: Permission denied"}
    """;

    private static ServerTimers Read() => JsonSerializer.Deserialize<ServerTimers>(Json, CoreClient.Json)!;

    [Fact]
    public void TheDisabledDevagentTimerIsPassiveWithItsMonotonicSchedule()
    {
        var s = Read();
        Assert.True(s.CanChange);
        var d = s.Timers[0];
        Assert.Equal("passive", TimerView.State(d));
        Assert.Equal("Pasif", TimerView.StateText(d));
        Assert.False(d.IsEnabled);
        Assert.True(TimerView.CanEnable(d));
        Assert.False(TimerView.CanDisable(d));
        Assert.False(TimerView.CanStop(d));
        Assert.Equal("son çalışma bitince 15min sonra · açılıştan 3min sonra", TimerView.Schedule(d));
        Assert.Equal("—", TimerView.Time(d.NextRun));
        Assert.Equal("", TimerView.Relative(d.LastRun, DateTimeOffset.UtcNow));
        Assert.Equal("devagent-ci", d.User);
        Assert.Equal("/usr/local/libexec/devagent-ci-poll", d.Command);
        Assert.False(d.IsManaged);
    }

    [Fact]
    public void BadgesActionsAndTimes()
    {
        var s = Read();
        var l = s.Timers[1];
        Assert.Equal("active", TimerView.State(l));
        Assert.False(TimerView.CanEnable(l));
        Assert.True(TimerView.CanDisable(l));
        Assert.Equal("*-*-* 00:00:00", TimerView.Schedule(l));
        Assert.Equal("exit-code (1)", TimerView.Result(l));
        Assert.Equal("success", TimerView.Result(s.Timers[0]));
        Assert.Equal("18.11.2026 03:00", TimerView.Time(l.NextRun, TimeZoneInfo.CreateCustomTimeZone("tr", TimeSpan.FromHours(3), "tr", "tr")));
        Assert.Equal("2 sa 0 dk sonra", TimerView.Relative(l.NextRun, DateTimeOffset.FromUnixTimeSeconds(1794960000 - 7200)));
        Assert.Equal("40 sn önce", TimerView.Relative(1000, DateTimeOffset.FromUnixTimeSeconds(1040)));
        Assert.True(TimerView.CanStop(s.Timers[2]));
        Assert.True(s.Timers[2].IsManaged);
        var user = s.Timers[3];
        Assert.False(user.IsSystem);
        Assert.False(TimerView.CanEnable(user) || TimerView.CanDisable(user) || TimerView.CanRunNow(user));
        Assert.Equal("masked", TimerView.State(l with { UnitFileState = "masked" }));
        Assert.Equal("failed", TimerView.State(l with { ActiveState = "failed" }));
        Assert.False(TimerView.CanEnable(l with { UnitFileState = "static", ActiveState = "inactive" }));
    }

    [Fact]
    public void OrderAndFilter()
    {
        var s = Read();
        var o = TimerView.Ordered(s.Timers.AsEnumerable().Reverse());
        Assert.Equal(["devagent-local-ci.timer", "logrotate.timer", "nightly-backup.timer", "mine.timer"], o.Select(t => t.Unit));
        Assert.Equal(["devagent-local-ci.timer"], TimerView.Ordered(s.Timers, "DEVAGENT-ci").Select(t => t.Unit));
        Assert.Equal(["nightly-backup.timer"], TimerView.Ordered(s.Timers, "backup").Select(t => t.Unit));
    }

    [Fact]
    public void CronIsReadOnlyAndTheCrontabStateIsSaid()
    {
        var s = Read();
        Assert.Equal(3, s.Cron.Count);
        Assert.True(s.Cron[1].Unreadable);
        Assert.False(s.Cron[0].Unreadable);
        Assert.Equal("wecommander kullanıcısının crontab'ı okunamadı (izin yok).", TimerView.CrontabNote(s));
        Assert.Equal("", TimerView.CrontabNote(s with { Crontab = "ok" }));
    }

    private static readonly TimerSpec Spec = new("nightly-backup", "Nightly backup 100%", "echo 'it''s' > /tmp/x", "backup", "*-*-* 03:00:00");

    [Fact]
    public void TheFormIsChecked()
    {
        Assert.Null(TimerView.Check(Spec));
        Assert.Null(TimerView.Check(Spec with { Name = "db-dump_2.nightly", Calendar = "Mon..Fri *-*-* 03:00:00" }));
        foreach (var bad in new[] { "", "-x", "Backup", "a b", "a;rm", "x.timer", "x.service", new string('a', 65) })
            Assert.NotNull(TimerView.Check(Spec with { Name = bad }));
        foreach (var bad in new[] { "", "daily; rm -rf /", "$(id)", "-1" })
            Assert.NotNull(TimerView.Check(Spec with { Calendar = bad }));
        Assert.NotNull(TimerView.Check(Spec with { User = "Root" }));
        Assert.NotNull(TimerView.Check(Spec with { Command = "a\nb" }));
        Assert.NotNull(TimerView.Check(Spec with { Command = " " }));
        Assert.NotNull(TimerView.Check(Spec with { Description = "a\nb" }));
    }

    [Fact]
    public void CommandsMatchWhatTheCoreRuns()
    {
        var s = Read();
        Assert.Equal("systemctl enable --now devagent-local-ci.timer", TimerView.ActionCommand(s.Timers[0], "enable"));
        Assert.Equal("systemctl disable --now logrotate.timer", TimerView.ActionCommand(s.Timers[1], "disable"));
        Assert.Equal("systemctl start --no-block devagent-local-ci.service", TimerView.ActionCommand(s.Timers[0], "start-now"));
        Assert.Equal("systemctl stop devagent-local-ci.service", TimerView.ActionCommand(s.Timers[0], "stop"));
        Assert.Equal("systemctl enable --now 'dev-x\\x2dy.timer'", TimerView.ActionCommand(s.Timers[0] with { Unit = "dev-x\\x2dy.timer" }, "enable"));
        Assert.Throws<ArgumentException>(() => TimerView.ActionCommand(s.Timers[0], "rm"));
        Assert.Equal("journalctl -u devagent-local-ci.service -n 200 --no-pager -o short-iso", TimerView.LogsCommand(s.Timers[0], 200));

        Assert.Equal("/bin/sh -c \"cd /srv && pg_dump \\\"$$DB\\\" | gzip > /backup/db-$$(date +%%F).gz \\\\ end\"",
            TimerView.ExecStart("cd /srv && pg_dump \"$DB\" | gzip > /backup/db-$(date +%F).gz \\ end"));
        var service = TimerView.ServiceFile(Spec);
        Assert.StartsWith("# Managed by WECOMMANDER\n", service);
        Assert.Contains("Description=Nightly backup 100%%\n", service);
        Assert.Contains("\nUser=backup\n", service);
        var timer = TimerView.TimerFile(Spec);
        Assert.Contains("\nOnCalendar=*-*-* 03:00:00\nPersistent=true\nUnit=nightly-backup.service\n", timer);

        var write = TimerView.WriteCommand(Spec, edit: false);
        Assert.StartsWith("printf '%s' '# Managed by WECOMMANDER", write);
        Assert.Contains("echo '\\''it'\\'''\\''s'\\'' > /tmp/x", write);
        Assert.Contains("| tee /etc/systemd/system/nightly-backup.service >/dev/null", write);
        Assert.EndsWith("systemctl daemon-reload\nsystemctl enable --now nightly-backup.timer", write);
        Assert.EndsWith("systemctl try-restart nightly-backup.timer", TimerView.WriteCommand(Spec, edit: true));
        Assert.Equal("systemctl disable --now nightly-backup.timer\nrm -f /etc/systemd/system/nightly-backup.timer /etc/systemd/system/nightly-backup.service\nsystemctl daemon-reload",
            TimerView.DeleteCommand("nightly-backup"));
        Assert.Equal("nightly-backup", TimerView.NameOf(s.Timers[2]));
        Assert.Equal("logrotate", TimerView.NameOf(s.Timers[1]));
    }
}
