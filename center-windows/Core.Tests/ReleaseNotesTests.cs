using System.Globalization;
using Wecommander.Center.Core;
using Xunit;

namespace Wecommander.Center.Core.Tests;

/// <summary>"Yenilikler": the notes shipped in the app and which of them to show after an update.</summary>
public class ReleaseNotesTests
{
    private const string Sample = """
    {"releases":[
     {"id":"2026-12-02","date":"2026-12-02","items":{"tr":["c"],"en":["C"]}},
     {"id":"2026-11-20-mac","date":"2026-11-20","platforms":["macos"],"items":{"tr":["m"],"en":["M"]}},
     {"id":"2026-11-20-win","date":"2026-11-20","platforms":["windows"],"items":{"tr":["b"],"en":["B"],"de":["Bd"]}},
     {"id":"2026-11-17","date":"2026-11-17","platforms":["windows"],"items":{"tr":["a1","a2"],"en":["A1","A2"]}},
     {"date":"2026-11-01","items":{"tr":["no id"]}}
    ]}
    """;

    private static IReadOnlyList<ReleaseNote> Windows() => ReleaseNotes.For(ReleaseNotes.Parse(Sample), ReleaseNotes.Windows);
    private static string[] Ids(IEnumerable<ReleaseNote> notes) => notes.Select(n => n.Id).ToArray();

    [Fact]
    public void ParsesEntriesAndFiltersByPlatform()
    {
        var all = ReleaseNotes.Parse(Sample);
        Assert.Equal(4, all.Count); // the entry without an id is skipped
        Assert.Equal(["2026-12-02", "2026-11-20-win", "2026-11-17"], Ids(Windows()));
        Assert.Equal(["2026-12-02", "2026-11-20-mac"], Ids(ReleaseNotes.For(all, ReleaseNotes.MacOS)));
    }

    [Fact]
    public void BrokenJsonGivesNoEntries()
    {
        Assert.Empty(ReleaseNotes.Parse("{"));
        Assert.Empty(ReleaseNotes.Parse("[]"));
        Assert.Empty(ReleaseNotes.Parse("""{"releases":{}}"""));
    }

    [Fact]
    public void ShowsTheEntriesAboveTheLastSeenOne()
    {
        var notes = Windows();
        Assert.Equal(["2026-12-02", "2026-11-20-win"], Ids(ReleaseNotes.Since(notes, "2026-11-17")));
        Assert.Equal(["2026-12-02"], Ids(ReleaseNotes.Since(notes, "2026-11-20-win")));
        Assert.Empty(ReleaseNotes.Since(notes, "2026-12-02"));
        Assert.Equal(3, ReleaseNotes.Since(notes, null).Count);
    }

    [Fact]
    public void AnUnknownLastSeenIdFallsBackToItsDate()
    {
        var notes = Windows();
        Assert.Equal(["2026-12-02"], Ids(ReleaseNotes.Since(notes, "2026-11-20-removed")));
        Assert.Empty(ReleaseNotes.Since(notes, "garbage"));
    }

    [Fact]
    public void FreshInstallShowsNothingAndRemembersTheNewest()
    {
        var d = ReleaseNotes.AtStart(Windows(), null, settingsExisted: false);
        Assert.Empty(d.Show);
        Assert.Equal("2026-12-02", d.Remember);
    }

    [Fact]
    public void AnUpdateShowsTheNewEntriesOnce()
    {
        var d = ReleaseNotes.AtStart(Windows(), "2026-11-17", settingsExisted: true);
        Assert.Equal(["2026-12-02", "2026-11-20-win"], Ids(d.Show));
        Assert.Equal("2026-12-02", d.Remember);
        var again = ReleaseNotes.AtStart(Windows(), d.Remember, settingsExisted: true);
        Assert.Empty(again.Show);
        Assert.Null(again.Remember);
    }

    [Fact]
    public void AnInstallFromBeforeTheNotesSeesWhatItCarries()
    {
        var d = ReleaseNotes.AtStart(Windows(), null, settingsExisted: true);
        Assert.Equal(3, d.Show.Count);
    }

    [Fact]
    public void AtMostFiveEntriesAreShown()
    {
        var many = Enumerable.Range(1, 9).Select(i => new ReleaseNote($"2026-12-{i:00}", $"2026-12-{i:00}", [], new Dictionary<string, IReadOnlyList<string>>())).Reverse().ToList();
        Assert.Equal(ReleaseNotes.MaxShown, ReleaseNotes.Since(many, null).Count);
        Assert.Equal(ReleaseNotes.MaxShown, ReleaseNotes.Since(many, "2026-12-01").Count);
    }

    [Fact]
    public void TextFallsBackToEnglishThenTurkish()
    {
        var b = Windows()[1];
        Assert.Equal(["Bd"], b.In("de"));
        Assert.Equal(["B"], b.In("fr"));
        Assert.Equal(["b"], b.In("tr"));
        Assert.Contains("November 2026", Windows()[2].DateText(CultureInfo.GetCultureInfo("en-GB")));
        Assert.Equal("someday", new ReleaseNote("x", "someday", [], new Dictionary<string, IReadOnlyList<string>>()).DateText(CultureInfo.InvariantCulture));
    }

    [Fact]
    public void TheEmbeddedNotesAreCompleteForBothApps()
    {
        var all = ReleaseNotes.Embedded;
        Assert.NotEmpty(all);
        Assert.Equal(all.Count, all.Select(n => n.Id).Distinct().Count());
        Assert.NotEmpty(ReleaseNotes.For(all, ReleaseNotes.Windows));
        Assert.NotEmpty(ReleaseNotes.For(all, ReleaseNotes.MacOS));
        foreach (var note in all)
        {
            var count = note.In("tr").Count;
            Assert.True(count > 0, note.Id);
            foreach (var lang in L.Languages.Select(l => l.Code))
                Assert.True(note.Items.TryGetValue(lang, out var items) && items.Count == count, $"{note.Id}: {lang}");
        }
    }
}
