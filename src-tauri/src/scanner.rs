use std::fs;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

use id3::TagLike;
use super::concurrency::ConcurrencyGate;
use super::{TrackMetadata, ScanResult};

const SUPPORTED_EXTENSIONS: &[&str] = &[
    "mp3", "flac", "m4a", "aac", "ogg", "opus", "wav", "wma", "aiff",
];

pub struct LibraryScanner {
    last_result: Option<Vec<TrackMetadata>>,
}

impl LibraryScanner {
    pub fn new() -> Self {
        Self { last_result: None }
    }

    pub fn scan(
        &mut self,
        root_path: &str,
        gate: &ConcurrencyGate,
    ) -> Result<ScanResult, Box<dyn std::error::Error>> {
        let root = Path::new(root_path);
        if !root.is_dir() {
            return Err(format!("Path is not a directory: {}", root_path).into());
        }

        let file_paths: Vec<PathBuf> = WalkDir::new(root)
            .follow_links(false)
            .into_iter()
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.file_type().is_file())
            .filter(|entry| {
                entry
                    .path()
                    .extension()
                    .and_then(|ext| ext.to_str())
                    .map(|ext| SUPPORTED_EXTENSIONS.contains(&ext.to_lowercase().as_str()))
                    .unwrap_or(false)
            })
            .map(|entry| entry.path().to_path_buf())
            .collect();

        let total = file_paths.len();
        let mut tracks: Vec<TrackMetadata> = Vec::with_capacity(total);
        let mut errors: Vec<String> = Vec::new();

        for chunk in file_paths.chunks(gate.max_concurrent) {
            let results: Vec<_> = chunk
                .iter()
                .map(|path| {
                    let p = path.clone();
                    let _permit = gate.acquire();
                    parse_metadata(&p.to_string_lossy())
                })
                .collect();

            for res in results {
                match res {
                    Ok(metadata) => tracks.push(metadata),
                    Err(e) => errors.push(e),
                }
            }
        }

        self.last_result = Some(tracks.clone());
        Ok(ScanResult { tracks, errors })
    }

    pub fn last_result(&self) -> Option<&Vec<TrackMetadata>> {
        self.last_result.as_ref()
    }
}

// ─── Metadata Parsing ─────────────────────────────────────

/// Read FLAC STREAMINFO block to extract duration (metaflac v0.2 doesn't expose this).
fn read_flac_streaminfo_duration(path: &Path) -> Result<f64, String> {
    use std::io::Read;
    let mut f = std::fs::File::open(path).map_err(|e| format!("Cannot open FLAC: {}", e))?;
    // Read "fLaC" marker + first metadata block header.
    let mut header = [0u8; 8];
    f.read_exact(&mut header).map_err(|e| format!("Cannot read FLAC header: {}", e))?;
    if &header[0..4] != b"fLaC" {
        return Err("Not a valid FLAC file".into());
    }
    // Block type should be 0 (STREAMINFO). Block length is big-endian 3 bytes.
    let block_type = header[4] & 0x7F;
    if block_type != 0 {
        return Err("First block is not STREAMINFO".into());
    }
    let block_len = ((header[5] as u32) << 16) | ((header[6] as u32) << 8) | (header[7] as u32);
    if block_len < 18 {
        return Err("STREAMINFO too short".into());
    }
    let mut body = vec![0u8; block_len as usize];
    f.read_exact(&mut body).map_err(|e| format!("Cannot read STREAMINFO: {}", e))?;

    // STREAMINFO layout (bits, MSB first):
    //   16 min block, 16 max block, 24 min frame, 24 max frame,
    //   20 sample rate, 3 channels-1, 5 bps-1, 36 total samples, 128 MD5
    let sample_rate = ((body[10] as u32) << 12)
        | ((body[11] as u32) << 4)
        | ((body[12] as u32) >> 4);
    let total_samples = ((body[13] as u64 & 0x0F) << 32)
        | ((body[14] as u64) << 24)
        | ((body[15] as u64) << 16)
        | ((body[16] as u64) << 8)
        | (body[17] as u64);

    if sample_rate > 0 {
        Ok(total_samples as f64 / sample_rate as f64)
    } else {
        Ok(0.0)
    }
}

pub fn parse_metadata(file_path: &str) -> Result<TrackMetadata, String> {
    let path = Path::new(file_path);
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())
        .unwrap_or_default();

    match ext.as_str() {
        "mp3" => parse_mp3(path),
        "flac" => parse_flac(path),
        "m4a" | "aac" => parse_m4a(path),
        "wav" => parse_wav(path),
        "ogg" | "opus" => parse_ogg(path),
        _ => {
            let file_name = path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("Unknown");
            Ok(TrackMetadata {
                file_path: file_path.to_string(),
                title: file_name.to_string(),
                artist: String::from("Unknown Artist"),
                album: String::from("Unknown Album"),
                album_artist: String::from("Unknown Artist"),
                duration_secs: 0.0,
                track_number: None,
                disc_number: None,
                genre: String::new(),
                year: None,
                has_artwork: false,
            })
        }
    }
}

fn parse_mp3(path: &Path) -> Result<TrackMetadata, String> {
    let tag = id3::Tag::read_from_path(path)
        .map_err(|e| format!("ID3 parse error: {}", e))?;

    // Try TLEN frame first, then fall back to MPEG frame calculation.
    let duration = match tag.duration() {
        Some(d) if d > 0 => d as f64,
        _ => calculate_mp3_duration_from_frames(path).unwrap_or(0.0),
    };
    let title = tag.title().unwrap_or("Unknown").to_string();
    let artist = tag.artist().unwrap_or("Unknown Artist").to_string();
    let album = tag.album().unwrap_or("Unknown Album").to_string();
    let album_artist = tag
        .album_artist()
        .map(|s| s.to_string())
        .unwrap_or_else(|| artist.clone());
    let genre = tag.genre().unwrap_or("").to_string();
    let year = tag.year();
    let track_number = tag.track();
    let disc_number = tag.disc();
    let has_artwork = tag.pictures().next().is_some();

    Ok(TrackMetadata {
        file_path: path.to_string_lossy().to_string(),
        title,
        artist,
        album,
        album_artist,
        duration_secs: duration,
        track_number,
        disc_number,
        genre,
        year,
        has_artwork,
    })
}

/// Calculate MP3 duration by parsing MPEG audio frames directly.
/// Handles both CBR and VBR (via Xing header) files.
fn calculate_mp3_duration_from_frames(path: &Path) -> Result<f64, String> {
    use std::io::Read;

    let file_len = std::fs::metadata(path)
        .map_err(|e| format!("Cannot stat file: {}", e))?
        .len();
    let mut f = std::fs::File::open(path).map_err(|e| format!("Cannot open: {}", e))?;

    // ── Skip ID3v2 tag if present ──
    let mut header = [0u8; 10];
    f.read_exact(&mut header).map_err(|e| format!("Read error: {}", e))?;
    let id3_size = if &header[0..3] == b"ID3" {
        // ID3v2 size: 4 bytes, syncsafe (bit 7 cleared), starting at offset 6.
        let sz = ((header[6] as u32) << 21)
            | ((header[7] as u32) << 14)
            | ((header[8] as u32) << 7)
            | (header[9] as u32);
        // +10 for the header itself; some files have extra footer/padding.
        (sz + 10) as u64
    } else {
        0
    };

    // Seek past ID3 tag to find first sync frame.
    use std::io::Seek;
    f.seek(std::io::SeekFrom::Start(id3_size))
        .map_err(|e| format!("Seek error: {}", e))?;

    // ── Read enough data to find sync + Xing header ──
    let mut buf = vec![0u8; 4096];
    let n = f.read(&mut buf).map_err(|e| format!("Read error: {}", e))?;
    if n < 4 {
        return Err("File too short for MPEG header".into());
    }

    // Find the first frame sync (11 set bits: 0xFFE0).
    let mut sync_pos = None;
    for i in 0..n.saturating_sub(1) {
        if buf[i] == 0xFF && (buf[i + 1] & 0xE0) == 0xE0 {
            sync_pos = Some(i);
            break;
        }
    }
    let sync = sync_pos.ok_or("No MPEG sync found")?;
    if sync + 3 >= n {
        return Err("Incomplete MPEG header in buffer".into());
    }

    let _b0 = buf[sync];
    let b1 = buf[sync + 1];
    let b2 = buf[sync + 2];

    // ── Parse MPEG frame header ──
    let mpeg_version = (b1 >> 3) & 0x03; // 0=2.5, 1=reserved, 2=2, 3=1
    let layer = (b1 >> 1) & 0x03;        // 1=III, 2=II, 3=I
    let bitrate_idx = (b2 >> 4) & 0x0F;
    let sample_rate_idx = (b2 >> 2) & 0x03;
    let padding = ((b2 >> 1) & 0x01) != 0;

    // Sample rate lookup [MPEG2.5, reserved, MPEG2, MPEG1]
    let sample_rates: [[u32; 4]; 3] = [
        [11025, 0, 22050, 44100], // MPEG1
        [12000, 0, 24000, 48000], // MPEG2
        [8000,  0, 16000, 32000], // MPEG2.5
    ];
    // Map version to table row.
    let ver_row = match mpeg_version {
        3 => 0, // MPEG1
        2 => 1, // MPEG2
        0 => 2, // MPEG2.5
        _ => return Err("Reserved MPEG version".into()),
    };
    let sample_rate = sample_rates[ver_row][sample_rate_idx as usize];
    if sample_rate == 0 {
        return Err("Invalid sample rate".into());
    }

    // Bitrate lookup (kbps): [version_row][layer_idx][bitrate_idx]
    let bitrates: [[[u32; 16]; 4]; 2] = [
        // MPEG1
        [
            [0,32,64,96,128,160,192,224,256,288,320,352,384,416,448,0], // Layer I
            [0,32,48,56, 64, 80, 96,112,128,160,192,224,256,320,384,0], // Layer II
            [0,32,40,48, 56, 64, 80, 96,112,128,160,192,224,256,320,0], // Layer III
            [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
        ],
        // MPEG2/2.5
        [
            [0,32,48,56,64,80,96,112,128,144,160,176,192,224,256,0], // Layer I
            [0,8,16,24,32,40,48,56,64,80,96,112,128,144,160,0],      // Layer II
            [0,8,16,24,32,40,48,56,64,80,96,112,128,144,160,0],      // Layer III
            [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
        ],
    ];
    let ver_idx = if mpeg_version == 3 { 0 } else { 1 }; // MPEG1 vs MPEG2/2.5
    let layer_idx = match layer {
        3 => 0, // Layer I
        2 => 1, // Layer II
        1 => 2, // Layer III
        _ => return Err("Reserved layer".into()),
    };
    let bitrate_kbps = bitrates[ver_idx][layer_idx][bitrate_idx as usize] as u64;
    if bitrate_kbps == 0 {
        return Err("Invalid bitrate".into());
    }

    // ── Check for Xing/VBR header ──
    // Xing header offset from sync: 36 for MPEG1, 21 for MPEG2/2.5
    // But only for Layer III (MP3).
    let xing_offset = if layer == 1 {
        // Layer III
        if mpeg_version == 3 { 36 } else { 21 }
    } else {
        // Xing only defined for Layer III
        0
    };

    let mut vbr_frames: Option<u64> = None;
    if xing_offset > 0 && sync + xing_offset + 8 < n {
        let xing_pos = sync + xing_offset;
        let xing_id = &buf[xing_pos..xing_pos + 4];
        if xing_id == b"Xing" || xing_id == b"Info" {
            let xing_flags = ((buf[xing_pos + 4] as u32) << 24)
                | ((buf[xing_pos + 5] as u32) << 16)
                | ((buf[xing_pos + 6] as u32) << 8)
                | (buf[xing_pos + 7] as u32);
            if (xing_flags & 0x01) != 0 && xing_pos + 12 < n {
                // Frame count is present.
                let frames = ((buf[xing_pos + 8] as u64) << 24)
                    | ((buf[xing_pos + 9] as u64) << 16)
                    | ((buf[xing_pos + 10] as u64) << 8)
                    | (buf[xing_pos + 11] as u64);
                if frames > 0 {
                    vbr_frames = Some(frames);
                }
            }
        }
    }

    // ── Calculate duration ──
    let duration = if let Some(frames) = vbr_frames {
        // VBR: samples per frame * number of frames / sample rate
        let samples_per_frame: u64 = match layer {
            3 => 384,  // Layer I
            2 => 1152, // Layer II
            _ => if mpeg_version == 3 { 1152 } else { 576 }, // Layer III
        };
        (frames * samples_per_frame) as f64 / sample_rate as f64
    } else {
        // CBR: (file_size - id3_size - sync_offset) * 8 (bits) / (bitrate * 1000)
        // This approach works but is less accurate; we calculate based on
        // the frame size and available data.
        let samples_per_frame: u64 = match layer {
            3 => 384,  // Layer I
            2 => 1152, // Layer II
            _ => if mpeg_version == 3 { 1152 } else { 576 }, // Layer III
        };
        let frame_size = if layer == 3 {
            // Layer I: frame_size = (12 * bitrate / sample_rate + padding) * 4
            ((12 * bitrate_kbps * 1000 / sample_rate as u64) + if padding { 1 } else { 0 }) * 4
        } else {
            // Layer II/III: frame_size = 144 * bitrate * 1000 / sample_rate + padding
            (144 * bitrate_kbps * 1000 / sample_rate as u64) + if padding { 1 } else { 0 }
        };

        if frame_size == 0 {
            return Err("Could not determine frame size".into());
        }

        let audio_data_size = file_len.saturating_sub(id3_size).saturating_sub(sync as u64);
        let num_frames = audio_data_size / frame_size;
        (num_frames * samples_per_frame) as f64 / sample_rate as f64
    };

    Ok(duration)
}

fn parse_flac(path: &Path) -> Result<TrackMetadata, String> {
    let tag = metaflac::Tag::read_from_path(path)
        .map_err(|e| format!("FLAC parse error: {}", e))?;

    let vorbis = tag
        .vorbis_comments()
        .ok_or_else(|| "No Vorbis comments in FLAC".to_string())?;

    // metaflac v0.2: VorbisComment getters return Option<&Vec<String>>
    // (multiple values per key are allowed). Take the first.
    fn first(vals: Option<&Vec<String>>) -> Option<&str> {
        vals.and_then(|v| v.first().map(|s| s.as_str()))
    }

    let title = first(vorbis.title()).unwrap_or("Unknown").to_string();
    let artist = first(vorbis.artist()).unwrap_or("Unknown Artist").to_string();
    let album = first(vorbis.album()).unwrap_or("Unknown Album").to_string();
    let album_artist = first(vorbis.album_artist())
        .map(|s| s.to_string())
        .unwrap_or_else(|| artist.clone());
    let genre = first(vorbis.genre()).unwrap_or("").to_string();

    let year = vorbis.get("DATE")
        .or_else(|| vorbis.get("YEAR"))
        .and_then(|v| v.first())
        .and_then(|s| s.parse::<i32>().ok());

    let track_number = vorbis.track();
    let disc_number = vorbis.get("DISCNUMBER")
        .and_then(|v| v.first())
        .and_then(|s| s.parse::<u32>().ok());

    // Try to get duration from STREAMINFO block (not exposed by metaflac v0.2 API).
    let duration_secs = read_flac_streaminfo_duration(path).unwrap_or(0.0);
    let has_artwork = tag.pictures().next().is_some();

    Ok(TrackMetadata {
        file_path: path.to_string_lossy().to_string(),
        title,
        artist,
        album,
        album_artist,
        duration_secs,
        track_number,
        disc_number,
        genre,
        year,
        has_artwork,
    })
}

fn parse_m4a(path: &Path) -> Result<TrackMetadata, String> {
    let tag = mp4ameta::Tag::read_from_path(path)
        .map_err(|e| format!("M4A parse error: {}", e))?;

    let title = tag.title().unwrap_or("Unknown").to_string();
    let artist = tag.artist().unwrap_or("Unknown Artist").to_string();
    let album = tag.album().unwrap_or("Unknown Album").to_string();
    let album_artist = tag
        .album_artist()
        .map(|s| s.to_string())
        .unwrap_or_else(|| artist.clone());
    let genre = tag.genre().unwrap_or("").to_string();

    // mp4ameta v0.2: year() -> Option<&str>
    let year = tag.year().and_then(|y| y.parse::<i32>().ok());

    // track_number() -> (Option<u16>, Option<u16>) = (num, total)
    let track_number = tag.track_number().0.map(|n| n as u32);

    // disk_number() -> (Option<u16>, Option<u16>) = (num, total)
    let disc_number = tag.disk_number().0.map(|n| n as u32);

    // duration() -> Option<f64> (already in seconds)
    let duration_secs = tag.duration().unwrap_or(0.0);

    // artwork() -> Option<&ArtworkData>
    let has_artwork = tag.artwork().is_some();

    Ok(TrackMetadata {
        file_path: path.to_string_lossy().to_string(),
        title,
        artist,
        album,
        album_artist,
        duration_secs,
        track_number,
        disc_number,
        genre,
        year,
        has_artwork,
    })
}

fn parse_wav(path: &Path) -> Result<TrackMetadata, String> {
    use std::io::Read;
    let mut f = std::fs::File::open(path).map_err(|e| format!("Cannot open WAV: {}", e))?;
    let file_name = path.file_stem().and_then(|s| s.to_str()).unwrap_or("Unknown");

    // Read RIFF header
    let mut riff = [0u8; 12];
    f.read_exact(&mut riff).map_err(|e| format!("Not a valid WAV: {}", e))?;
    if &riff[0..4] != b"RIFF" || &riff[8..12] != b"WAVE" {
        return Err("Not a valid WAV file".into());
    }

    let mut byte_rate: u32 = 176400;
    let mut data_size: u32 = 0;

    // Scan chunks
    loop {
        let mut chunk_header = [0u8; 8];
        if f.read_exact(&mut chunk_header).is_err() { break; }
        let chunk_id = &chunk_header[0..4];
        let chunk_size = u32::from_le_bytes([chunk_header[4], chunk_header[5], chunk_header[6], chunk_header[7]]);

        match chunk_id {
            b"fmt " => {
                let mut fmt_data = vec![0u8; chunk_size as usize];
                f.read_exact(&mut fmt_data).map_err(|e| format!("WAV fmt read error: {}", e))?;
                if chunk_size >= 16 {
                    byte_rate = u32::from_le_bytes([fmt_data[8], fmt_data[9], fmt_data[10], fmt_data[11]]);
                }
            }
            b"data" => {
                data_size = chunk_size;
                break; // data is last chunk we care about
            }
            _ => {
                // Skip unknown chunks
                let mut skip = vec![0u8; chunk_size as usize];
                let _ = f.read_exact(&mut skip);
            }
        }
    }

    let duration_secs = if byte_rate > 0 { data_size as f64 / byte_rate as f64 } else { 0.0 };

    Ok(TrackMetadata {
        file_path: path.to_string_lossy().to_string(),
        title: file_name.to_string(),
        artist: String::from("Unknown Artist"),
        album: String::from("Unknown Album"),
        album_artist: String::from("Unknown Artist"),
        duration_secs,
        track_number: None,
        disc_number: None,
        genre: String::new(),
        year: None,
        has_artwork: false,
    })
}

/// Parse OGG container (Vorbis or Opus) to extract duration from the last page's granule position.
fn parse_ogg(path: &Path) -> Result<TrackMetadata, String> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = std::fs::File::open(path).map_err(|e| format!("Cannot open OGG: {}", e))?;
    let file_name = path.file_stem().and_then(|s| s.to_str()).unwrap_or("Unknown");

    // Read first OGG page to determine codec and sample rate
    let mut first_page = [0u8; 28];
    f.read_exact(&mut first_page).map_err(|e| format!("OGG read error: {}", e))?;
    if &first_page[0..4] != b"OggS" {
        return Err("Not a valid OGG file".into());
    }
    let num_segments = first_page[26] as usize;
    let mut seg_table = vec![0u8; num_segments];
    f.read_exact(&mut seg_table).map_err(|e| format!("OGG seg table error: {}", e))?;
    let first_seg_size = seg_table.iter().map(|&s| s as usize).sum::<usize>();

    // Read first packet to identify codec
    let mut first_pkt = vec![0u8; first_seg_size.min(64)];
    f.read_exact(&mut first_pkt).map_err(|e| format!("OGG pkt error: {}", e))?;

    // Determine sample rate from the first packet header
    let sample_rate: u64 = if first_pkt.len() >= 8 && &first_pkt[0..8] == b"OpusHead" {
        48000 // Opus: decoder output rate is always 48000
    } else if first_pkt.len() >= 16 && first_pkt[0] == 1 && &first_pkt[1..7] == b"vorbis" {
        // Vorbis: sample rate in identification header at offset 12 (little-endian u32)
        u32::from_le_bytes([first_pkt[12], first_pkt[13], first_pkt[14], first_pkt[15]]) as u64
    } else {
        44100 // unknown, default
    };

    // Seek to the last ~64KB to find the final OGG page with granule position
    let file_len = f.seek(SeekFrom::End(0)).map_err(|e| format!("OGG seek error: {}", e))?;
    let search_start = if file_len > 65536 { file_len - 65536 } else { 0 };
    f.seek(SeekFrom::Start(search_start)).map_err(|e| format!("OGG seek error: {}", e))?;

    let mut buf = Vec::new();
    f.read_to_end(&mut buf).map_err(|e| format!("OGG tail read error: {}", e))?;

    let mut last_granule: u64 = 0;
    let mut pos = 0;
    while pos + 27 < buf.len() {
        if &buf[pos..pos+4] == b"OggS" {
            let granule = u64::from_le_bytes([
                buf[pos+6], buf[pos+7], buf[pos+8], buf[pos+9],
                buf[pos+10], buf[pos+11], buf[pos+12], buf[pos+13],
            ]);
            if granule > last_granule { last_granule = granule; }
            let segs = buf[pos+26] as usize;
            let seg_end = pos + 27 + segs;
            if seg_end > buf.len() { break; }
            let pkt_total: usize = buf[pos+27..seg_end].iter().map(|&s| s as usize).sum();
            pos = seg_end + pkt_total;
        } else {
            pos += 1;
        }
    }

    let duration_secs = if sample_rate > 0 {
        last_granule as f64 / sample_rate as f64
    } else {
        0.0
    };

    Ok(TrackMetadata {
        file_path: path.to_string_lossy().to_string(),
        title: file_name.to_string(),
        artist: String::from("Unknown Artist"),
        album: String::from("Unknown Album"),
        album_artist: String::from("Unknown Artist"),
        duration_secs,
        track_number: None,
        disc_number: None,
        genre: String::new(),
        year: None,
        has_artwork: false,
    })
}

// ─── Artwork Extraction ───────────────────────────────────

/// Extract embedded album art to a temporary PNG file.
pub fn extract_artwork_to_temp(file_path: &str) -> Result<Option<String>, String> {
    let path = Path::new(file_path);
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())
        .unwrap_or_default();

    let image_bytes: Vec<u8> = match ext.as_str() {
        "mp3" => {
            let tag = id3::Tag::read_from_path(path).map_err(|e| e.to_string())?;
            let pic = match tag.pictures().next() {
                Some(p) => p.data.clone(),
                None => return Ok(None),
            };
            pic
        }
        "flac" => {
            let tag = metaflac::Tag::read_from_path(path).map_err(|e| e.to_string())?;
            let pic = match tag.pictures().next() {
                Some(p) => p.data.clone(),
                None => return Ok(None),
            };
            pic
        }
        "m4a" | "aac" => {
            let tag = mp4ameta::Tag::read_from_path(path).map_err(|e| e.to_string())?;
            let art = match tag.artwork() {
                Some(a) => a.clone(),
                None => return Ok(None),
            };
            match art {
                mp4ameta::Data::Jpeg(v)
                | mp4ameta::Data::Png(v)
                | mp4ameta::Data::Reserved(v) => v,
                _ => return Ok(None),
            }
        }
        _ => return Ok(None),
    };

    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};

    let mut hasher = DefaultHasher::new();
    file_path.hash(&mut hasher);
    let hash = hasher.finish();

    let temp_dir = std::env::temp_dir().join("needmusic_artwork");
    fs::create_dir_all(&temp_dir).map_err(|e| e.to_string())?;
    let output_path = temp_dir.join(format!("{:x}.png", hash));

    let img = image::load_from_memory(&image_bytes).map_err(|e| e.to_string())?;
    img.save(&output_path).map_err(|e| e.to_string())?;

    Ok(Some(output_path.to_string_lossy().to_string()))
}
