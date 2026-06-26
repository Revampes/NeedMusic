import React from "react";

interface TopNavBarProps {
  activeTab: string;
  onTabChange: (tab: string) => void;
  searchQuery: string;
  onSearchChange: (q: string) => void;
  filterValue: string;
  onFilterChange: (f: string) => void;
}

const TABS = ["Tracks", "Albums", "Artists", "Favorites", "Playlists", "Settings"];
const FILTERS = ["All", "Title", "Artist", "Album", "Genre"];

const TopNavBar: React.FC<TopNavBarProps> = ({
  activeTab, onTabChange, searchQuery, onSearchChange, filterValue, onFilterChange,
}) => (
  <header className="top-nav">
    <div className="top-nav-tabs">
      {TABS.map((tab) => (
        <button
          key={tab}
          className={`top-nav-tab ${activeTab === tab ? "active" : ""}`}
          onClick={() => onTabChange(tab)}
        >
          {tab}
        </button>
      ))}
      <button className="top-nav-tab add-btn" title="New Playlist" onClick={() => onTabChange("Playlists")}>+</button>
    </div>
    <div className="top-nav-actions">
      <select
        className="filter-select"
        value={filterValue}
        onChange={(e) => onFilterChange(e.target.value)}
      >
        {FILTERS.map((f) => (
          <option key={f} value={f}>Filter By: {f}</option>
        ))}
      </select>
      <input
        className="search-input"
        type="text"
        placeholder="Search Music..."
        value={searchQuery}
        onChange={(e) => onSearchChange(e.target.value)}
      />
    </div>
  </header>
);

export default TopNavBar;
