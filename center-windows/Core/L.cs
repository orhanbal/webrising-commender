using System.Globalization;
using System.Reflection;
using System.Text.Json;

namespace Wecommander.Center.Core;

/// <summary>
/// The app's interface language. The Turkish text written in the code is the
/// key; each other language is a table (Core/Strings/&lt;code&gt;.json, embedded)
/// from that text to the translation. A missing translation falls back to
/// English, then to the Turkish source. Terminal output, logs, paths, commands
/// and errors that come from a server are never passed through here.
/// </summary>
public static class L
{
    /// <summary>The languages of the first release, in the order the settings list them.</summary>
    public static readonly (string Code, string Name)[] Languages =
    [
        ("en", "English"),
        ("tr", "Türkçe"),
        ("de", "Deutsch"),
        ("pt-BR", "Português (Brasil)"),
        ("es", "Español"),
        ("fr", "Français"),
    ];

    private static readonly Dictionary<string, Dictionary<string, string>> Tables = [];
    private static readonly object Gate = new();

    /// <summary>The language in use. Turkish until the app chooses one (tests read the source text).</summary>
    public static string Current { get; private set; } = "tr";

    /// <summary>Raised after the language changed (open windows rebuild their text).</summary>
    public static event Action? Changed;

    /// <summary>A system or saved language tag (de-AT, pt-PT, es-419) to one of ours; null when we have none.</summary>
    public static string? Match(string? tag)
    {
        if (string.IsNullOrWhiteSpace(tag)) return null;
        var lower = tag.Trim().ToLowerInvariant();
        if (lower.StartsWith("pt", StringComparison.Ordinal)) return "pt-BR";
        var head = lower.Split('-', '_')[0];
        foreach (var (code, _) in Languages)
            if (string.Equals(code, head, StringComparison.OrdinalIgnoreCase)) return code;
        return null;
    }

    /// <summary>The saved choice, else the Windows display language, else English.</summary>
    public static string Resolve(string? saved, CultureInfo? system = null) =>
        Match(saved) ?? Match((system ?? CultureInfo.CurrentUICulture).Name) ?? "en";

    public static void Use(string code)
    {
        var next = Match(code) ?? "en";
        if (next == Current) return;
        Current = next;
        Changed?.Invoke();
    }

    /// <summary>Formats numbers and dates for the current language.</summary>
    public static CultureInfo Culture => CultureInfo.GetCultureInfo(Current switch
    {
        "tr" => "tr-TR",
        "de" => "de-DE",
        "pt-BR" => "pt-BR",
        "es" => "es-ES",
        "fr" => "fr-FR",
        _ => "en-US",
    });

    /// <summary>The text in the current language.</summary>
    public static string T(string source) => In(Current, source);

    /// <summary>A text with values: "{0} sunucusuna bağlanılıyor" with the values in order.</summary>
    public static string F(string source, params object?[] values) =>
        string.Format(Culture, T(source), values);

    public static string In(string code, string source)
    {
        if (code == "tr") return source;
        if (Table(code).TryGetValue(source, out var own) && own.Length > 0) return own;
        if (code != "en" && Table("en").TryGetValue(source, out var english) && english.Length > 0) return english;
        return source;
    }

    /// <summary>A language's table (empty when there is none).</summary>
    public static IReadOnlyDictionary<string, string> Table(string code)
    {
        lock (Gate)
        {
            if (Tables.TryGetValue(code, out var cached)) return cached;
            var table = new Dictionary<string, string>();
            var name = $"Wecommander.Center.Core.Strings.{code}.json";
            using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(name);
            if (stream is not null)
                table = JsonSerializer.Deserialize<Dictionary<string, string>>(stream) ?? [];
            Tables[code] = table;
            return table;
        }
    }
}
