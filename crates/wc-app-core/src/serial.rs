//! Serial port terminals (switches, routers, boards on a console cable):
//! the port is opened with the host's line settings and its bytes go to the
//! terminal unchanged, both ways.

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::mpsc;
use tokio_serial::{DataBits, FlowControl, Parity, SerialPortBuilderExt, SerialStream, StopBits};

use crate::store::SerialSettings;
use crate::stream::{StreamCmd, StreamEvents};

/// The serial ports this computer has (COM3, /dev/cu.usbserial-1410 ...).
pub fn ports() -> Vec<String> {
    let mut names: Vec<String> = tokio_serial::available_ports()
        .map(|ports| ports.into_iter().map(|p| p.port_name).collect())
        .unwrap_or_default();
    names.sort();
    names.dedup();
    names
}

/// Opens the port (the caller reports a failure to the user).
pub fn open(s: &SerialSettings) -> Result<SerialStream, String> {
    let data_bits = match s.data_bits {
        5 => DataBits::Five,
        6 => DataBits::Six,
        7 => DataBits::Seven,
        _ => DataBits::Eight,
    };
    let parity = match s.parity.as_str() {
        "even" => Parity::Even,
        "odd" => Parity::Odd,
        _ => Parity::None,
    };
    let stop_bits = if s.stop_bits == 2 {
        StopBits::Two
    } else {
        StopBits::One
    };
    let flow = match s.flow.as_str() {
        "hardware" => FlowControl::Hardware,
        "software" => FlowControl::Software,
        _ => FlowControl::None,
    };
    tokio_serial::new(&s.device, s.baud)
        .data_bits(data_bits)
        .parity(parity)
        .stop_bits(stop_bits)
        .flow_control(flow)
        .open_native_async()
        .map_err(|e| format!("serial: could not open {}: {e}", s.device))
}

/// Runs a serial terminal until the app closes it or the port goes away.
pub async fn run(
    port: SerialStream,
    mut commands: mpsc::UnboundedReceiver<StreamCmd>,
    events: StreamEvents,
) {
    let (mut reader, mut writer) = tokio::io::split(port);
    let mut buf = vec![0u8; 8 * 1024];
    loop {
        tokio::select! {
            read = reader.read(&mut buf) => match read {
                Ok(0) | Err(_) => break,
                Ok(n) => events.output(&buf[..n]),
            },
            cmd = commands.recv() => match cmd {
                Some(StreamCmd::Data(bytes)) => {
                    if writer.write_all(&bytes).await.is_err() { break; }
                }
                // A serial line has no window size.
                Some(StreamCmd::Resize(..)) => {}
                Some(StreamCmd::Close) | None => break,
            },
        }
    }
    let _ = writer.shutdown().await;
    events.exit(None);
}
