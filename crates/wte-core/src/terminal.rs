//! The terminal state machine: what each VT sequence does to the grid.
//! Printable ASCII arrives from the parser as whole runs and is copied into
//! the row in one loop; everything else goes through `put`.

use crate::grid::{flags, Cell, Color, Grid};
use crate::parser::{Handler, Params, Parser};
use unicode_width::UnicodeWidthChar;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Pen {
    pub fg: Color,
    pub bg: Color,
    pub flags: u16,
}

#[derive(Clone, Copy, Debug, Default)]
struct Saved {
    x: usize,
    y: usize,
    pen: Pen,
    origin: bool,
}

/// Modes that change how input is written or reported.
#[derive(Clone, Copy, Debug)]
pub struct Modes {
    pub autowrap: bool,
    pub origin: bool,
    pub insert: bool,
    pub cursor_visible: bool,
    pub bracketed_paste: bool,
    pub application_cursor: bool,
    /// Mouse reporting requested by the program (1000/1002/1003, 0 = off).
    pub mouse: u16,
    pub sgr_mouse: bool,
}

impl Default for Modes {
    fn default() -> Self {
        Modes {
            autowrap: true,
            origin: false,
            insert: false,
            cursor_visible: true,
            bracketed_paste: false,
            application_cursor: false,
            mouse: 0,
            sgr_mouse: false,
        }
    }
}

struct State {
    primary: Grid,
    alternate: Grid,
    alt_active: bool,
    x: usize,
    y: usize,
    /// The last column was written; the next printable wraps first (VT100 behaviour).
    wrap_pending: bool,
    pen: Pen,
    saved: Saved,
    saved_primary: Saved,
    top: usize,
    bottom: usize,
    tabs: Vec<bool>,
    modes: Modes,
    title: String,
    /// Visible rows changed since the last `take_damage`.
    damage: Vec<bool>,
    /// Every row changed (full-screen scroll or clear), without touching `damage`.
    all_damaged: bool,
    /// Bytes the terminal must send back (device status, cursor position).
    replies: Vec<u8>,
    last_char: Option<char>,
}

/// A terminal: feed it the program's output, read the screen.
pub struct Terminal {
    parser: Parser,
    s: State,
}

fn default_tabs(cols: usize) -> Vec<bool> {
    (0..cols).map(|i| i % 8 == 0 && i > 0).collect()
}

impl State {
    fn new(cols: usize, rows: usize, scrollback: usize) -> Self {
        State {
            primary: Grid::new(cols, rows, scrollback),
            alternate: Grid::new(cols, rows, 0),
            alt_active: false,
            x: 0,
            y: 0,
            wrap_pending: false,
            pen: Pen::default(),
            saved: Saved::default(),
            saved_primary: Saved::default(),
            top: 0,
            bottom: rows - 1,
            tabs: default_tabs(cols),
            modes: Modes::default(),
            title: String::new(),
            damage: vec![true; rows],
            all_damaged: true,
            replies: Vec::new(),
            last_char: None,
        }
    }
}

impl Terminal {
    pub fn new(cols: usize, rows: usize, scrollback: usize) -> Self {
        Terminal {
            parser: Parser::new(),
            s: State::new(cols.max(1), rows.max(1), scrollback),
        }
    }

    /// Feeds program output.
    pub fn advance(&mut self, bytes: &[u8]) {
        self.parser.advance(&mut self.s, bytes);
    }

    pub fn cols(&self) -> usize {
        self.s.grid().cols
    }

    pub fn rows(&self) -> usize {
        self.s.grid().rows
    }

    /// (column, row) of the cursor, 0-based.
    pub fn cursor(&self) -> (usize, usize) {
        (self.s.x, self.s.y)
    }

    pub fn modes(&self) -> Modes {
        self.s.modes
    }

    pub fn title(&self) -> &str {
        &self.s.title
    }

    pub fn alt_screen(&self) -> bool {
        self.s.alt_active
    }

    pub fn cell(&self, x: usize, y: usize) -> Cell {
        self.s.grid().row(y).get(x)
    }

    pub fn row_text(&self, y: usize) -> String {
        self.s.grid().row(y).text()
    }

    /// The whole screen as text, one line per row, trailing blanks removed.
    pub fn screen_text(&self) -> String {
        (0..self.rows())
            .map(|y| self.row_text(y))
            .collect::<Vec<_>>()
            .join("\n")
    }

    pub fn history_len(&self) -> usize {
        self.s.primary.history_len()
    }

    pub fn history_text(&self, i: usize) -> String {
        self.s.primary.history(i).text()
    }

    /// Rows to redraw since the last call (true = changed).
    pub fn take_damage(&mut self) -> Vec<bool> {
        let rows = self.rows();
        let all = std::mem::take(&mut self.s.all_damaged);
        let damage = std::mem::replace(&mut self.s.damage, vec![false; rows]);
        if all {
            vec![true; rows]
        } else {
            damage
        }
    }

    /// Bytes to write back to the program (answers to status queries).
    pub fn take_replies(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.s.replies)
    }

    pub fn resize(&mut self, cols: usize, rows: usize) {
        let (cols, rows) = (cols.max(1), rows.max(1));
        let s = &mut self.s;
        // When the screen gets shorter, drop empty rows below the cursor
        // first; the rest of the rows above the cursor go into history.
        let old_rows = s.grid().rows;
        if rows < old_rows {
            let below = old_rows - 1 - s.y;
            let dropped = (old_rows - rows).min(below);
            s.grid_mut().pop_bottom(dropped);
            s.y -= old_rows - dropped - rows;
        }
        s.primary.resize(cols, rows);
        s.alternate.resize(cols, rows);
        s.x = s.x.min(cols - 1);
        s.y = s.y.min(rows - 1);
        s.top = 0;
        s.bottom = rows - 1;
        s.tabs = default_tabs(cols);
        s.wrap_pending = false;
        s.damage = vec![true; rows];
        s.all_damaged = true;
    }
}

impl State {
    fn grid(&self) -> &Grid {
        if self.alt_active {
            &self.alternate
        } else {
            &self.primary
        }
    }

    fn grid_mut(&mut self) -> &mut Grid {
        if self.alt_active {
            &mut self.alternate
        } else {
            &mut self.primary
        }
    }

    fn cols(&self) -> usize {
        self.grid().cols
    }

    fn rows(&self) -> usize {
        self.grid().rows
    }

    #[inline]
    fn dirty(&mut self, y: usize) {
        if let Some(d) = self.damage.get_mut(y) {
            *d = true;
        }
    }

    fn dirty_range(&mut self, from: usize, to: usize) {
        if from == 0 && to + 1 >= self.rows() {
            self.all_damaged = true;
            return;
        }
        for y in from..=to.min(self.rows() - 1) {
            self.dirty(y);
        }
    }

    fn blank(&self) -> Cell {
        Cell::blank(self.pen.bg)
    }

    /// Line feed: down one row, scrolling the region at its bottom.
    fn linefeed(&mut self) {
        if self.y == self.bottom {
            let (top, bottom, bg) = (self.top, self.bottom, self.pen.bg);
            self.grid_mut().scroll_up(top, bottom, 1, bg);
            self.dirty_range(top, bottom);
        } else if self.y + 1 < self.rows() {
            self.y += 1;
        }
    }

    fn reverse_index(&mut self) {
        if self.y == self.top {
            let (top, bottom, bg) = (self.top, self.bottom, self.pen.bg);
            self.grid_mut().scroll_down(top, bottom, 1, bg);
            self.dirty_range(top, bottom);
        } else if self.y > 0 {
            self.y -= 1;
        }
    }

    /// Wraps to the next line if the last column was written.
    fn wrap_if_pending(&mut self) {
        if self.wrap_pending {
            if self.modes.autowrap {
                let y = self.y;
                self.grid_mut().row_mut(y).wrapped = true;
                self.x = 0;
                self.linefeed();
            }
            self.wrap_pending = false;
        }
    }

    fn put(&mut self, c: char) {
        let cols = self.cols();
        let mut width = c.width().unwrap_or(0);
        if width == 0 {
            // Combining marks and zero-width characters: cells hold one char,
            // so they are dropped; shaping (step 3) brings grapheme clusters.
            return;
        }
        if width == 2 && cols < 2 {
            width = 1;
        }
        self.wrap_if_pending();
        if width == 2 && self.x + 1 >= cols {
            // A wide character does not fit at the end: wrap it whole.
            if self.modes.autowrap {
                let y = self.y;
                self.grid_mut().row_mut(y).wrapped = true;
                self.x = 0;
                self.linefeed();
            } else {
                self.x = cols - 2;
            }
        }
        let (x, y, pen) = (self.x, self.y, self.pen);
        if self.modes.insert {
            let blank = self.blank();
            let row = self.grid_mut().row_mut(y).ensure(cols);
            row[x..].rotate_right(width);
            row[x..x + width].fill(blank);
        }
        let row = self.grid_mut().row_mut(y).ensure((x + width + 1).min(cols));
        // Overwriting half of a wide character clears its other half.
        if x > 0 && row[x].flags & flags::WIDE_SPACER != 0 {
            row[x - 1] = Cell::blank(row[x - 1].bg);
        }
        let last = x + width - 1;
        if row[last].flags & flags::WIDE != 0 && last + 1 < cols {
            row[last + 1] = Cell::blank(row[last + 1].bg);
        }
        let wide = if width == 2 { flags::WIDE } else { 0 };
        row[x] = Cell {
            c,
            fg: pen.fg,
            bg: pen.bg,
            flags: pen.flags | wide,
        };
        if width == 2 {
            row[x + 1] = Cell {
                c: ' ',
                fg: pen.fg,
                bg: pen.bg,
                flags: pen.flags | flags::WIDE_SPACER,
            };
        }
        self.dirty(y);
        self.last_char = Some(c);
        if x + width >= cols {
            self.x = cols - 1;
            self.wrap_pending = true;
        } else {
            self.x = x + width;
        }
    }

    /// Printable ASCII run: copied straight into the row.
    fn put_ascii(&mut self, run: &[u8]) {
        if self.modes.insert || !self.modes.autowrap {
            run.iter().for_each(|&b| self.put(b as char));
            return;
        }
        let pen = self.pen;
        let mut i = 0;
        while i < run.len() {
            self.wrap_if_pending();
            let cols = self.cols();
            let (x, y) = (self.x, self.y);
            let n = (cols - x).min(run.len() - i);
            let row = self.grid_mut().row_mut(y).ensure((x + n + 1).min(cols));
            if x > 0 && row[x].flags & flags::WIDE_SPACER != 0 {
                row[x - 1] = Cell::blank(row[x - 1].bg);
            }
            let end_wide = row[x + n - 1].flags & flags::WIDE != 0;
            for (cell, &b) in row[x..x + n].iter_mut().zip(&run[i..i + n]) {
                *cell = Cell {
                    c: b as char,
                    fg: pen.fg,
                    bg: pen.bg,
                    flags: pen.flags,
                };
            }
            if end_wide && x + n < cols {
                row[x + n] = Cell::blank(row[x + n].bg);
            }
            self.dirty(y);
            if x + n >= cols {
                self.x = cols - 1;
                self.wrap_pending = true;
            } else {
                self.x = x + n;
            }
            i += n;
        }
        self.last_char = run.last().map(|&b| b as char);
    }

    fn erase_cells(&mut self, y: usize, from: usize, to: usize) {
        let (blank, cols) = (self.blank(), self.cols());
        let (from, to) = (from.min(cols), to.min(cols));
        let row = self.grid_mut().row_mut(y);
        if to == cols {
            row.clear_from(from, blank.bg);
        } else if from < to {
            row.ensure(to)[from..to].fill(blank);
        }
        self.dirty(y);
    }

    fn erase_rows(&mut self, from: usize, to: usize) {
        let (bg, cols) = (self.pen.bg, self.cols());
        let to = to.min(self.rows());
        for y in from..to {
            self.grid_mut().row_mut(y).reset(cols, bg);
        }
        if to > from {
            self.dirty_range(from, to - 1);
        }
    }

    fn goto(&mut self, x: usize, y: usize) {
        let (min_y, max_y) = if self.modes.origin {
            (self.top, self.bottom)
        } else {
            (0, self.rows() - 1)
        };
        self.x = x.min(self.cols() - 1);
        self.y = (y + min_y).clamp(min_y, max_y);
        self.wrap_pending = false;
    }

    fn save_cursor(&mut self) {
        self.saved = Saved {
            x: self.x,
            y: self.y,
            pen: self.pen,
            origin: self.modes.origin,
        };
    }

    fn restore_cursor(&mut self) {
        let s = self.saved;
        self.x = s.x.min(self.cols() - 1);
        self.y = s.y.min(self.rows() - 1);
        self.pen = s.pen;
        self.modes.origin = s.origin;
        self.wrap_pending = false;
    }

    fn set_alt_screen(&mut self, on: bool, save_cursor: bool) {
        if on == self.alt_active {
            return;
        }
        if on {
            if save_cursor {
                self.saved_primary = Saved {
                    x: self.x,
                    y: self.y,
                    pen: self.pen,
                    origin: self.modes.origin,
                };
            }
            self.alt_active = true;
            let rows = self.rows();
            self.erase_rows(0, rows);
        } else {
            self.alt_active = false;
            if save_cursor {
                let s = self.saved_primary;
                self.x = s.x.min(self.cols() - 1);
                self.y = s.y.min(self.rows() - 1);
                self.pen = s.pen;
            }
        }
        self.wrap_pending = false;
        self.all_damaged = true;
    }

    fn set_mode(&mut self, private: bool, mode: u16, on: bool) {
        if !private {
            if mode == 4 {
                self.modes.insert = on;
            }
            return;
        }
        match mode {
            1 => self.modes.application_cursor = on,
            6 => {
                self.modes.origin = on;
                self.goto(0, 0);
            }
            7 => self.modes.autowrap = on,
            25 => self.modes.cursor_visible = on,
            47 | 1047 => self.set_alt_screen(on, false),
            1048 => {
                if on {
                    self.save_cursor()
                } else {
                    self.restore_cursor()
                }
            }
            1049 => self.set_alt_screen(on, true),
            1000 | 1002 | 1003 => self.modes.mouse = if on { mode } else { 0 },
            1006 => self.modes.sgr_mouse = on,
            2004 => self.modes.bracketed_paste = on,
            _ => {}
        }
    }

    fn sgr(&mut self, params: &Params) {
        if params.is_empty() {
            self.pen = Pen::default();
            return;
        }
        let mut it = params.groups();
        while let Some(p) = it.next() {
            let code = p[0];
            match code {
                0 => self.pen = Pen::default(),
                1 => self.pen.flags |= flags::BOLD,
                2 => self.pen.flags |= flags::DIM,
                3 => self.pen.flags |= flags::ITALIC,
                4 => self.pen.flags |= flags::UNDERLINE,
                5 | 6 => self.pen.flags |= flags::BLINK,
                7 => self.pen.flags |= flags::INVERSE,
                8 => self.pen.flags |= flags::HIDDEN,
                9 => self.pen.flags |= flags::STRIKE,
                21 | 24 => self.pen.flags &= !flags::UNDERLINE,
                22 => self.pen.flags &= !(flags::BOLD | flags::DIM),
                23 => self.pen.flags &= !flags::ITALIC,
                25 => self.pen.flags &= !flags::BLINK,
                27 => self.pen.flags &= !flags::INVERSE,
                28 => self.pen.flags &= !flags::HIDDEN,
                29 => self.pen.flags &= !flags::STRIKE,
                30..=37 => self.pen.fg = Color::Indexed((code - 30) as u8),
                39 => self.pen.fg = Color::Default,
                40..=47 => self.pen.bg = Color::Indexed((code - 40) as u8),
                49 => self.pen.bg = Color::Default,
                90..=97 => self.pen.fg = Color::Indexed((code - 90 + 8) as u8),
                100..=107 => self.pen.bg = Color::Indexed((code - 100 + 8) as u8),
                38 | 48 => {
                    // Both "38;5;n" (separate parameters) and "38:5:n" (sub-parameters).
                    let color = if p.len() > 1 {
                        extended_color(&p[1..])
                    } else {
                        match it.next().map(|v| v[0]) {
                            Some(5) => it.next().map(|v| Color::Indexed(v[0] as u8)),
                            Some(2) => {
                                let r = it.next().map(|v| v[0] as u8);
                                let g = it.next().map(|v| v[0] as u8);
                                let b = it.next().map(|v| v[0] as u8);
                                match (r, g, b) {
                                    (Some(r), Some(g), Some(b)) => Some(Color::Rgb(r, g, b)),
                                    _ => None,
                                }
                            }
                            _ => None,
                        }
                    };
                    if let Some(color) = color {
                        if code == 38 {
                            self.pen.fg = color
                        } else {
                            self.pen.bg = color
                        }
                    }
                }
                _ => {}
            }
        }
    }
}

fn extended_color(sub: &[u16]) -> Option<Color> {
    match sub {
        [5, n, ..] => Some(Color::Indexed(*n as u8)),
        // "2:r:g:b" or "2:colorspace:r:g:b"
        [2, r, g, b] => Some(Color::Rgb(*r as u8, *g as u8, *b as u8)),
        [2, _, r, g, b, ..] => Some(Color::Rgb(*r as u8, *g as u8, *b as u8)),
        _ => None,
    }
}

/// Parameter `i`, with 0 or missing meaning `default`.
fn arg(params: &Params, i: usize, default: usize) -> usize {
    match params.get(i) {
        None | Some(0) => default,
        Some(v) => v as usize,
    }
}

impl Handler for State {
    fn print_ascii(&mut self, run: &[u8]) {
        self.put_ascii(run);
    }

    fn print(&mut self, c: char) {
        self.put(c);
    }

    fn execute(&mut self, byte: u8) {
        match byte {
            b'\r' => {
                self.x = 0;
                self.wrap_pending = false;
            }
            b'\n' | 0x0b | 0x0c => {
                self.linefeed();
                self.wrap_pending = false;
            }
            0x08 => {
                self.x = self.x.saturating_sub(1);
                self.wrap_pending = false;
            }
            b'\t' => {
                let cols = self.cols();
                let mut x = self.x + 1;
                while x < cols - 1 && !self.tabs[x] {
                    x += 1;
                }
                self.x = x.min(cols - 1);
                self.wrap_pending = false;
            }
            _ => {}
        }
    }

    fn csi(&mut self, params: &Params, intermediates: &[u8], action: u8) {
        let private = intermediates.first() == Some(&b'?');
        if !private && !intermediates.is_empty() {
            return; // CSI > c, CSI SP q and friends: not handled yet
        }
        let rows = self.rows();
        let cols = self.cols();
        match (action, private) {
            (b'm', false) => self.sgr(params),
            (b'H', false) | (b'f', false) => {
                self.goto(arg(params, 1, 1) - 1, arg(params, 0, 1) - 1)
            }
            (b'A', false) => {
                let min = if self.y >= self.top { self.top } else { 0 };
                self.y = self.y.saturating_sub(arg(params, 0, 1)).max(min);
                self.wrap_pending = false;
            }
            (b'B', false) | (b'e', false) => {
                let max = if self.y <= self.bottom {
                    self.bottom
                } else {
                    rows - 1
                };
                self.y = (self.y + arg(params, 0, 1)).min(max);
                self.wrap_pending = false;
            }
            (b'C', false) | (b'a', false) => {
                self.x = (self.x + arg(params, 0, 1)).min(cols - 1);
                self.wrap_pending = false;
            }
            (b'D', false) => {
                self.x = self.x.saturating_sub(arg(params, 0, 1));
                self.wrap_pending = false;
            }
            (b'E', false) => {
                self.y = (self.y + arg(params, 0, 1)).min(rows - 1);
                self.x = 0;
                self.wrap_pending = false;
            }
            (b'F', false) => {
                self.y = self.y.saturating_sub(arg(params, 0, 1));
                self.x = 0;
                self.wrap_pending = false;
            }
            (b'G', false) | (b'`', false) => {
                self.x = (arg(params, 0, 1) - 1).min(cols - 1);
                self.wrap_pending = false;
            }
            (b'd', false) => {
                let x = self.x;
                self.goto(x, arg(params, 0, 1) - 1);
            }
            (b'J', _) => {
                let (x, y) = (self.x, self.y);
                match arg(params, 0, 0) {
                    0 => {
                        self.erase_cells(y, x, cols);
                        self.erase_rows(y + 1, rows);
                    }
                    1 => {
                        self.erase_rows(0, y);
                        self.erase_cells(y, 0, x + 1);
                    }
                    2 => self.erase_rows(0, rows),
                    3 if !self.alt_active => self.primary.clear_history(),
                    _ => {}
                }
            }
            (b'K', _) => {
                let (x, y) = (self.x, self.y);
                match arg(params, 0, 0) {
                    0 => self.erase_cells(y, x, cols),
                    1 => self.erase_cells(y, 0, x + 1),
                    2 => self.erase_cells(y, 0, cols),
                    _ => {}
                }
            }
            (b'X', false) => {
                let (x, y) = (self.x, self.y);
                let n = arg(params, 0, 1);
                self.erase_cells(y, x, x.saturating_add(n));
            }
            (b'@', false) => {
                let (x, y, blank) = (self.x, self.y, self.blank());
                let n = arg(params, 0, 1).min(cols - x);
                let row = self.grid_mut().row_mut(y).ensure(cols);
                row[x..].rotate_right(n);
                row[x..x + n].fill(blank);
                self.dirty(y);
            }
            (b'P', false) => {
                let (x, y, blank) = (self.x, self.y, self.blank());
                let n = arg(params, 0, 1).min(cols - x);
                let row = self.grid_mut().row_mut(y).ensure(cols);
                row[x..].rotate_left(n);
                row[cols - n..].fill(blank);
                self.dirty(y);
            }
            (b'L', false) | (b'M', false) => {
                if self.y < self.top || self.y > self.bottom {
                    return;
                }
                let (y, bottom, bg) = (self.y, self.bottom, self.pen.bg);
                let n = arg(params, 0, 1);
                if action == b'L' {
                    self.grid_mut().scroll_down(y, bottom, n, bg);
                } else {
                    self.grid_mut().scroll_up(y, bottom, n, bg);
                }
                self.x = 0;
                self.dirty_range(y, bottom);
            }
            (b'S', false) => {
                let (top, bottom, bg) = (self.top, self.bottom, self.pen.bg);
                self.grid_mut()
                    .scroll_up(top, bottom, arg(params, 0, 1), bg);
                self.dirty_range(top, bottom);
            }
            (b'T', false) => {
                let (top, bottom, bg) = (self.top, self.bottom, self.pen.bg);
                self.grid_mut()
                    .scroll_down(top, bottom, arg(params, 0, 1), bg);
                self.dirty_range(top, bottom);
            }
            (b'r', false) => {
                let top = arg(params, 0, 1) - 1;
                let bottom = arg(params, 1, rows) - 1;
                if top < bottom && bottom < rows {
                    self.top = top;
                    self.bottom = bottom;
                    self.goto(0, 0);
                }
            }
            (b'b', false) => {
                if let Some(c) = self.last_char {
                    for _ in 0..arg(params, 0, 1).min(cols * rows) {
                        self.put(c);
                    }
                }
            }
            (b'g', false) => match arg(params, 0, 0) {
                0 => {
                    let x = self.x;
                    self.tabs[x] = false;
                }
                3 => self.tabs.iter_mut().for_each(|t| *t = false),
                _ => {}
            },
            (b'h', p) | (b'l', p) => {
                for param in params.groups() {
                    self.set_mode(p, param[0], action == b'h');
                }
            }
            (b's', false) => self.save_cursor(),
            (b'u', false) => self.restore_cursor(),
            (b'n', false) => match arg(params, 0, 0) {
                5 => self.replies.extend_from_slice(b"\x1b[0n"),
                6 => {
                    let reply = format!("\x1b[{};{}R", self.y + 1, self.x + 1);
                    self.replies.extend_from_slice(reply.as_bytes());
                }
                _ => {}
            },
            (b'c', false) => self.replies.extend_from_slice(b"\x1b[?62;22c"),
            _ => {}
        }
    }

    fn esc(&mut self, intermediates: &[u8], byte: u8) {
        match (intermediates, byte) {
            ([], b'7') => self.save_cursor(),
            ([], b'8') => self.restore_cursor(),
            ([], b'D') => self.linefeed(),
            ([], b'E') => {
                self.x = 0;
                self.linefeed();
            }
            ([], b'M') => self.reverse_index(),
            ([], b'H') => {
                let x = self.x;
                self.tabs[x] = true;
            }
            ([], b'c') => {
                let (cols, rows, scrollback) = (self.cols(), self.rows(), self.primary.scrollback);
                *self = State::new(cols, rows, scrollback);
            }
            ([b'#'], b'8') => {
                // DECALN: fill the screen with E (alignment test).
                let (cols, rows) = (self.cols(), self.rows());
                for y in 0..rows {
                    self.grid_mut().row_mut(y).ensure(cols).fill(Cell {
                        c: 'E',
                        ..Cell::default()
                    });
                }
                self.all_damaged = true;
            }
            _ => {}
        }
    }

    fn osc(&mut self, data: &[u8]) {
        let mut parts = data.splitn(2, |&b| b == b';');
        if let (Some(kind), Some(text)) = (parts.next(), parts.next()) {
            if kind == b"0" || kind == b"2" {
                self.title = String::from_utf8_lossy(text).chars().take(256).collect();
            }
        }
    }
}
