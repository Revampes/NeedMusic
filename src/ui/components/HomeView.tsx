import React, { useMemo } from "react";
import type { Track } from "@core/models/Track";
import { Album } from "@core/models/Album";
import { Artist } from "@core/models/Artist";
import {
  IconMusic, IconDisc, IconMic, IconPlaylist,
  IconPlay, IconHeart, IconHeartFill,
} from "@ui/components/Icons";

interface HomeViewProps {
  tracks: Track[];
  currentTrack: Track | null;
  onPlay: (track: Track) => void;
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

const HomeView: React.FC<HomeViewProps> = ({ tracks, currentTrack, onPlay }) => {
  const greeting = getGreeting();

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
                    <div className="hmt-title">{t.title}</div>
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
                    <div className="hmt-title">{t.title}</div>
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
