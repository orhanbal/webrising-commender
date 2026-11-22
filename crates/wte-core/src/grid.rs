//! Cells, rows and the screen buffer. Scrolling the whole screen moves a ring
//! buffer index: no row is copied, which is what makes `yes` fast.

use std::collections::VecDeque;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum Color {
    #[default]
    Default,
    /// 0..=255: the 16 ANSI colours and the 256-colour cube.
    Indexed(u8),
    Rgb(u8, u8, u8),
}

pub mod flags {
    pub const BOLD: u16 = 1;
    pub const DIM: u16 = 1 << 1;
    pub const ITALIC: u16 = 1 << 2;
    pub const UNDERLINE: u16 = 1 << 3;
    pub const BLINK: u16 = 1 << 4;
    pub const INVERSE: u16 = 1 << 5;
    pub const HIDDEN: u16 = 1 << 6;
    pub const STRIKE: u16 = 1 << 7;
    /// First half of a double-width character.
    pub const WIDE: u16 = 1 << 8;
    /// Second half of a double-width character (holds no character).
    pub const WIDE_SPACER: u16 = 1 << 9;
    /// Attributes the pen carries into new cells.
    pub const PEN: u16 = BOLD | DIM | ITALIC | UNDERLINE | BLINK | INVERSE | HIDDEN | STRIKE;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Cell {
    pub c: char,
    pub fg: Color,
    pub bg: Color,
    pub flags: u16,
}

impl Default for Cell {
    fn default() -> Self {
        Cell {
            c: ' ',
            fg: Color::Default,
            bg: Color::Default,
            flags: 0,
        }
    }
}

impl Cell {
    /// An empty cell with the pen's background (erase uses the current background).
    pub fn blank(bg: Color) -> Self {
        Cell {
            bg,
            ..Cell::default()
        }
    }
}

/// One row. Only the written prefix is stored; the cells after it are blank
/// with the `fill` background, so clearing a row is O(1).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Row {
    cells: Vec<Cell>,
    fill: Color,
    /// The line continues on the next row (soft wrap), for copy and reflow.
    pub wrapped: bool,
}

impl Row {
    pub fn new(_cols: usize, bg: Color) -> Self {
        Row {
            cells: Vec::new(),
            fill: bg,
            wrapped: false,
        }
    }

    pub fn reset(&mut self, _cols: usize, bg: Color) {
        self.cells.clear();
        self.fill = bg;
        self.wrapped = false;
    }

    #[inline]
    pub fn get(&self, x: usize) -> Cell {
        self.cells.get(x).copied().unwrap_or(Cell::blank(self.fill))
    }

    /// Stores at least `len` cells, so `cells_mut()[..len]` can be written.
    #[inline]
    pub fn ensure(&mut self, len: usize) -> &mut [Cell] {
        if self.cells.len() < len {
            self.cells.resize(len, Cell::blank(self.fill));
        }
        &mut self.cells
    }

    /// Blanks everything from column `x` to the end with background `bg`.
    pub fn clear_from(&mut self, x: usize, bg: Color) {
        if bg != self.fill && x > self.cells.len() {
            self.ensure(x);
        }
        self.cells.truncate(x);
        self.fill = bg;
    }

    /// Cuts stored cells beyond `cols` (after a resize).
    pub fn truncate(&mut self, cols: usize) {
        self.cells.truncate(cols);
    }

    pub fn text(&self) -> String {
        let s: String = self
            .cells
            .iter()
            .filter(|c| c.flags & flags::WIDE_SPACER == 0)
            .map(|c| c.c)
            .collect();
        s.trim_end().to_string()
    }
}

/// Visible rows plus scrollback. The last `rows` entries are the screen.
pub struct Grid {
    pub cols: usize,
    pub rows: usize,
    pub scrollback: usize,
    lines: VecDeque<Row>,
}

impl Grid {
    pub fn new(cols: usize, rows: usize, scrollback: usize) -> Self {
        let mut lines = VecDeque::with_capacity(rows + scrollback);
        for _ in 0..rows {
            lines.push_back(Row::new(cols, Color::Default));
        }
        Grid {
            cols,
            rows,
            scrollback,
            lines,
        }
    }

    fn top(&self) -> usize {
        self.lines.len() - self.rows
    }

    pub fn row(&self, y: usize) -> &Row {
        &self.lines[self.top() + y]
    }

    pub fn row_mut(&mut self, y: usize) -> &mut Row {
        let top = self.top();
        &mut self.lines[top + y]
    }

    /// Lines that scrolled off the top, oldest first.
    pub fn history_len(&self) -> usize {
        self.top()
    }

    pub fn history(&self, i: usize) -> &Row {
        &self.lines[i]
    }

    /// Scrolls rows `top..=bottom` up by `n`. With the full screen and
    /// scrollback, the top rows go into history in O(1) each.
    pub fn scroll_up(&mut self, top: usize, bottom: usize, n: usize, bg: Color) {
        let n = n.min(bottom + 1 - top);
        if top == 0 && bottom + 1 == self.rows && self.scrollback > 0 {
            for _ in 0..n {
                let row = if self.lines.len() >= self.rows + self.scrollback {
                    let mut r = self.lines.pop_front().expect("rows");
                    r.reset(self.cols, bg);
                    r
                } else {
                    Row::new(self.cols, bg)
                };
                self.lines.push_back(row);
            }
            return;
        }
        let base = self.top();
        for _ in 0..n {
            let mut r = self.lines.remove(base + top).expect("row");
            r.reset(self.cols, bg);
            self.lines.insert(base + bottom, r);
        }
    }

    /// Scrolls rows `top..=bottom` down by `n` (new blank rows at `top`).
    pub fn scroll_down(&mut self, top: usize, bottom: usize, n: usize, bg: Color) {
        let n = n.min(bottom + 1 - top);
        let base = self.top();
        for _ in 0..n {
            let mut r = self.lines.remove(base + bottom).expect("row");
            r.reset(self.cols, bg);
            self.lines.insert(base + top, r);
        }
    }

    /// Removes `n` rows from the bottom of the screen (shrinking it).
    pub fn pop_bottom(&mut self, n: usize) {
        for _ in 0..n.min(self.rows - 1) {
            self.lines.pop_back();
            self.rows -= 1;
        }
    }

    pub fn clear_history(&mut self) {
        let top = self.top();
        self.lines.drain(..top);
    }

    /// New size: rows are cut or padded on the right (no reflow yet); when the
    /// screen shrinks, the top rows go into history.
    pub fn resize(&mut self, cols: usize, rows: usize) {
        for r in self.lines.iter_mut() {
            r.truncate(cols);
        }
        self.cols = cols;
        if rows > self.rows {
            for _ in self.rows..rows {
                self.lines.push_back(Row::new(cols, Color::Default));
            }
        }
        self.rows = rows;
        while self.lines.len() > self.rows + self.scrollback {
            self.lines.pop_front();
        }
    }
}
