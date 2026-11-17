using System.Globalization;
using System.Reflection;
using System.Text.Json;

namespace Wecommander.Center.Core;

/// <summary>One "Yenilikler" entry: short user-facing sentences per language.</summary>
public sealed record ReleaseNote(string Id, string Date, IReadOnlyList<string> Platforms, IReadOnlyDictionary<string, IReadOnlyList<string>> Items)
{
    public bool AppliesTo(string platform) => Platforms.Count == 0 || Platforms.Contains(platform, StringComparer.OrdinalIgnoreCase);

    /// <summary>The sentences in <paramref name="language"/>, else English, else Turkish.</summary>
    public IReadOnlyList<string> In(string language) =>
        Items.TryGetValue(language, out var own) && own.Count > 0 ? own
        : Items.TryGetValue("en", out var en) && en.Count > 0 ? en
        : Items.TryGetValue("tr", out var tr) ? tr : [];

    /// <summary>The date as a long date in the interface language ("17 Kasım 2026").</summary>
    public string DateText(CultureInfo culture) =>
        DateTime.TryParseExact(Date, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var d) ? d.ToString("D", culture) : Date;
}

/// <summary>
/// The release notes shipped inside the app (release-notes/notes.json,
/// embedded). Entries are matched by id, not by build number: each platform
/// numbers its builds separately and the number is not known when a note is
/// written. The app remembers the newest id it has shown (Settings.LastSeenNotes)
/// and shows every entry above it in the list (newest first).
/// </summary>
public static class ReleaseNotes
{
    public const string Windows = "windows";
    public const string MacOS = "macos";
    /// <summary>A person updating from a much older version sees at most this many entries.</summary>
    public const int MaxShown = 5;

    private static IReadOnlyList<ReleaseNote>? _embedded;

    /// <summary>Every entry in the app, newest first (empty when the resource is missing or broken).</summary>
    public static IReadOnlyList<ReleaseNote> Embedded
    {
        get
        {
            if (_embedded is not null) return _embedded;
            try
            {
                using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("Wecommander.Center.Core.ReleaseNotes.notes.json");
                _embedded = stream is null ? [] : Parse(new StreamReader(stream).ReadToEnd());
            }
            catch (Exception) { _embedded = []; }
            return _embedded;
        }
    }

    /// <summary>Reads notes.json; entries without an id or date are skipped. Throws nothing.</summary>
    public static IReadOnlyList<ReleaseNote> Parse(string json)
    {
        var list = new List<ReleaseNote>();
        try
        {
            using var doc = JsonDocument.Parse(json);
            if (doc.RootElement.ValueKind != JsonValueKind.Object || !doc.RootElement.TryGetProperty("releases", out var releases) || releases.ValueKind != JsonValueKind.Array) return list;
            foreach (var r in releases.EnumerateArray())
            {
                if (r.ValueKind != JsonValueKind.Object) continue;
                var id = Text(r, "id");
                var date = Text(r, "date");
                if (string.IsNullOrWhiteSpace(id) || string.IsNullOrWhiteSpace(date)) continue;
                var platforms = new List<string>();
                if (r.TryGetProperty("platforms", out var p) && p.ValueKind == JsonValueKind.Array)
                    foreach (var x in p.EnumerateArray())
                        if (x.ValueKind == JsonValueKind.String && x.GetString() is { Length: > 0 } s) platforms.Add(s);
                var items = new Dictionary<string, IReadOnlyList<string>>();
                if (r.TryGetProperty("items", out var it) && it.ValueKind == JsonValueKind.Object)
                    foreach (var lang in it.EnumerateObject())
                        if (lang.Value.ValueKind == JsonValueKind.Array)
                            items[lang.Name] = lang.Value.EnumerateArray()
                                .Where(x => x.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(x.GetString()))
                                .Select(x => x.GetString()!).ToList();
                list.Add(new ReleaseNote(id, date, platforms, items));
            }
        }
        catch (JsonException) { }
        return list;
    }

    private static string? Text(JsonElement e, string name) =>
        e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    public static IReadOnlyList<ReleaseNote> For(IEnumerable<ReleaseNote> notes, string platform) =>
        notes.Where(n => n.AppliesTo(platform)).ToList();

    /// <summary>
    /// The entries newer than <paramref name="lastSeen"/> (notes for one
    /// platform, newest first): those above it in the list. An id that is no
    /// longer in the list falls back to its date (ids start with YYYY-MM-DD);
    /// no last seen id: all of them. At most <see cref="MaxShown"/>.
    /// </summary>
    public static IReadOnlyList<ReleaseNote> Since(IReadOnlyList<ReleaseNote> notes, string? lastSeen)
    {
        if (string.IsNullOrWhiteSpace(lastSeen)) return notes.Take(MaxShown).ToList();
        for (var i = 0; i < notes.Count; i++)
            if (notes[i].Id == lastSeen) return notes.Take(Math.Min(i, MaxShown)).ToList();
        if (lastSeen.Length < 10 || !DateTime.TryParseExact(lastSeen[..10], "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out _)) return [];
        var seenDate = lastSeen[..10];
        return notes.Where(n => string.CompareOrdinal(n.Date, seenDate) > 0).Take(MaxShown).ToList();
    }

    /// <summary>What to do at start: the entries to show now, and the id to remember (null: keep the stored one).</summary>
    public readonly record struct Decision(IReadOnlyList<ReleaseNote> Show, string? Remember);

    /// <summary>
    /// At start. A fresh install (no settings yet) shows nothing and remembers
    /// the newest id. After an update the entries since the remembered id are
    /// shown; an install from before this feature (settings, but no id) sees
    /// the entries it carries. Nothing new: only the id is brought up to date.
    /// </summary>
    public static Decision AtStart(IReadOnlyList<ReleaseNote> notes, string? lastSeen, bool settingsExisted)
    {
        var newest = notes.Count > 0 ? notes[0].Id : null;
        if (newest is null) return new Decision([], null);
        if (!settingsExisted) return new Decision([], newest == lastSeen ? null : newest);
        var show = Since(notes, lastSeen);
        return new Decision(show, newest == lastSeen ? null : newest);
    }
}
