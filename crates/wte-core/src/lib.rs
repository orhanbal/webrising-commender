//! WTE2 step 1 (docs/WTE2_PLAN.md): the terminal core in Rust. Feed it the
//! program's bytes with [`Terminal::advance`], read cells and damaged rows.

pub mod grid;
pub mod parser;
pub mod terminal;

pub use grid::{flags, Cell, Color};
pub use terminal::{Modes, Terminal};

#[cfg(test)]
mod tests;
