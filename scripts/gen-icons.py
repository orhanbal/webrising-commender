#!/usr/bin/env python3
"""Vuesax (Iconsax) icons for the native apps: Windows (WinUI) and macOS.

icons/icons.json lists the icons the apps use: our name -> Iconsax name. For
every icon the Linear and the Bold SVG are kept in icons/svg/<variant>/ (the
markup the MIT `iconsax-react` package renders). This script turns them into
filled outlines (Linear icons are strokes: they are stroked into exact fill
geometry with Skia and unioned, no raster tracing) and writes the path data:

  center-windows/Core/IconData.g.cs                 (C#, used by App/Icons.cs)
  center-macos/Sources/CenterCore/IconData.g.swift  (Swift, used by WCIcon.swift)

Path data uses one 24x24 box, absolute M/L/Q/C/Z commands, nonzero fill.

Usage:
  python3 scripts/gen-icons.py --fetch    refresh icons/svg from iconsax-react
                                          (needs node, npm and the network)
  python3 scripts/gen-icons.py            write the generated files
                                          (pip install skia-pathops fonttools)
  python3 scripts/gen-icons.py --check    verify the generated files are up to
                                          date (standard library only; CI)
  python3 scripts/gen-icons.py --preview out.png
                                          contact sheet of every icon (Pillow)
"""
import hashlib, json, os, re, shutil, subprocess, sys, tempfile
import xml.etree.ElementTree as ET

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ICONS = os.path.join(ROOT, "icons")
LIST = os.path.join(ICONS, "icons.json")
SVG = os.path.join(ICONS, "svg")
OUT_CS = os.path.join(ROOT, "center-windows", "Core", "IconData.g.cs")
OUT_SWIFT = os.path.join(ROOT, "center-macos", "Sources", "CenterCore", "IconData.g.swift")
VARIANTS = ["linear", "bold"]
NS = "{http://www.w3.org/2000/svg}"
# Curves of round caps and joins come out of Skia as conics; they are split
# into quadratics within this distance (in the 24-unit box).
CONIC_TOLERANCE = 0.002
DECIMALS = 3
SWIFT_KEYWORDS = {"import", "repeat", "return", "default", "case", "class", "func", "let", "var",
                  "in", "is", "as", "do", "if", "else", "for", "while", "switch", "where", "true",
                  "false", "nil", "self", "super", "init", "deinit", "enum", "struct", "protocol",
                  "extension", "operator", "static", "subscript", "typealias", "break", "continue",
                  "defer", "guard", "throw", "throws", "try", "catch", "internal", "private", "public",
                  "fileprivate", "open", "inout", "associatedtype", "rethrows", "Any", "Self", "Type"}


def read_text(path):
    # Line endings normalised so a Windows checkout (autocrlf) hashes the same.
    with open(path, encoding="utf-8") as f:
        return f.read().replace("\r\n", "\n")


def load_list():
    data = json.loads(read_text(LIST))
    icons = data["icons"]
    for name, spec in icons.items():
        if not re.fullmatch(r"[a-z][a-z0-9]*(-[a-z0-9]+)*", name):
            raise SystemExit(f"icons.json: bad name {name!r} (kebab-case)")
        for v in VARIANTS:
            if not re.fullmatch(r"[A-Z][A-Za-z0-9]*", source(spec, v)[0]):
                raise SystemExit(f"icons.json: {name}: bad Iconsax name {source(spec, v)[0]!r}")
    return data


def svg_path(variant, iconsax):
    return os.path.join(SVG, variant, iconsax + ".svg")


def source(spec, variant):
    """(Iconsax name, rotation) of one variant; "bold" in icons.json names
    another icon for the Bold variant (then it is not rotated)."""
    if variant == "bold" and "bold" in spec:
        return spec["bold"], 0
    return spec["iconsax"], spec.get("rotate", 0)


def describe(spec):
    text = spec["iconsax"] + (f" rotated {spec['rotate']} degrees" if spec.get("rotate") else "")
    return text + (f", Bold: {spec['bold']}" if "bold" in spec else "")


def needed_svgs(data):
    return sorted({(v, source(s, v)[0]) for s in data["icons"].values() for v in VARIANTS})


def inputs_hash(data):
    h = hashlib.sha256()
    h.update(read_text(LIST).encode())
    h.update(read_text(os.path.abspath(__file__)).encode())
    for v, n in needed_svgs(data):
        h.update(f"{v}/{n}\n".encode())
        h.update(read_text(svg_path(v, n)).encode())
    return h.hexdigest()


def pascal(name):
    return "".join(p[:1].upper() + p[1:] for p in name.split("-"))


def camel(name):
    p = pascal(name)
    s = p[:1].lower() + p[1:]
    return f"`{s}`" if s in SWIFT_KEYWORDS else s


# ---------------------------------------------------------------- fetch

FETCH_JS = r"""
const React = require('react');
const S = require('react-dom/server');
const I = require('iconsax-react');
const fs = require('fs'), path = require('path');
const [out, ...pairs] = process.argv.slice(2);
for (const p of pairs) {
  const [variant, name] = p.split('/');
  if (!I[name]) { console.error('iconsax-react has no icon ' + name); process.exit(1); }
  const v = variant[0].toUpperCase() + variant.slice(1);
  const svg = S.renderToStaticMarkup(React.createElement(I[name], { variant: v, size: 24, color: '#000' }));
  fs.mkdirSync(path.join(out, variant), { recursive: true });
  fs.writeFileSync(path.join(out, variant, name + '.svg'), svg + '\n');
}
"""


def fetch(data):
    src = data["source"]
    tmp = tempfile.mkdtemp(prefix="iconsax-")
    try:
        with open(os.path.join(tmp, "package.json"), "w") as f:
            json.dump({"name": "iconsax-fetch", "private": True}, f)
        pkgs = [f"{n}@{v}" for n, v in src["npm"].items()]
        npm = shutil.which("npm") or "npm"
        subprocess.run([npm, "install", "--no-audit", "--no-fund", "--silent", *pkgs], cwd=tmp, check=True)
        script = os.path.join(tmp, "fetch.js")
        with open(script, "w") as f:
            f.write(FETCH_JS)
        if os.path.isdir(SVG):
            shutil.rmtree(SVG)
        pairs = [f"{v}/{n}" for v, n in needed_svgs(data)]
        subprocess.run([shutil.which("node") or "node", script, SVG, *pairs], cwd=tmp, check=True)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    print(f"fetched {len(needed_svgs(data))} SVGs into {os.path.relpath(SVG, ROOT)}")


# ---------------------------------------------------------------- convert

def element_paths(svg_file):
    """(d, paint) for every drawing element; paint is ('fill', rule) or
    ('stroke', width, cap, join, miter)."""
    from fontTools.svgLib.path.shapes import PathBuilder
    root = ET.fromstring(read_text(svg_file))
    if root.get("viewBox") != "0 0 24 24":
        raise SystemExit(f"{svg_file}: viewBox is not 0 0 24 24")
    out = []

    def walk(el, inherited):
        style = dict(inherited)
        for k in ("fill", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin",
                  "stroke-miterlimit", "fill-rule", "opacity", "fill-opacity", "stroke-opacity"):
            if el.get(k) is not None:
                style[k] = el.get(k)
        if el.get("transform") or el.get("style") or el.get("clip-path") or el.get("mask"):
            raise SystemExit(f"{svg_file}: unsupported attribute on <{el.tag}>")
        for k in ("opacity", "fill-opacity", "stroke-opacity"):
            if style.get(k) not in (None, "1"):
                raise SystemExit(f"{svg_file}: {k}={style[k]} (two-tone icons are not supported)")
        tag = el.tag.replace(NS, "")
        if tag in ("svg", "g"):
            for c in el:
                walk(c, style)
            return
        if tag in ("defs", "title", "desc"):
            return
        b = PathBuilder()
        parser = getattr(b, "_parse_" + tag, None)
        if parser is None:
            raise SystemExit(f"{svg_file}: unsupported element <{tag}>")
        if tag == "path":
            b.paths.append(el.get("d"))
        else:
            parser(el)
        fill, stroke = style.get("fill", "#000"), style.get("stroke", "none")
        for paint in (fill, stroke):
            if paint not in ("none", "#000", "#000000", "black"):
                raise SystemExit(f"{svg_file}: colour {paint} (only one colour is supported)")
        for d in b.paths:
            if fill != "none":
                out.append((d, ("fill", style.get("fill-rule", "nonzero"))))
            if stroke != "none":
                out.append((d, ("stroke", float(style.get("stroke-width", "1")),
                                style.get("stroke-linecap", "butt"), style.get("stroke-linejoin", "miter"),
                                float(style.get("stroke-miterlimit", "4")))))

    walk(root, {"fill": root.get("fill", "#000")})
    return out


def outline(svg_file, rotate=0):
    import math
    import pathops
    from fontTools.svgLib.path import parse_path
    caps = {"butt": pathops.LineCap.BUTT_CAP, "round": pathops.LineCap.ROUND_CAP, "square": pathops.LineCap.SQUARE_CAP}
    joins = {"miter": pathops.LineJoin.MITER_JOIN, "round": pathops.LineJoin.ROUND_JOIN, "bevel": pathops.LineJoin.BEVEL_JOIN}
    result = None
    for d, paint in element_paths(svg_file):
        p = pathops.Path()
        parse_path(d, p.getPen())
        if paint[0] == "fill":
            p.fillType = pathops.FillType.EVEN_ODD if paint[1] == "evenodd" else pathops.FillType.WINDING
        else:
            _, width, cap, join, miter = paint
            p.stroke(width, caps[cap], joins[join], miter)
        p.convertConicsToQuads(CONIC_TOLERANCE)
        p.simplify(fix_winding=True, keep_starting_points=False)
        result = p if result is None else pathops.op(result, p, pathops.PathOp.UNION, fix_winding=True, keep_starting_points=False)
    result.convertConicsToQuads(CONIC_TOLERANCE)
    if rotate:
        a = math.radians(rotate)
        c, s = math.cos(a), math.sin(a)
        # about the centre (12, 12)
        result = result.transform(c, s, -s, c, 12 - 12 * c + 12 * s, 12 - 12 * s - 12 * c)
    return result


def num(v):
    s = f"{round(v, DECIMALS):.{DECIMALS}f}".rstrip("0").rstrip(".")
    return "0" if s in ("-0", "") else s


def path_data(path):
    """Absolute M/L/Q/C/Z from Skia's own verbs (conics already split)."""
    import pathops
    letter = {pathops.PathVerb.MOVE: "M", pathops.PathVerb.LINE: "L", pathops.PathVerb.QUAD: "Q",
              pathops.PathVerb.CUBIC: "C", pathops.PathVerb.CLOSE: "Z"}
    out = []
    for verb, pts in path:
        if verb not in letter:
            raise SystemExit(f"unexpected path verb {verb}")
        out.append(letter[verb] + " ".join(f"{num(x)} {num(y)}" for x, y in pts))
    return "".join(out)


def build(data):
    rows = []
    for name, spec in data["icons"].items():
        datas = []
        for v in VARIANTS:
            icon, rotate = source(spec, v)
            f = svg_path(v, icon)
            if not os.path.exists(f):
                raise SystemExit(f"missing {os.path.relpath(f, ROOT)}: run with --fetch")
            datas.append(path_data(outline(f, rotate)))
        rows.append((name, spec, datas))
    return rows


def header(comment, data):
    return (f"{comment} Generated by scripts/gen-icons.py from icons/icons.json (Vuesax / Iconsax,\n"
            f"{comment} MIT, iconsax-react {data['source']['npm']['iconsax-react']}). Do not edit; run the script.\n"
            f"{comment} inputs-sha256: {inputs_hash(data)}\n")


def seal(head, comment, body):
    digest = hashlib.sha256(body.encode()).hexdigest()
    return head + f"{comment} content-sha256: {digest}\n" + body


def render_cs(data, rows):
    lines = ["", "namespace Wecommander.Center.Core;", "",
             "/// <summary>The Vuesax (Iconsax) icons of the app; see App/Icons.cs.</summary>",
             "public enum IconName", "{"]
    for name, spec, _ in rows:
        lines.append(f"    /// <summary>{name}: Iconsax {describe(spec)}</summary>")
        lines.append(f"    {pascal(name)},")
    lines += ["}", "", "/// <summary>Filled outlines in a 24x24 box (absolute M/L/Q/C/Z, nonzero fill).</summary>",
              "public static partial class IconData", "{"]
    for i, v in enumerate(VARIANTS):
        lines.append(f"    private static readonly string[] {pascal(v)}Paths =")
        lines.append("    [")
        for name, _, datas in rows:
            lines.append(f"        \"{datas[i]}\", // {name}")
        lines.append("    ];")
        lines.append("")
    lines += ["    /// <summary>Path data of the icon: Linear, or Bold when active.</summary>",
              "    public static string Path(IconName name, bool active) => (active ? BoldPaths : LinearPaths)[(int)name];",
              "}", ""]
    return "\n".join(lines)


def render_swift(data, rows):
    lines = ["", "/// The Vuesax (Iconsax) icons of the app; see WCIcon.swift.",
             "public enum WCIconName: Int, CaseIterable {"]
    for name, spec, _ in rows:
        lines.append(f"    /// {name}: Iconsax {describe(spec)}")
        lines.append(f"    case {camel(name)}")
    lines += ["}", "", "/// Filled outlines in a 24x24 box (absolute M/L/Q/C/Z, nonzero fill, y down).",
              "public enum IconData {"]
    for i, v in enumerate(VARIANTS):
        lines.append(f"    static let {v}: [String] = [")
        for name, _, datas in rows:
            lines.append(f"        \"{datas[i]}\", // {name}")
        lines.append("    ]")
        lines.append("")
    lines += ["    /// Path data of the icon: Linear, or Bold when active.",
              "    public static func path(_ name: WCIconName, active: Bool) -> String {",
              "        (active ? bold : linear)[name.rawValue]",
              "    }", "}", ""]
    return "\n".join(lines)


def outputs(data, rows):
    return {
        OUT_CS: seal(header("//", data), "//", render_cs(data, rows)),
        OUT_SWIFT: seal(header("//", data), "//", render_swift(data, rows)),
    }


# ---------------------------------------------------------------- check

def check(data):
    problems = []
    for v, n in needed_svgs(data):
        if not os.path.exists(svg_path(v, n)):
            problems.append(f"missing icons/svg/{v}/{n}.svg (run gen-icons.py --fetch)")
    wanted = {f"{v}/{n}.svg" for v, n in needed_svgs(data)}
    for v in VARIANTS:
        d = os.path.join(SVG, v)
        for f in sorted(os.listdir(d)) if os.path.isdir(d) else []:
            if f"{v}/{f}" not in wanted:
                problems.append(f"icons/svg/{v}/{f} is not used by icons.json (run gen-icons.py --fetch)")
    if problems:
        return problems
    want = inputs_hash(data)
    names = list(data["icons"])
    for out, key in ((OUT_CS, "cs"), (OUT_SWIFT, "swift")):
        rel = os.path.relpath(out, ROOT)
        if not os.path.exists(out):
            problems.append(f"{rel} is missing")
            continue
        text = read_text(out)
        m = re.search(r"inputs-sha256: ([0-9a-f]{64})\n.*content-sha256: ([0-9a-f]{64})\n", text)
        if not m:
            problems.append(f"{rel}: no generator header")
            continue
        if m.group(1) != want:
            problems.append(f"{rel} is out of date with icons.json, icons/svg or the generator")
        body = text[m.end():]
        if hashlib.sha256(body.encode()).hexdigest() != m.group(2):
            problems.append(f"{rel} was edited by hand")
        found = re.findall(r"^    (\w+),$", body, re.M) if key == "cs" else re.findall(r"^    case (`?\w+`?)$", body, re.M)
        expect = [pascal(n) for n in names] if key == "cs" else [camel(n) for n in names]
        if found != expect:
            problems.append(f"{rel}: icon names differ from icons.json")
    return problems


# ---------------------------------------------------------------- preview

def preview(data, file):
    from PIL import Image, ImageDraw
    cell, scale = 120, 3
    names = list(data["icons"].items())
    cols = 8
    img = Image.new("L", (cols * cell * 2, ((len(names) + cols - 1) // cols) * cell), 255)
    draw = ImageDraw.Draw(img)
    for i, (name, spec) in enumerate(names):
        for j, v in enumerate(VARIANTS):
            icon, rotate = source(spec, v)
            p = outline(svg_path(v, icon), rotate)
            ox, oy = ((i % cols) * 2 + j) * cell + 12, (i // cols) * cell + 6
            # XOR of the contours: the outlines are simplified (no overlaps),
            # so even-odd equals the nonzero fill the apps use.
            mask = xor_fill(path_data(p), scale * 4)
            mask = mask.resize((24 * scale, 24 * scale), Image.LANCZOS)
            img.paste(0, (ox, oy), mask)
        draw.text(((i % cols) * 2 * cell + 4, (i // cols) * cell + cell - 22), f"{name} ({spec['iconsax']})", fill=0)
    img.save(file)
    print("wrote", file)


def parse_data(d):
    """[(command, [x, y, ...])] of generated path data (what the apps parse)."""
    out = []
    for cmd, args in re.findall(r"([MLQCZ])([^MLQCZ]*)", d):
        out.append((cmd, [float(x) for x in args.split()]))
    return out


def flatten(d, s):
    contours, cur, last = [], [], (0.0, 0.0)
    for cmd, a in parse_data(d):
        pts = list(zip(a[0::2], a[1::2]))
        if cmd == "M":
            if cur:
                contours.append(cur)
            cur, last = [(pts[0][0] * s, pts[0][1] * s)], pts[0]
        elif cmd == "L":
            cur.append((pts[0][0] * s, pts[0][1] * s)); last = pts[0]
        elif cmd in ("Q", "C"):
            ctrl = [last, *pts]
            for k in range(1, 17):
                t = k / 16
                q = ctrl
                while len(q) > 1:
                    q = [(p[0] + (r[0] - p[0]) * t, p[1] + (r[1] - p[1]) * t) for p, r in zip(q, q[1:])]
                cur.append((q[0][0] * s, q[0][1] * s))
            last = pts[-1]
        elif cmd == "Z":
            if cur:
                contours.append(cur)
            cur = []
    if cur:
        contours.append(cur)
    return contours


def xor_fill(d, s):
    from PIL import Image, ImageChops, ImageDraw
    size = 24 * s
    acc = Image.new("1", (size, size), 0)
    for contour in flatten(d, s):
        if len(contour) < 3:
            continue
        m = Image.new("1", (size, size), 0)
        ImageDraw.Draw(m).polygon(contour, fill=1)
        acc = ImageChops.logical_xor(acc, m)
    return acc.convert("L")


# ---------------------------------------------------------------- main

def main(argv):
    data = load_list()
    if "--fetch" in argv:
        fetch(data)
        return 0
    if "--check" in argv:
        problems = check(data)
        for p in problems:
            print("gen-icons:", p)
        if problems:
            print("Run: python3 scripts/gen-icons.py (pip install skia-pathops fonttools)")
            return 1
        print(f"gen-icons: {len(data['icons'])} icons up to date")
        return 0
    if "--preview" in argv:
        preview(data, argv[argv.index("--preview") + 1])
        return 0
    rows = build(data)
    for path, text in outputs(data, rows).items():
        with open(path, "w", encoding="utf-8", newline="\n") as f:
            f.write(text)
        print("wrote", os.path.relpath(path, ROOT))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
