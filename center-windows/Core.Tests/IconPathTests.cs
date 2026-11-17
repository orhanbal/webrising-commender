using Wecommander.Center.Core;
using Xunit;

namespace Wecommander.Center.Core.Tests;

public class IconPathTests
{
    [Fact]
    public void EveryIconParsesInBothVariantsInsideTheBox()
    {
        foreach (var name in Enum.GetValues<IconName>())
        {
            foreach (var active in new[] { false, true })
            {
                var commands = IconPath.Commands(name, active);
                Assert.NotEmpty(commands);
                Assert.Equal('M', commands[0].Kind);
                Assert.Equal('Z', commands[^1].Kind);
                Assert.All(commands.SelectMany(c => c.Points), v => Assert.InRange(v, -0.5, IconPath.Box + 0.5));
            }
            // Linear and Bold are different drawings.
            Assert.NotEqual(IconData.Path(name, false), IconData.Path(name, true));
        }
    }

    [Fact]
    public void ParsesTheGeneratedFormat()
    {
        var c = IconPath.Parse("M1 2L3.5 -4Q5 6 7 8C1 2 3 4 5 6Z");
        Assert.Equal("MLQCZ", new string(c.Select(x => x.Kind).ToArray()));
        Assert.Equal([3.5, -4], c[1].Points);
        Assert.Equal([1, 2, 3, 4, 5, 6], c[3].Points);
        Assert.Empty(c[4].Points);
    }

    [Theory]
    [InlineData("A1 2")]
    [InlineData("M1,2")]
    [InlineData("M1")]
    public void RejectsAnythingElse(string data) => Assert.Throws<FormatException>(() => IconPath.Parse(data));
}
