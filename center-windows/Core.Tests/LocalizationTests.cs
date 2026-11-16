using System.Globalization;
using System.Text.RegularExpressions;
using Wecommander.Center.Core;
using Xunit;

namespace Wecommander.Center.Core.Tests;

/// <summary>
/// The app speaks six languages: every text the code passes through L.T / L.F
/// has a translation in each table with the same placeholders, and no Turkish
/// text is left in the code outside those calls.
/// </summary>
public class LocalizationTests
{
    private static readonly string[] Others = ["en", "de", "pt-BR", "es", "fr"];
    private static readonly Regex Call = new(@"\bL\.[TF]\(\s*""((?:[^""\\]|\\.)*)""", RegexOptions.Compiled);
    private static readonly Regex Literal = new(@"(?<![@])\$?""((?:[^""\\\n]|\\.)*)""", RegexOptions.Compiled);
    private static readonly Regex TurkishLetters = new("[çğıöşüÇĞİÖŞÜ]", RegexOptions.Compiled);
    // Turkish words written only with ASCII letters (the letter check alone misses "Bekleyen onaylar").
    private static readonly Regex TurkishWords = new(@"\b(bir|ile|yok|var|onay|onaylar|bekleyen|oturumu?|sunucu|sunucular|kapat|yeni|tamam|hata|kenara|kullanan|zaten|daha|konteyner|konteyneri|servisi|cihazda|merkez|yine|durdur|gerekli|sahip|izleyici|reddedildi|anahtar|ekip|kaydet|uygula|sil|ekle|gizle|ayarlar)\b", RegexOptions.Compiled | RegexOptions.IgnoreCase);
    // Sample commands shown as placeholders: the same in every language.
    private static readonly HashSet<string> Commands = ["cd /var/www && git status"];
    private static readonly Regex Holes = new(@"\{\d+(?:[,:][^}]*)?\}", RegexOptions.Compiled);

    private static string Root()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !File.Exists(Path.Combine(dir.FullName, "Core", "L.cs"))) dir = dir.Parent;
        return dir?.FullName ?? throw new InvalidOperationException("center-windows folder not found");
    }

    private static IEnumerable<string> Sources(string root) =>
        Directory.GetFiles(Path.Combine(root, "App"), "*.cs").Concat(Directory.GetFiles(Path.Combine(root, "Core"), "*.cs"))
            .Where(f => !f.EndsWith(Path.DirectorySeparatorChar + "L.cs", StringComparison.Ordinal));

    private static string Unescape(string s) => Regex.Unescape(s);

    private static HashSet<string> Keys()
    {
        var keys = new HashSet<string>();
        foreach (var file in Sources(Root()))
            foreach (Match m in Call.Matches(File.ReadAllText(file))) keys.Add(Unescape(m.Groups[1].Value));
        return keys;
    }

    private static string Placeholders(string s) => string.Join(",", Holes.Matches(s).Select(m => m.Value).Order(StringComparer.Ordinal));

    [Fact]
    public void EveryTextHasATranslationInEachLanguageWithTheSamePlaceholders()
    {
        var keys = Keys();
        Assert.True(keys.Count > 500, $"only {keys.Count} texts found");
        foreach (var code in Others)
        {
            var table = L.Table(code);
            var missing = keys.Where(k => !table.TryGetValue(k, out var v) || string.IsNullOrWhiteSpace(v)).ToList();
            Assert.True(missing.Count == 0, $"{code}: {missing.Count} missing, e.g. {string.Join(" | ", missing.Take(5))}");
            var broken = keys.Where(k => Placeholders(k) != Placeholders(table[k])).ToList();
            Assert.True(broken.Count == 0, $"{code}: placeholders differ in {string.Join(" | ", broken.Take(5))}");
            var spacing = keys.Where(k => (k.StartsWith(' ') != table[k].StartsWith(' ')) || (k.EndsWith(' ') != table[k].EndsWith(' '))).ToList();
            Assert.True(spacing.Count == 0, $"{code}: leading/trailing space differs in {string.Join(" | ", spacing.Take(5))}");
        }
    }

    [Fact]
    public void NoTurkishTextIsLeftOutsideTheTranslationCalls()
    {
        var left = new List<string>();
        foreach (var file in Sources(Root()))
        {
            var lines = File.ReadAllLines(file);
            for (var i = 0; i < lines.Length; i++)
            {
                var line = lines[i];
                var code = line.Split("//")[0];
                var stripped = Call.Replace(code, "L.T(\"\")");
                foreach (Match m in Literal.Matches(stripped))
                {
                    var value = m.Groups[1].Value;
                    if (Commands.Contains(value)) continue;
                    if (TurkishLetters.IsMatch(value) || TurkishWords.IsMatch(Regex.Replace(value, @"\{[^}]*\}", ""))) left.Add($"{Path.GetFileName(file)}:{i + 1}: {m.Value}");
                }
            }
        }
        Assert.True(left.Count == 0, "wrap these in L.T / L.F:\n" + string.Join("\n", left.Take(20)));
    }

    [Fact]
    public void ChoosesTheLanguageFromTheSavedChoiceThenWindows()
    {
        Assert.Equal("de", L.Resolve(null, CultureInfo.GetCultureInfo("de-AT")));
        Assert.Equal("pt-BR", L.Resolve(null, CultureInfo.GetCultureInfo("pt-PT")));
        Assert.Equal("es", L.Resolve(null, CultureInfo.GetCultureInfo("es-MX")));
        Assert.Equal("en", L.Resolve(null, CultureInfo.GetCultureInfo("ja-JP")));
        Assert.Equal("tr", L.Resolve("tr", CultureInfo.GetCultureInfo("fr-FR")));
        Assert.Equal("fr", L.Resolve("nonsense", CultureInfo.GetCultureInfo("fr-CA")));
    }

    [Fact]
    public void TurkishIsTheSourceAndOtherLanguagesTranslate()
    {
        Assert.Equal("Kaydet", L.In("tr", "Kaydet"));
        Assert.Equal("Save", L.In("en", "Kaydet"));
        Assert.NotEqual("Kaydet", L.In("de", "Kaydet"));
        // A text without a table entry falls back to the source rather than failing.
        Assert.Equal("zz-unknown", L.In("de", "zz-unknown"));
    }
}
