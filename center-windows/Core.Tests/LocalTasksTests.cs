using Wecommander.Center.Core;
using Xunit;

public class LocalTasksTests
{
    // What "schtasks /query /xml ONE" prints (shortened): a comment with the path, then the definition.
    private const string Xml = """
<?xml version="1.0" encoding="UTF-16"?>
<Tasks>
<!-- \WECOMMANDER\yedek -->
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Date>2026-11-17T10:00:00</Date>
    <Author>PC\ayse</Author>
    <URI>\WECOMMANDER\yedek</URI>
  </RegistrationInfo>
  <Principals>
    <Principal id="Author">
      <UserId>PC\ayse</UserId>
      <LogonType>InteractiveToken</LogonType>
    </Principal>
  </Principals>
  <Settings>
    <Enabled>true</Enabled>
  </Settings>
  <Triggers>
    <CalendarTrigger>
      <StartBoundary>2026-11-17T03:30:00</StartBoundary>
      <ScheduleByWeek>
        <DaysOfWeek><Monday /><Friday /></DaysOfWeek>
        <WeeksInterval>1</WeeksInterval>
      </ScheduleByWeek>
    </CalendarTrigger>
  </Triggers>
  <Actions Context="Author">
    <Exec>
      <Command>"C:\Program Files\Backup\backup.exe"</Command>
      <Arguments>--all --quiet</Arguments>
    </Exec>
  </Actions>
</Task>
<!-- \Microsoft\Windows\Defrag\ScheduledDefrag -->
<Task version="1.6" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Author>$(@%SystemRoot%\system32\defragsvc.dll,-801)</Author>
  </RegistrationInfo>
  <Principals>
    <Principal id="LocalSystem">
      <UserId>S-1-5-18</UserId>
      <RunLevel>HighestAvailable</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <Enabled>false</Enabled>
  </Settings>
  <Triggers />
  <Actions Context="LocalSystem">
    <Exec>
      <Command>%windir%\system32\defrag.exe</Command>
      <Arguments>-c -h -o -$</Arguments>
    </Exec>
  </Actions>
</Task>
<!-- \Updater -->
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Principals>
    <Principal id="Author">
      <GroupId>S-1-5-32-545</GroupId>
    </Principal>
  </Principals>
  <Triggers>
    <LogonTrigger><Enabled>true</Enabled></LogonTrigger>
    <CalendarTrigger>
      <StartBoundary>2026-01-01T09:00:00</StartBoundary>
      <Repetition><Interval>PT1H</Interval></Repetition>
      <ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay>
    </CalendarTrigger>
  </Triggers>
  <Actions>
    <ComHandler><ClassId>{A6BA00FE-40E8-477C-B713-C64A14F18ADB}</ClassId></ComHandler>
  </Actions>
</Task>
</Tasks>
""";

    // "schtasks /query /fo csv /v /nh" in German: titles and words translated, positions and result codes not.
    private const string Csv = "\"PC\",\"\\WECOMMANDER\\yedek\",\"21.11.2026 03:30:00\",\"Bereit\",\"Interaktiv\",\"Nicht zutreffend\",\"267011\",\"PC\\ayse\",\"\"\"C:\\Program Files\\Backup\\backup.exe\"\" --all\"\r\n"
        + "\"PC\",\"\\WECOMMANDER\\yedek\",\"24.11.2026 03:30:00\",\"Bereit\",\"Interaktiv\",\"Nicht zutreffend\",\"267011\",\"PC\\ayse\",\"x\"\r\n"
        + "\"PC\",\"\\Microsoft\\Windows\\Defrag\\ScheduledDefrag\",\"Nicht zutreffend\",\"Deaktiviert\",\"Nur Hintergrund\",\"10.11.2026 01:00:00\",\"0\",\"x\",\"x\"\r\n"
        + "\"PC\",\"\\Updater\",\"17.11.2026 12:00:00\",\"Running\",\"Interaktiv\",\"17.11.2026 11:00:00\",\"-2147216609\",\"x\",\"x\"\r\n"
        + "\"HostName\",\"TaskName\",\"Next Run Time\"\r\n";

    private static List<LocalTask> Tasks() => LocalTasks.Merge(LocalTasks.ParseXml(Xml), LocalTasks.ParseCsv(Csv));

    [Fact]
    public void DefinitionsComeFromTheXmlWithTheirPaths()
    {
        var tasks = LocalTasks.ParseXml(Xml);
        Assert.Equal([@"\WECOMMANDER\yedek", @"\Microsoft\Windows\Defrag\ScheduledDefrag", @"\Updater"], tasks.Select(t => t.Path));
        var ours = tasks[0];
        Assert.Equal("yedek", ours.Name);
        Assert.Equal(@"\WECOMMANDER", ours.Folder);
        Assert.Equal(@"PC\ayse", ours.Author);
        Assert.True(ours.Enabled && ours.IsOurs && !ours.IsWindows);
        var trigger = Assert.Single(ours.Triggers);
        Assert.Equal("weekly", trigger.Schedule);
        Assert.Equal([DayOfWeek.Monday, DayOfWeek.Friday], trigger.Days);
        Assert.Equal(new DateTime(2026, 11, 17, 3, 30, 0), trigger.Start);
        Assert.Equal(@"""C:\Program Files\Backup\backup.exe"" --all --quiet", ours.Command);
        var defrag = tasks[1];
        Assert.False(defrag.Enabled);
        Assert.True(defrag.IsWindows);
        Assert.Equal(@"\Microsoft\Windows\Defrag", defrag.Folder);
        Assert.Empty(defrag.Triggers);
        Assert.Equal("\\", tasks[2].Folder);
        Assert.Equal("COM", tasks[2].Actions[0].Kind);
        Assert.Empty(LocalTasks.ParseXml(""));
        Assert.Empty(LocalTasks.ParseXml("<Tasks><broken"));
        // One unreadable task (an error line in the middle) does not lose the others.
        var damaged = Xml.Replace("<Settings>\n    <Enabled>false</Enabled>", "ERROR: Access is denied. <Settings");
        Assert.Equal([@"\WECOMMANDER\yedek", @"\Updater"], LocalTasks.ParseXml(damaged).Select(t => t.Path));
    }

    [Fact]
    public void TimesAndResultsComeFromTheCsvByPositionInAnyLanguage()
    {
        var csv = LocalTasks.ParseCsv(Csv);
        Assert.Equal(3, csv.Count);
        // A task with two triggers has two lines: the first counts.
        Assert.Equal("21.11.2026 03:30:00", csv[@"\WECOMMANDER\yedek"].Next);
        Assert.Null(csv[@"\WECOMMANDER\yedek"].Last);
        Assert.Equal(LocalTasks.CodeNotYetRun, csv[@"\WECOMMANDER\yedek"].Result);
        Assert.Null(csv[@"\Microsoft\Windows\Defrag\ScheduledDefrag"].Next);
        Assert.Equal(unchecked((int)0x8004131F), csv[@"\Updater"].Result);

        var tasks = Tasks();
        Assert.Equal(LocalTaskState.Ready, tasks[0].State);
        Assert.Equal(LocalTaskState.Disabled, tasks[1].State);
        Assert.Equal(LocalTaskState.Running, tasks[2].State);
        Assert.Equal(LocalTaskState.Running, (tasks[0] with { LastResult = LocalTasks.CodeRunning }).State);
        Assert.Equal(["a", "b,c", "d\"e", ""], LocalTasks.SplitCsv("\"a\",\"b,c\",\"d\"\"e\","));
    }

    [Fact]
    public void ResultCodesAreShownInHexWithTheirMeaning()
    {
        Assert.Equal("0x0 · başarılı", LocalTasks.ResultText(0));
        Assert.StartsWith("0x1 · ", LocalTasks.ResultText(1));
        Assert.Equal("0x41301 · şu anda çalışıyor", LocalTasks.ResultText(0x41301));
        Assert.Equal("0x41303 · henüz hiç çalışmadı", LocalTasks.ResultText(0x41303));
        Assert.Equal("0x8004131F · görevin bir örneği zaten çalışıyor", LocalTasks.ResultText(unchecked((int)0x8004131F)));
        Assert.Equal("0x2A · programın çıkış kodu", LocalTasks.ResultText(42));
        Assert.Equal("—", LocalTasks.ResultText(null));
    }

    [Fact]
    public void WindowsTasksAreHiddenUntilAskedAndOursComeFirst()
    {
        var tasks = Tasks();
        Assert.Equal([@"\WECOMMANDER\yedek", @"\Updater"], LocalTasks.Filter(tasks, "", false).Select(t => t.Path));
        Assert.Equal([@"\WECOMMANDER\yedek", @"\Updater", @"\Microsoft\Windows\Defrag\ScheduledDefrag"], LocalTasks.Filter(tasks, null, true).Select(t => t.Path));
        Assert.Equal([@"\Microsoft\Windows\Defrag\ScheduledDefrag"], LocalTasks.Filter(tasks, "defrag.exe", true).Select(t => t.Path));
        Assert.Empty(LocalTasks.Filter(tasks, "defrag", false));
    }

    [Fact]
    public void TriggersAreDescribed()
    {
        var tasks = Tasks();
        Assert.StartsWith("Her hafta ", tasks[0].TriggerSummary);
        Assert.EndsWith(" 03:30", tasks[0].TriggerSummary);
        Assert.Equal("Tetikleyici yok (yalnız elle)", tasks[1].TriggerSummary);
        Assert.Equal("Oturum açılınca · Her gün 09:00 · 1 sa aralıkla tekrar", tasks[2].TriggerSummary);
    }

    [Fact]
    public void TasksOfOtherAccountsOrWithHighestRightsNeedAnAdmin()
    {
        var tasks = Tasks();
        Assert.False(LocalTasks.NeedsAdmin(tasks[0], @"PC\ayse", null));
        Assert.False(LocalTasks.NeedsAdmin(tasks[0], "ayse", null));
        Assert.True(LocalTasks.NeedsAdmin(tasks[0], @"PC\mehmet", null));
        Assert.False(LocalTasks.NeedsAdmin(tasks[0] with { UserId = "S-1-5-21-1-2-3-1001" }, @"PC\ayse", "S-1-5-21-1-2-3-1001"));
        Assert.True(LocalTasks.NeedsAdmin(tasks[1], @"PC\ayse", null)); // SYSTEM, highest rights
        Assert.True(LocalTasks.NeedsAdmin(tasks[2], @"PC\ayse", null)); // a group
        Assert.True(LocalTasks.Denied("ERROR: Access is denied."));
        Assert.True(LocalTasks.Denied("FEHLER: Zugriff verweigert"));
        Assert.True(LocalTasks.Denied("x (0x80070005)"));
        Assert.False(LocalTasks.Denied("ERROR: The system cannot find the file specified."));
    }

    [Theory]
    [InlineData("yedek", true)]
    [InlineData("Gece yedeği 2", true)]
    [InlineData("a.b-c_d", true)]
    [InlineData("", false)]
    [InlineData("..\\Microsoft", false)]
    [InlineData("x\\y", false)]
    [InlineData("a\" & calc", false)]
    [InlineData("a|b", false)]
    [InlineData(".hidden", false)]
    public void TaskNamesAreChecked(string name, bool ok) => Assert.Equal(ok, LocalTasks.CheckName(name) is null);

    [Theory]
    [InlineData(@"C:\Program Files\Backup\backup.exe", true)]
    [InlineData("cmd.exe", true)]
    [InlineData(@"\\nas\tools\sync.exe", true)]
    [InlineData("", false)]
    [InlineData("calc.exe\" & evil", false)]
    [InlineData("a.exe|b", false)]
    [InlineData("%TEMP%\\x.exe", false)]
    [InlineData("C:x.exe", false)]
    [InlineData(@"\x.exe", false)]
    public void ProgramsAreChecked(string program, bool ok) => Assert.Equal(ok, LocalTasks.CheckProgram(program) is null);

    [Theory]
    [InlineData("--all --quiet", true)]
    [InlineData("/c exit 0", true)]
    [InlineData("\"C:\\a b\\c.txt\" -v", true)]
    [InlineData("x & del *", false)]
    [InlineData("x > out.txt", false)]
    [InlineData("a | b", false)]
    [InlineData("%PATH%", false)]
    [InlineData("\"unbalanced", false)]
    [InlineData("two\nlines", false)]
    public void ArgumentsAreChecked(string args, bool ok) => Assert.Equal(ok, LocalTasks.CheckArguments(args) is null);

    [Fact]
    public void CreateBuildsOneArgumentPerValueInOurFolder()
    {
        var daily = new LocalTaskSpec("wc-selftest", "cmd.exe", "/c exit 0", "daily", "03:00", []);
        Assert.Null(LocalTasks.Check(daily));
        Assert.Equal(["/create", "/tn", @"\WECOMMANDER\wc-selftest", "/tr", "cmd.exe /c exit 0", "/sc", "DAILY", "/st", "03:00", "/it", "/f"], LocalTasks.Create(daily));
        var weekly = new LocalTaskSpec("yedek", @"C:\Program Files\Backup\backup.exe", "--all", "weekly", "23:15", [DayOfWeek.Friday, DayOfWeek.Monday]);
        Assert.Equal(["/create", "/tn", @"\WECOMMANDER\yedek", "/tr", "\"C:\\Program Files\\Backup\\backup.exe\" --all", "/sc", "WEEKLY", "/d", "MON,FRI", "/st", "23:15", "/it", "/f"], LocalTasks.Create(weekly));
        var logon = new LocalTaskSpec("x", "notepad.exe", "", "logon", "", []);
        Assert.Null(LocalTasks.Check(logon));
        Assert.Equal(["/create", "/tn", @"\WECOMMANDER\x", "/tr", "notepad.exe", "/sc", "ONLOGON", "/it", "/f"], LocalTasks.Create(logon));
        Assert.Equal(["/create", "/tn", @"\WECOMMANDER\x", "/tr", "notepad.exe", "/sc", "ONCE", "/st", "07:05", "/it", "/f"], LocalTasks.Create(logon with { Schedule = "once", Time = "07:05" }));

        Assert.NotNull(LocalTasks.Check(daily with { Time = "25:00" }));
        Assert.NotNull(LocalTasks.Check(daily with { Time = "3:00" }));
        Assert.NotNull(LocalTasks.Check(weekly with { Days = [] }));
        Assert.NotNull(LocalTasks.Check(daily with { Schedule = "hourly" }));
        Assert.NotNull(LocalTasks.Check(daily with { Arguments = new string('a', 300) }));
        Assert.NotNull(LocalTasks.Check(daily with { Name = "a\\b" }));
    }

    [Fact]
    public void OnlyOurTasksMayBeDeleted()
    {
        Assert.Equal(["/delete", "/tn", @"\WECOMMANDER\wc-selftest", "/f"], LocalTasks.Delete(@"\WECOMMANDER\wc-selftest"));
        Assert.Null(LocalTasks.Delete(@"\Microsoft\Windows\Defrag\ScheduledDefrag"));
        Assert.Null(LocalTasks.Delete(@"\WECOMMANDER\"));
        Assert.Null(LocalTasks.Delete(@"\WECOMMANDER\..\Microsoft\x"));
        Assert.Null(LocalTasks.Delete(@"\WECOMMANDERX\x"));
        Assert.Null(LocalTasks.Delete(@"\Updater"));
        Assert.NotNull(LocalTasks.DeleteRefusal(@"\Updater"));
        Assert.Equal(["/run", "/tn", @"\Updater"], LocalTasks.Run(@"\Updater"));
        Assert.Equal(["/change", "/tn", @"\Updater", "/disable"], LocalTasks.SetEnabled(@"\Updater", false));
        Assert.Equal(["/change", "/tn", @"\Updater", "/enable"], LocalTasks.SetEnabled(@"\Updater", true));
    }

    [Fact]
    public void OurTaskComesBackAsTheFormValues()
    {
        var spec = LocalTasks.SpecFrom(Tasks()[0]);
        Assert.NotNull(spec);
        Assert.Equal("yedek", spec.Name);
        Assert.Equal(@"C:\Program Files\Backup\backup.exe", spec.Program);
        Assert.Equal("--all --quiet", spec.Arguments);
        Assert.Equal("weekly", spec.Schedule);
        Assert.Equal("03:30", spec.Time);
        Assert.Equal([DayOfWeek.Monday, DayOfWeek.Friday], spec.Days);
        Assert.Null(LocalTasks.SpecFrom(Tasks()[2])); // not ours
    }

    [Fact]
    public void TheConfirmationShowsTheExactCommand()
    {
        Assert.Equal(@"schtasks /run /tn \WECOMMANDER\x", LocalTasks.CommandLine("schtasks", LocalTasks.Run(@"\WECOMMANDER\x")));
        Assert.Equal("schtasks /create /tn \"\\WECOMMANDER\\Gece yedek\" /tr \"\\\"C:\\a b\\x.exe\\\" -v\"",
            LocalTasks.CommandLine("schtasks", ["/create", "/tn", @"\WECOMMANDER\Gece yedek", "/tr", "\"C:\\a b\\x.exe\" -v"]));
    }

    [Fact]
    public void HistoryIsReadFromTheOperationalLog()
    {
        Assert.Equal(["qe", "Microsoft-Windows-TaskScheduler/Operational", @"/q:*[EventData[Data[@Name='TaskName']='\WECOMMANDER\x']]", "/c:30", "/rd:true", "/f:xml"],
            LocalTasks.HistoryQuery(@"\WECOMMANDER\x"));
        Assert.Null(LocalTasks.HistoryQuery(@"\x' or '1'='1"));
        const string events = """
<Event xmlns="http://schemas.microsoft.com/win/2004/08/events/event"><System><EventID>102</EventID><TimeCreated SystemTime="2026-11-17T03:00:05.1234567Z"/></System><EventData><Data Name="TaskName">\WECOMMANDER\x</Data></EventData></Event>
<Event xmlns="http://schemas.microsoft.com/win/2004/08/events/event"><System><EventID>201</EventID><TimeCreated SystemTime="2026-11-17T03:00:04.0000000Z"/></System><EventData><Data Name="TaskName">\WECOMMANDER\x</Data><Data Name="ResultCode">0</Data></EventData></Event>
<Event xmlns="http://schemas.microsoft.com/win/2004/08/events/event"><System><EventID>100</EventID><TimeCreated SystemTime="2026-11-17T03:00:00.0000000Z"/></System></Event>
""";
        var list = LocalTasks.ParseHistory(events);
        Assert.Equal([102, 201, 100], list.Select(e => e.Id));
        Assert.Equal("Görev tamamlandı", list[0].Text);
        Assert.Equal(0, list[1].Result);
        Assert.Equal(new DateTime(2026, 11, 17, 3, 0, 0, DateTimeKind.Utc), list[2].At);
        Assert.Empty(LocalTasks.ParseHistory(""));
        Assert.Empty(LocalTasks.ParseHistory("<Event><broken"));
    }
}
