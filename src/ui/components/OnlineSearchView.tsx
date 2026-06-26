import React, { useState, useCallback, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { OnlineMusicService, BilibiliSearchItem } from "@core/services/OnlineMusicService";
import { PlaybackEngine } from "@core/services/PlaybackEngine";
import { IconMusic, IconPlay, IconClose, IconPlus } from "@ui/components/Icons";

/** Fetches a Bilibili cover image through the Rust proxy (adds Referer header). */
const ProxiedCover: React.FC<{ url: string; alt: string }> = ({ url, alt }) => {
  const [dataUri, setDataUri] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    setDataUri(null);
    setFailed(false);
    if (!url) {
      setFailed(true);
      return;
    }
    invoke<string>("proxy_image", { url })
      .then((uri) => { if (mountedRef.current) setDataUri(uri); })
      .catch(() => { if (mountedRef.current) setFailed(true); });
    return () => { mountedRef.current = false; };
  }, [url]);

  if (failed || !dataUri) {
    return (
      <div className="online-result-cover-placeholder">
        <IconMusic size={28} />
      </div>
    );
  }
  return <img src={dataUri} alt={alt} loading="lazy" />;
};

interface OnlineSearchViewProps {
  musicFolder: string;
  onTrackSaved: () => void;
}

const OnlineSearchView: React.FC<OnlineSearchViewProps> = ({ musicFolder, onTrackSaved }) => {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<BilibiliSearchItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [downloading, setDownloading] = useState<string | null>(null); // bvid currently downloading
  const [error, setError] = useState<string | null>(null);

  const service = OnlineMusicService.getInstance();
  const engine = PlaybackEngine.getInstance();

  // Auto-dismiss error after 8 seconds
  React.useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(null), 8000);
    return () => clearTimeout(t);
  }, [error]);

  // Search
  const handleSearch = useCallback(async () => {
    const q = query.trim();
    if (!q) return;
    setLoading(true);
    setError(null);
    setResults([]);
    try {
      const res = await service.search(q);
      setResults(res.results);
      if (res.results.length === 0) {
        setError("No results found. Try a different search term.");
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [query]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") handleSearch();
    },
    [handleSearch],
  );

  // Download & play
  const handlePlay = useCallback(async (item: BilibiliSearchItem) => {
    setDownloading(item.bvid);
    setError(null);
    try {
      const track = await service.downloadAndPlay(item);
      await engine.play(track);
    } catch (err) {
      setError(String(err));
    } finally {
      setDownloading(null);
    }
  }, [engine]);

  // Save to library
  const handleSave = useCallback(async (item: BilibiliSearchItem) => {
    if (!musicFolder) {
      setError("Set a music folder in Settings first.");
      return;
    }
    setDownloading(item.bvid);
    setError(null);
    try {
      await service.saveToLibrary(item, musicFolder);
      onTrackSaved();
    } catch (err) {
      setError(String(err));
    } finally {
      setDownloading(null);
    }
  }, [musicFolder, onTrackSaved]);

  return (
    <div className="online-search-view">
      {/* Search bar */}
      <div className="online-search-bar">
        <input
          className="online-search-input"
          type="text"
          placeholder="Search Bilibili for music..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={loading}
        />
        <button
          className="online-search-btn"
          onClick={handleSearch}
          disabled={loading || !query.trim()}
        >
          {loading ? "Searching..." : "Search"}
        </button>
      </div>

      {/* Error */}
      {error && (
        <div className="online-error">
          <IconClose size={14} />
          <span>{error}</span>
        </div>
      )}

      {/* Results grid */}
      {results.length > 0 && (
        <div className="online-results-grid">
          {results.map((item) => (
            <div key={item.bvid} className="online-result-card">
              {/* Cover image */}
              <div className="online-result-cover">
                <ProxiedCover url={item.cover_url} alt={item.title} />
                {/* Duration badge */}
                <span className="online-result-duration">{item.duration}</span>
                {/* Play button overlay */}
                <button
                  className="online-result-play-btn"
                  onClick={() => handlePlay(item)}
                  disabled={downloading === item.bvid}
                  title="Download & Play"
                >
                  {downloading === item.bvid ? (
                    <span className="online-spinner" />
                  ) : (
                    <IconPlay size={16} />
                  )}
                </button>
              </div>
              {/* Info */}
              <div className="online-result-info">
                <div className="online-result-title" title={item.title}>
                  {item.title}
                </div>
                <div className="online-result-author" title={item.author}>
                  {item.author}
                </div>
                {item.description && (
                  <div className="online-result-desc" title={item.description}>
                    {item.description.length > 60
                      ? item.description.slice(0, 60) + "..."
                      : item.description}
                  </div>
                )}
                {/* Action buttons */}
                <div className="online-result-actions">
                  <button
                    className="online-action-btn play"
                    onClick={() => handlePlay(item)}
                    disabled={downloading === item.bvid}
                    title="Play now (temp download)"
                  >
                    {downloading === item.bvid ? (
                      <span className="online-spinner" />
                    ) : (
                      <IconPlay size={12} />
                    )}
                    Play
                  </button>
                  <button
                    className="online-action-btn save"
                    onClick={() => handleSave(item)}
                    disabled={downloading === item.bvid || !musicFolder}
                    title={musicFolder ? "Save to library" : "Set a music folder in Settings first"}
                  >
                    <IconPlus size={12} />
                    Save
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Empty state */}
      {!loading && results.length === 0 && !error && (
        <div className="online-empty">
          <IconMusic size={32} />
          <p>Search for music from Bilibili to play instantly.</p>
          <p className="online-empty-hint">
            Tip: Try "lofi", "anime ost", or your favorite artist name.
          </p>
        </div>
      )}
    </div>
  );
};

export default OnlineSearchView;
