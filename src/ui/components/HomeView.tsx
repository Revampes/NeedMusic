import React, { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Track } from "@core/models/Track";
import { OnlineMusicService, TrendingMusicItem } from "@core/services/OnlineMusicService";
import { DatabaseManager } from "@core/services/DatabaseManager";
import { PlaybackEngine } from "@core/services/PlaybackEngine";
import { Album } from "@core/models/Album";
import { Artist } from "@core/models/Artist";
import {
  IconMusic, IconDisc, IconMic, IconPlaylist,
  IconPlay, IconHeart, IconHeartFill, IconDownload,
} from "@ui/components/Icons";
import Heatmap from "@ui/components/Heatmap";

interface HomeViewProps {
  tracks: Track[];
  currentTrack: Track | null;
  onPlay: (track: Track) => void;
  onTrackSaved: () => void;
}

function formatDuration(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function getGreeting(): string {
  const h = new Date().getHours();
  if (h < 12) return "Good Morning";
  if (h < 17) return "Good Afternoon";
  if (h < 21) return "Good Evening";
  return "Good Night";
}

const HomeView: React.FC<HomeViewProps> = ({ tracks, currentTrack, onPlay, onTrackSaved }) => {
  const greeting = getGreeting();
  const [trending, setTrending] = useState<TrendingMusicItem[]>([]);
  const [trendingLoading, setTrendingLoading] = useState(true);
  const [trendingError, setTrendingError] = useState<string | null>(null);
  const [trendingBusy, setTrendingBusy] = useState<string | null>(null);
  const [recommended, setRecommended] = useState<TrendingMusicItem[]>([]);
  const [recommendedLoading, setRecommendedLoading] = useState(true);
  const [recommendedError, setRecommendedError] = useState<string | null>(null);
  const onlineService = OnlineMusicService.getInstance();
  const engine = PlaybackEngine.getInstance();

  const loadTrending = useCallback(async (refresh = false) => {
    setTrendingLoading(true);
    setTrendingError(null);
    try {
      setTrending(await onlineService.fetchTrendingMusic(refresh));
    } catch (error) {
      setTrendingError(String(error));
    } finally {
      setTrendingLoading(false);
    }
  }, [onlineService]);

  useEffect(() => { void loadTrending(); }, [loadTrending]);

  const loadRecommended = useCallback(async () => {
    setRecommendedLoading(true);
    setRecommendedError(null);
    try {
      setRecommended(await onlineService.fetchRecommendedMusic());
    } catch (error) {
      setRecommendedError(String(error));
    } finally {
      setRecommendedLoading(false);
    }
  }, [onlineService]);

  useEffect(() => { void loadRecommended(); }, [loadRecommended]);

  const asOnlineItem = (item: TrendingMusicItem) => ({
    source: "bilibili",
    id: item.bvid,
    bvid: item.bvid,
    cid: item.cid,
    title: item.title,
    author: item.owner_name,
    duration: formatDuration(item.duration),
    duration_secs: item.duration,
    cover_url: item.pic,
    description: "",
    url: `https://www.bilibili.com/video/${item.bvid}`,
  });

  const playTrending = async (item: TrendingMusicItem) => {
    setTrendingBusy(item.bvid);
    try {
      await engine.play(await onlineService.downloadAndPlay(asOnlineItem(item)));
    } catch (error) {
      setTrendingError(String(error));
    } finally {
      setTrendingBusy(null);
    }
  };

  const downloadTrending = async (item: TrendingMusicItem) => {
    setTrendingBusy(item.bvid);
    try {
      const db = DatabaseManager.getInstance();
      let directory = await db.getSetting("onlineDownloadPath");
      if (!directory) directory = await invoke<string>("get_default_download_dir");
      await onlineService.saveToLibrary(asOnlineItem(item), directory);
      onTrackSaved();
    } catch (error) {
      setTrendingError(String(error));
    } finally {
      setTrendingBusy(null);
    }
  };

  // Compute stats
  const stats = useMemo(() => {
    const albumMap = Album.groupByAlbum(tracks);
    const artistMap = Artist.groupByArtist(tracks);
    return {
      tracks: tracks.length,
      albums: albumMap.size,
      artists: artistMap.size,
    };
  }, [tracks]);

  // Recently added (last 8 tracks by insertion order)
  const recentTracks = useMemo(() => {
    return [...tracks].reverse().slice(0, 8);
  }, [tracks]);

  // Most played (by favorite count — proxy for now, just favorites)
  const favoritesList = useMemo(() => {
    return tracks.filter((t) => t.isFavorite).slice(0, 8);
  }, [tracks]);

  return (
    <div className="home-view">
      {/* ── Hero / Greeting ─────────────────────────── */}
      <section className="home-hero">
        <div className="home-hero-text">
          <h2 className="home-greeting">{greeting}</h2>
          <p className="home-subtitle">
            {tracks.length > 0
              ? `Ready to explore your ${stats.tracks} tracks`
              : "Go to Settings → Import Music to scan a folder"}
          </p>
        </div>
        <div className="home-hero-art">
          <div className="home-hero-icon">
            <IconMusic size={48} />
          </div>
        </div>
      </section>

      {/* ── Stats Row ───────────────────────────────── */}
      <section className="home-stats-row">
        <div className="home-stat-card">
          <div className="home-stat-icon"><IconMusic size={22} /></div>
          <div className="home-stat-value">{stats.tracks}</div>
          <div className="home-stat-label">Tracks</div>
        </div>
        <div className="home-stat-card">
          <div className="home-stat-icon"><IconDisc size={22} /></div>
          <div className="home-stat-value">{stats.albums}</div>
          <div className="home-stat-label">Albums</div>
        </div>
        <div className="home-stat-card">
          <div className="home-stat-icon"><IconMic size={22} /></div>
          <div className="home-stat-value">{stats.artists}</div>
          <div className="home-stat-label">Artists</div>
        </div>
        <div className="home-stat-card">
          <div className="home-stat-icon"><IconPlaylist size={22} /></div>
          <div className="home-stat-value">{favoritesList.length}</div>
          <div className="home-stat-label">Favorites</div>
        </div>
      </section>

      {/* ── Listening Heatmap ──────────────────────── */}
      <Heatmap />

      <div className="home-discovery-grid">
      <section className="home-section home-discovery-section">
        <div className="home-section-heading">
          <h3 className="home-section-title">Recommended for You</h3>
        </div>
        {recommendedLoading ? (
          <div className="home-empty-msg">Building recommendations...</div>
        ) : recommendedError ? (
          <div className="home-empty-msg">{recommendedError}</div>
        ) : recommended.length === 0 ? (
          <div className="home-empty-msg">
            Play a few Bilibili tracks to get personalized recommendations.
          </div>
        ) : (
          <div className="home-trending-list">
            {recommended.slice(0, 20).map((item) => (
              <div key={item.bvid} className="home-trending-row">
                <div className="hmt-info">
                  <div className="hmt-title">{item.title}</div>
                  <div className="hmt-artist">{item.owner_name} · {item.view.toLocaleString()} views</div>
                </div>
                <div className="hmt-dur">{formatDuration(item.duration)}</div>
                <button className="hmt-play trending-play-button" title="Play" disabled={trendingBusy === item.bvid} onClick={() => void playTrending(item)}>
                  <IconPlay size={14} />
                </button>
                <button className="trending-download-button" title="Download audio to your music library" disabled={trendingBusy === item.bvid} onClick={() => void downloadTrending(item)}>
                  <IconDownload size={14} />
                  <span>Download</span>
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="home-section home-discovery-section">
        <div className="home-section-heading">
          <h3 className="home-section-title">Trending on Bilibili</h3>
          <button className="home-action-btn secondary" onClick={() => void loadTrending(true)} disabled={trendingLoading}>
            Refresh
          </button>
        </div>
        {trendingLoading ? (
          <div className="home-empty-msg">Loading trending music...</div>
        ) : trendingError ? (
          <div className="home-empty-msg">{trendingError}</div>
        ) : trending.length === 0 ? (
          <div className="home-empty-msg">
            No trending tracks were returned. Use Refresh to try again.
          </div>
        ) : (
          <div className="home-trending-list">
            {trending.slice(0, 10).map((item) => (
              <div key={item.bvid} className="home-trending-row">
                <div className="hmt-info">
                  <div className="hmt-title">{item.title}</div>
                  <div className="hmt-artist">{item.owner_name} · {item.view.toLocaleString()} views</div>
                </div>
                <div className="hmt-dur">{formatDuration(item.duration)}</div>
                <button className="hmt-play trending-play-button" title="Play" disabled={trendingBusy === item.bvid} onClick={() => void playTrending(item)}>
                  <IconPlay size={14} />
                </button>
                <button className="trending-download-button" title="Download audio to your music library" disabled={trendingBusy === item.bvid} onClick={() => void downloadTrending(item)}>
                  <IconDownload size={14} />
                  <span>Download</span>
                </button>
              </div>
            ))}
          </div>
        )}
      </section>
      </div>

      {/* ── Content Grid ────────────────────────────── */}
      <div className="home-content-grid">
        {/* Recent Tracks */}
        <section className="home-section">
          <h3 className="home-section-title">Recently Added</h3>
          <div className="home-mini-track-list">
            {recentTracks.length === 0 ? (
              <div className="home-empty-msg">
                <IconMusic size={24} />
                <span>No tracks yet — scan a folder to get started</span>
              </div>
            ) : (
              recentTracks.map((t) => (
                <div
                  key={t.id}
                  className={`home-mini-track-row ${currentTrack?.id === t.id ? "active" : ""}`}
                  onDoubleClick={() => onPlay(t)}
                >
                  <div className="hmt-thumb">
                    {t.hasArtwork ? <IconDisc size={18} /> : <IconMusic size={18} />}
                  </div>
                  <div className="hmt-info">
                    <div className="hmt-title">
                      {t.title}
                      {t.isOnlineTrack() && (
                        <span className="track-online-badge" title="Saved without downloading — plays via the source API">Online</span>
                      )}
                    </div>
                    <div className="hmt-artist">{t.artist}</div>
                  </div>
                  <div className="hmt-dur">{formatDuration(t.durationSecs)}</div>
                  <button
                    className="hmt-play"
                    title="Play"
                    onClick={(e) => { e.stopPropagation(); onPlay(t); }}
                  >
                    <IconPlay size={14} />
                  </button>
                </div>
              ))
            )}
          </div>
        </section>

        {/* Favorites */}
        <section className="home-section">
          <h3 className="home-section-title">
            <IconHeartFill size={14} style={{ color: "var(--accent-primary)", marginRight: 6 }} />
            Your Favorites
          </h3>
          <div className="home-mini-track-list">
            {favoritesList.length === 0 ? (
              <div className="home-empty-msg">
                <IconHeart size={24} />
                <span>Heart a track to see it here</span>
              </div>
            ) : (
              favoritesList.map((t) => (
                <div
                  key={t.id}
                  className={`home-mini-track-row ${currentTrack?.id === t.id ? "active" : ""}`}
                  onDoubleClick={() => onPlay(t)}
                >
                  <div className="hmt-thumb">
                    {t.hasArtwork ? <IconDisc size={18} /> : <IconMusic size={18} />}
                  </div>
                  <div className="hmt-info">
                    <div className="hmt-title">
                      {t.title}
                      {t.isOnlineTrack() && (
                        <span className="track-online-badge" title="Saved without downloading — plays via the source API">Online</span>
                      )}
                    </div>
                    <div className="hmt-artist">{t.artist}</div>
                  </div>
                  <div className="hmt-dur">{formatDuration(t.durationSecs)}</div>
                  <button
                    className="hmt-play"
                    title="Play"
                    onClick={(e) => { e.stopPropagation(); onPlay(t); }}
                  >
                    <IconPlay size={14} />
                  </button>
                </div>
              ))
            )}
          </div>
        </section>
      </div>

      {/* ── Quick Actions ───────────────────────────── */}
      <section className="home-quick-actions">
        <button
          className="home-action-btn"
          onClick={() => {
            if (tracks.length > 0) {
              onPlay(tracks[Math.floor(Math.random() * tracks.length)]);
            }
          }}
          disabled={tracks.length === 0}
        >
          <IconPlay size={16} />
          <span>Shuffle All</span>
        </button>
        <button
          className="home-action-btn secondary"
          onClick={() => {
            const favs = tracks.filter((t) => t.isFavorite);
            if (favs.length > 0) onPlay(favs[0]);
          }}
          disabled={favoritesList.length === 0}
        >
          <IconHeartFill size={14} />
          <span>Play Favorites</span>
        </button>
      </section>
    </div>
  );
};

export default HomeView;
