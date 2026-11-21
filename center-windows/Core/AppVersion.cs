namespace Wecommander.Center.Core;

/// <summary>
/// The version shown for a build: Prefix.N, where N is the CI run number
/// (build.txt, the ubuntu-preview-N tag). Updates compare only N, so the
/// prefix can change without breaking them.
/// </summary>
public static class AppVersion
{
    public const string Prefix = "1.0";

    /// <summary>1888 -> "1.0.1888".</summary>
    public static string Of(int build) => $"{Prefix}.{build}";

    /// <summary>Like <see cref="Of(int)"/>; null stays null.</summary>
    public static string? Of(int? build) => build is { } b ? Of(b) : null;
}
