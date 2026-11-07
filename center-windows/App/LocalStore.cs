using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Win32;

namespace Wecommander.Center;

/// <summary>
/// Where the app keeps its things: %LOCALAPPDATA%\WECOMMANDER Center.
/// The center token is encrypted with Windows DPAPI for this Windows user;
/// it is never shown in the window or written to a log.
/// </summary>
internal static class LocalStore
{
    public static string Directory { get; } =
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "WECOMMANDER Center");

    private static string TokenPath => Path.Combine(Directory, "center-token.bin");
    private static readonly byte[] Entropy = Encoding.UTF8.GetBytes("wecommander-center-token-v1");

    private sealed record Stored(string Server, string Token);

    public static string? LoadToken(string server)
    {
        try
        {
            var plain = ProtectedData.Unprotect(File.ReadAllBytes(TokenPath), Entropy, DataProtectionScope.CurrentUser);
            var stored = JsonSerializer.Deserialize<Stored>(plain);
            return stored is not null && stored.Server == server ? stored.Token : null;
        }
        catch (Exception e) when (e is IOException or CryptographicException or JsonException or UnauthorizedAccessException)
        {
            return null;
        }
    }

    public static void SaveToken(string server, string token)
    {
        System.IO.Directory.CreateDirectory(Directory);
        var plain = JsonSerializer.SerializeToUtf8Bytes(new Stored(server, token));
        var tmp = TokenPath + ".tmp";
        File.WriteAllBytes(tmp, ProtectedData.Protect(plain, Entropy, DataProtectionScope.CurrentUser));
        File.Move(tmp, TokenPath, overwrite: true);
    }

    public static void DeleteToken()
    {
        try { File.Delete(TokenPath); } catch (IOException) { }
    }

    private const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
    private const string RunName = "WECOMMANDER Center";

    public static bool AutostartEnabled
    {
        get
        {
            using var key = Registry.CurrentUser.OpenSubKey(RunKey);
            return key?.GetValue(RunName) is string value && value.Contains(Environment.ProcessPath ?? "\u0000", StringComparison.OrdinalIgnoreCase);
        }
        set
        {
            using var key = Registry.CurrentUser.CreateSubKey(RunKey);
            if (value) key.SetValue(RunName, $"\"{Environment.ProcessPath}\" --hidden");
            else key.DeleteValue(RunName, throwOnMissingValue: false);
        }
    }
}
