using System.Globalization;

namespace Wecommander.Center.Core;

/// <summary>One drawing command of an icon's outline: M (move), L (line), Q (quadratic), C (cubic) or Z (close).</summary>
/// <param name="Kind">The command letter.</param>
/// <param name="Points">x, y pairs (M and L: 1, Q: 2, C: 3, Z: none), in the icon's 24x24 box.</param>
public readonly record struct IconCommand(char Kind, double[] Points);

/// <summary>
/// The path data written by scripts/gen-icons.py (IconData.g.cs): absolute
/// M/L/Q/C/Z with space-separated numbers, nonzero fill, a 24x24 box.
/// </summary>
public static class IconPath
{
    /// <summary>The box the outlines are drawn in.</summary>
    public const double Box = 24;

    private static readonly Dictionary<(IconName, bool), IconCommand[]> Cache = [];

    /// <summary>The commands of <paramref name="name"/> (Bold when <paramref name="active"/>), parsed once.</summary>
    public static IconCommand[] Commands(IconName name, bool active)
    {
        lock (Cache)
        {
            if (!Cache.TryGetValue((name, active), out var commands))
                Cache[(name, active)] = commands = Parse(IconData.Path(name, active));
            return commands;
        }
    }

    /// <summary>Parses generated path data; anything else is a <see cref="FormatException"/>.</summary>
    public static IconCommand[] Parse(string data)
    {
        var commands = new List<IconCommand>();
        var i = 0;
        while (i < data.Length)
        {
            var kind = data[i++];
            var count = kind switch { 'M' or 'L' => 2, 'Q' => 4, 'C' => 6, 'Z' => 0, _ => throw new FormatException($"unexpected '{kind}' in icon path") };
            var points = new double[count];
            for (var n = 0; n < count; n++)
            {
                if (n > 0)
                {
                    if (i >= data.Length || data[i] != ' ') throw new FormatException("icon path: a space was expected");
                    i++;
                }
                var start = i;
                while (i < data.Length && (char.IsAsciiDigit(data[i]) || data[i] is '-' or '.')) i++;
                points[n] = double.Parse(data.AsSpan(start, i - start), NumberStyles.AllowLeadingSign | NumberStyles.AllowDecimalPoint, CultureInfo.InvariantCulture);
            }
            commands.Add(new IconCommand(kind, points));
        }
        return [.. commands];
    }
}
