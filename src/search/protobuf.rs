use std::io::{Read, Write};

use flate2::{read::GzDecoder, write::GzEncoder, Compression};

use crate::error::YceError;

#[derive(Debug, Default, Clone)]
pub struct ProtobufEncoder {
    bytes: Vec<u8>,
}

impl ProtobufEncoder {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn write_varint(&mut self, field: u32, value: u64) -> &mut Self {
        encode_varint((field as u64) << 3, &mut self.bytes);
        encode_varint(value, &mut self.bytes);
        self
    }

    pub fn write_string(&mut self, field: u32, value: &str) -> &mut Self {
        self.write_bytes(field, value.as_bytes())
    }

    pub fn write_bytes(&mut self, field: u32, value: &[u8]) -> &mut Self {
        encode_varint(((field as u64) << 3) | 2, &mut self.bytes);
        encode_varint(value.len() as u64, &mut self.bytes);
        self.bytes.extend_from_slice(value);
        self
    }

    pub fn write_message(&mut self, field: u32, value: &ProtobufEncoder) -> &mut Self {
        self.write_bytes(field, value.as_bytes())
    }

    pub fn as_bytes(&self) -> &[u8] {
        &self.bytes
    }

    pub fn into_bytes(self) -> Vec<u8> {
        self.bytes
    }
}

pub fn encode_varint(mut value: u64, output: &mut Vec<u8>) {
    while value > 0x7f {
        output.push((value as u8 & 0x7f) | 0x80);
        value >>= 7;
    }
    output.push(value as u8);
}

pub fn decode_varint(data: &[u8], offset: &mut usize) -> Result<u64, YceError> {
    let mut value = 0_u64;
    let mut shift = 0_u32;
    while *offset < data.len() && shift < 64 {
        let byte = data[*offset];
        *offset += 1;
        value |= u64::from(byte & 0x7f) << shift;
        if byte & 0x80 == 0 {
            return Ok(value);
        }
        shift += 7;
    }
    Err(YceError::Internal(
        "远端 Protobuf 含有截断或溢出的 varint。".into(),
    ))
}

pub fn extract_strings(data: &[u8]) -> Vec<String> {
    let mut strings = Vec::new();
    let mut offset = 0;
    while offset < data.len() {
        let Ok(tag) = decode_varint(data, &mut offset) else {
            break;
        };
        match tag & 0x7 {
            0 => {
                if decode_varint(data, &mut offset).is_err() {
                    break;
                }
            }
            1 => {
                let Some(next) = offset.checked_add(8) else {
                    break;
                };
                if next > data.len() {
                    break;
                }
                offset = next;
            }
            2 => {
                let Ok(length) = decode_varint(data, &mut offset) else {
                    break;
                };
                let Ok(length) = usize::try_from(length) else {
                    break;
                };
                let Some(end) = offset.checked_add(length) else {
                    break;
                };
                if end > data.len() {
                    break;
                }
                if let Ok(text) = std::str::from_utf8(&data[offset..end]) {
                    if text.chars().count() > 5 {
                        strings.push(text.to_string());
                    }
                }
                offset = end;
            }
            5 => {
                let Some(next) = offset.checked_add(4) else {
                    break;
                };
                if next > data.len() {
                    break;
                }
                offset = next;
            }
            _ => break,
        }
    }
    strings
}

pub fn encode_connect_frame(proto: &[u8], compress: bool) -> Result<Vec<u8>, YceError> {
    let (flags, payload) = if compress {
        let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
        encoder
            .write_all(proto)
            .map_err(|error| YceError::Internal(format!("gzip 压缩失败：{error}")))?;
        let compressed = encoder
            .finish()
            .map_err(|error| YceError::Internal(format!("gzip 压缩收尾失败：{error}")))?;
        (1_u8, compressed)
    } else {
        (0_u8, proto.to_vec())
    };
    let length = u32::try_from(payload.len())
        .map_err(|_| YceError::Internal("Connect-RPC 请求帧超过 4GiB。".into()))?;
    let mut frame = Vec::with_capacity(5 + payload.len());
    frame.push(flags);
    frame.extend_from_slice(&length.to_be_bytes());
    frame.extend_from_slice(&payload);
    Ok(frame)
}

pub fn decode_connect_frames(data: &[u8]) -> Result<Vec<Vec<u8>>, YceError> {
    let mut frames = Vec::new();
    let mut offset = 0;
    while offset < data.len() {
        if data.len() - offset < 5 {
            return Err(YceError::Internal(
                "Connect-RPC 响应尾部不是完整的 5 字节帧头。".into(),
            ));
        }
        let flags = data[offset];
        let length = u32::from_be_bytes([
            data[offset + 1],
            data[offset + 2],
            data[offset + 3],
            data[offset + 4],
        ]) as usize;
        offset += 5;
        let end = offset
            .checked_add(length)
            .ok_or_else(|| YceError::Internal("Connect-RPC 帧长度溢出。".into()))?;
        if end > data.len() {
            return Err(YceError::Internal(format!(
                "Connect-RPC 响应帧被截断：声明 {length} 字节，实际只剩 {} 字节。",
                data.len() - offset
            )));
        }
        let payload = &data[offset..end];
        offset = end;
        if flags & 1 != 0 {
            let mut decoder = GzDecoder::new(payload);
            let mut decoded = Vec::new();
            decoder.read_to_end(&mut decoded).map_err(|error| {
                YceError::Internal(format!("Connect-RPC gzip 解压失败：{error}"))
            })?;
            frames.push(decoded);
        } else {
            frames.push(payload.to_vec());
        }
    }
    Ok(frames)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn varint_matches_known_values() {
        let mut bytes = Vec::new();
        encode_varint(0, &mut bytes);
        encode_varint(127, &mut bytes);
        encode_varint(128, &mut bytes);
        encode_varint(300, &mut bytes);
        assert_eq!(bytes, [0x00, 0x7f, 0x80, 0x01, 0xac, 0x02]);

        let mut offset = 0;
        assert_eq!(decode_varint(&bytes, &mut offset).unwrap(), 0);
        assert_eq!(decode_varint(&bytes, &mut offset).unwrap(), 127);
        assert_eq!(decode_varint(&bytes, &mut offset).unwrap(), 128);
        assert_eq!(decode_varint(&bytes, &mut offset).unwrap(), 300);
        assert_eq!(offset, bytes.len());
    }

    #[test]
    fn encoder_matches_fixed_wire_bytes() {
        let mut nested = ProtobufEncoder::new();
        nested.write_string(1, "yce");
        let mut outer = ProtobufEncoder::new();
        outer
            .write_varint(2, 5)
            .write_string(3, "hello")
            .write_message(4, &nested);
        assert_eq!(
            outer.into_bytes(),
            [
                0x10, 0x05, 0x1a, 0x05, b'h', b'e', b'l', b'l', b'o', 0x22, 0x05, 0x0a, 0x03, b'y',
                b'c', b'e'
            ]
        );
    }

    #[test]
    fn connect_frame_round_trip_supports_gzip_and_plain_frames() {
        let proto = b"\x0a\x0bhello world";
        for compress in [false, true] {
            let encoded = encode_connect_frame(proto, compress).unwrap();
            let decoded = decode_connect_frames(&encoded).unwrap();
            assert_eq!(decoded, [proto.to_vec()]);
        }
    }

    #[test]
    fn malformed_connect_frame_is_rejected() {
        let error = decode_connect_frames(&[0, 0, 0, 0, 8, 1, 2]).unwrap_err();
        assert!(error.to_string().contains("截断"));
    }

    #[test]
    fn extracts_length_delimited_strings() {
        let mut encoder = ProtobufEncoder::new();
        encoder.write_string(1, "short");
        encoder.write_string(2, "hello world");
        encoder.write_varint(3, 42);
        assert_eq!(extract_strings(encoder.as_bytes()), ["hello world"]);
    }
}
