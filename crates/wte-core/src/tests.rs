use crate::{flags, Color, Terminal};

fn term(cols: usize, rows: usize, input: &str) -> Terminal {
    let mut t = Terminal::new(cols, rows, 100);
    t.advance(input.as_bytes());
    t
}

#[test]
fn prints_and_moves_on_cr_lf() {
    let t = term(10, 3, "ab\r\ncd");
    assert_eq!(t.screen_text(), "ab\ncd\n");
    assert_eq!(t.cursor(), (2, 1));
}

#[test]
fn wraps_at_the_last_column_only_when_the_next_char_arrives() {
    let mut t = term(4, 3, "abcd");
    assert_eq!(t.cursor(), (3, 0), "cursor stays on the last column");
    t.advance(b"e");
    assert_eq!(t.screen_text(), "abcd\ne\n");
    let t = term(4, 3, "abcd\r\nx");
    assert_eq!(
        t.screen_text(),
        "abcd\nx\n",
        "CR LF after a full line does not add a blank line"
    );
}

#[test]
fn scrolling_moves_lines_into_history() {
    let t = term(10, 2, "1\r\n2\r\n3\r\n4");
    assert_eq!(t.screen_text(), "3\n4");
    assert_eq!(t.history_len(), 2);
    assert_eq!(t.history_text(0), "1");
    assert_eq!(t.history_text(1), "2");
}

#[test]
fn history_is_capped() {
    let mut t = Terminal::new(5, 2, 3);
    for i in 0..20 {
        t.advance(format!("{i}\r\n").as_bytes());
    }
    assert_eq!(t.history_len(), 3);
    assert_eq!(t.history_text(2), "18");
}

#[test]
fn cursor_position_and_erase() {
    let mut t = term(10, 3, "hello\r\nworld\r\nagain");
    t.advance(b"\x1b[2;3H\x1b[K");
    assert_eq!(t.screen_text(), "hello\nwo\nagain");
    t.advance(b"\x1b[2J");
    assert_eq!(t.screen_text(), "\n\n");
    assert_eq!(t.cursor(), (2, 1), "erase does not move the cursor");
}

#[test]
fn sgr_colours_in_every_form() {
    let t = term(
        20,
        1,
        "\x1b[1;31ma\x1b[38;5;200mb\x1b[38;2;1;2;3mc\x1b[38:2::4:5:6md\x1b[0me",
    );
    assert_eq!(t.cell(0, 0).fg, Color::Indexed(1));
    assert!(t.cell(0, 0).flags & flags::BOLD != 0);
    assert_eq!(t.cell(1, 0).fg, Color::Indexed(200));
    assert_eq!(t.cell(2, 0).fg, Color::Rgb(1, 2, 3));
    assert_eq!(t.cell(3, 0).fg, Color::Rgb(4, 5, 6));
    assert_eq!(t.cell(4, 0).fg, Color::Default);
    assert_eq!(t.cell(4, 0).flags, 0);
}

#[test]
fn erase_uses_the_current_background() {
    let t = term(5, 1, "\x1b[44m\x1b[2K");
    assert_eq!(t.cell(4, 0).bg, Color::Indexed(4));
}

#[test]
fn wide_characters_take_two_cells_and_wrap_whole() {
    let t = term(5, 2, "ab日本");
    assert_eq!(t.row_text(0), "ab日");
    assert_eq!(t.row_text(1), "本");
    assert!(t.cell(2, 0).flags & flags::WIDE != 0);
    assert!(t.cell(3, 0).flags & flags::WIDE_SPACER != 0);
    let t = term(6, 1, "ğüşıöç");
    assert_eq!(t.row_text(0), "ğüşıöç");
}

#[test]
fn scroll_region_keeps_lines_outside() {
    let t = term(10, 4, "top\r\n\x1b[2;3r\x1b[2;1Ha\r\nb\r\nc\x1b[4;1Hbottom");
    assert_eq!(t.screen_text(), "top\nb\nc\nbottom");
    assert_eq!(t.history_len(), 0, "a region scroll does not fill history");
}

#[test]
fn insert_and_delete_lines_and_chars() {
    let mut t = term(10, 3, "1\r\n2\r\n3\x1b[2;1H\x1b[L");
    assert_eq!(t.screen_text(), "1\n\n2");
    t.advance(b"\x1b[M");
    assert_eq!(t.screen_text(), "1\n2\n");
    let mut t = term(10, 1, "abcdef\x1b[1;3H\x1b[2P");
    assert_eq!(t.row_text(0), "abef");
    t.advance(b"\x1b[2@XY");
    assert_eq!(t.row_text(0), "abXYef");
}

#[test]
fn alternate_screen_restores_the_primary() {
    let mut t = term(10, 2, "shell$ ");
    t.advance(b"\x1b[?1049h\x1b[Hvim");
    assert!(t.alt_screen());
    assert_eq!(t.screen_text(), "vim\n");
    t.advance(b"\x1b[?1049l");
    assert!(!t.alt_screen());
    assert_eq!(t.screen_text(), "shell$\n");
    assert_eq!(t.cursor(), (7, 0));
}

#[test]
fn tabs_reverse_index_and_save_restore() {
    let t = term(20, 2, "a\tb");
    assert_eq!(t.cursor(), (9, 0));
    let t = term(10, 2, "x\x1bM\x1bM\ry");
    assert_eq!(
        t.screen_text(),
        "y\n",
        "reverse index at the top scrolls down"
    );
    let t = term(10, 2, "ab\x1b7\x1b[2;5Hc\x1b8d");
    assert_eq!(t.screen_text(), "abd\n    c");
}

#[test]
fn modes_title_and_replies() {
    let mut t = term(
        10,
        2,
        "\x1b[?25l\x1b[?2004h\x1b]0;my title\x07\x1b[2;4H\x1b[6n",
    );
    assert!(!t.modes().cursor_visible);
    assert!(t.modes().bracketed_paste);
    assert_eq!(t.title(), "my title");
    assert_eq!(t.take_replies(), b"\x1b[2;4R");
}

#[test]
fn damage_marks_only_changed_rows() {
    let mut t = Terminal::new(10, 4, 10);
    t.take_damage();
    t.advance(b"\x1b[3;1Hx");
    assert_eq!(t.take_damage(), vec![false, false, true, false]);
    assert_eq!(t.take_damage(), vec![false; 4]);
}

#[test]
fn resize_keeps_the_cursor_row_on_screen() {
    let mut t = term(10, 4, "1\r\n2\r\n3\r\n4");
    t.resize(8, 2);
    assert_eq!(t.screen_text(), "3\n4");
    assert_eq!(t.cursor(), (1, 1));
    assert_eq!(t.history_len(), 2);
}

#[test]
fn split_sequences_across_chunks() {
    let mut t = Terminal::new(10, 1, 0);
    for b in "\x1b[3".bytes().chain("1mğ".bytes()) {
        t.advance(&[b]);
    }
    assert_eq!(t.row_text(0), "ğ");
    assert_eq!(t.cell(0, 0).fg, Color::Indexed(1));
}

#[test]
fn every_workload_survives_without_panicking() {
    // Hostile input: random bytes must never panic or leave the cursor off screen.
    let mut seed = 0x1234_5678u64;
    let mut t = Terminal::new(80, 24, 100);
    for _ in 0..200 {
        let mut chunk = Vec::with_capacity(512);
        for _ in 0..512 {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            chunk.push(if seed.is_multiple_of(5) {
                0x1b
            } else {
                (seed >> 8) as u8
            });
        }
        t.advance(&chunk);
        let (x, y) = t.cursor();
        assert!(x < 80 && y < 24);
    }
    t.resize(1, 1);
    t.advance(b"\x1b[999;999H\x1b[999@\x1b[999P\x1b[999L\x1b[999M\x1b[999b\x1b[5;2r\xe6\x97\xa5");
    t.resize(30, 5);
}
