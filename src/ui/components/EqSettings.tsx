import React, { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";

interface EqBandInfo {
  freq: number;
  gain_db: number;
}

interface EqPresetInfo {
  name: string;
  description: string;
  gains: number[];
}

interface EqState {
  enabled: boolean;
  bands: EqBandInfo[];
  presets: EqPresetInfo[];
}

const BAND_LABELS: Record<number, string> = {
  60: "Sub",
  250: "Bass",
  1000: "Mid",
  4000: "Presence",
  12000: "Treble",
};

const BAND_COLORS = [
  "#e94560", // Sub - red
  "#f5a623", // Bass - amber
  "#4ecdc4", // Mid - teal
  "#6c5ce7", // Presence - purple
  "#a29bfe", // Treble - lavender
];

const EqSettings: React.FC = () => {
  const [eqState, setEqState] = useState<EqState | null>(null);
  const [selectedPreset, setSelectedPreset] = useState(-1);
  const [loading, setLoading] = useState(true);

  const loadEqState = useCallback(async () => {
    try {
      const state = await invoke<EqState>("get_eq_state");
      setEqState(state);
      setSelectedPreset(-1);
    } catch (e) {
      console.error("Failed to load EQ state:", e);
    }
    setLoading(false);
  }, []);

  useEffect(() => { loadEqState(); }, [loadEqState]);

  const handleToggle = useCallback(async (enabled: boolean) => {
    try {
      await invoke("set_eq_enabled", { enabled });
      setEqState((prev) => prev ? { ...prev, enabled } : null);
    } catch (e) {
      console.error("Failed to toggle EQ:", e);
    }
  }, []);

  const handleBandChange = useCallback(async (index: number, gain_db: number) => {
    try {
      await invoke("set_eq_band_gain", { index, gainDb: gain_db });
      setEqState((prev) => {
        if (!prev) return null;
        const bands = [...prev.bands];
        bands[index] = { ...bands[index], gain_db };
        return { ...prev, bands };
      });
      setSelectedPreset(-1);
    } catch (e) {
      console.error("Failed to set EQ band:", e);
    }
  }, []);

  const handlePreset = useCallback(async (index: number) => {
    try {
      await invoke("apply_eq_preset", { presetIndex: index });
      await loadEqState();
      setSelectedPreset(index);
    } catch (e) {
      console.error("Failed to apply preset:", e);
    }
  }, [loadEqState]);

  if (loading) return <div style={{ fontSize: 13, color: "var(--text-tertiary)", padding: "8px 0" }}>Loading equalizer...</div>;
  if (!eqState) return <div style={{ fontSize: 13, color: "var(--color-error)", padding: "8px 0" }}>EQ unavailable</div>;

  return (
    <div className="eq-settings">
      {/* Enable/Disable */}
      <label className="settings-check" style={{ marginBottom: 12 }}>
        <input
          type="checkbox"
          checked={eqState.enabled}
          onChange={(e) => handleToggle(e.target.checked)}
        />
        Enable Equalizer
        <span style={{ fontSize: 10, color: "var(--text-tertiary)", marginLeft: 4 }}>
          (applies to all playback)
        </span>
      </label>

      {/* Presets */}
      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 6, color: "var(--text-secondary)" }}>
          Presets
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {eqState.presets.map((preset, i) => (
            <button
              key={preset.name}
              className="eq-preset-btn"
              title={preset.description}
              onClick={() => handlePreset(i)}
              style={{
                padding: "4px 10px",
                fontSize: 12,
                border: selectedPreset === i
                  ? "1px solid var(--accent-primary)"
                  : "1px solid var(--border-color)",
                borderRadius: "var(--radius-sm)",
                background: selectedPreset === i
                  ? "var(--accent-primary)"
                  : "transparent",
                color: selectedPreset === i ? "#fff" : "var(--text-secondary)",
                cursor: "pointer",
                transition: "all 0.15s",
              }}
            >
              {preset.name}
            </button>
          ))}
        </div>
      </div>

      {/* Band Sliders */}
      <div className="eq-bands" style={{ display: "flex", gap: 12, alignItems: "flex-end", justifyContent: "center", minHeight: 140, paddingTop: 8 }}>
        {eqState.bands.map((band, i) => (
          <div
            key={band.freq}
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 4,
              flex: 1,
              maxWidth: 64,
            }}
          >
            {/* Gain value label */}
            <span style={{
              fontSize: 10,
              color: band.gain_db !== 0 ? BAND_COLORS[i] : "var(--text-tertiary)",
              fontWeight: band.gain_db !== 0 ? 600 : 400,
              transition: "color 0.15s",
            }}>
              {band.gain_db > 0 ? "+" : ""}{band.gain_db.toFixed(1)} dB
            </span>

            {/* Vertical slider */}
            <input
              type="range"
              min={-12}
              max={12}
              step={0.5}
              value={band.gain_db}
              onChange={(e) => handleBandChange(i, parseFloat(e.target.value))}
              onDoubleClick={() => handleBandChange(i, 0)}
              title={`${BAND_LABELS[band.freq] || band.freq + "Hz"}: ${band.gain_db > 0 ? "+" : ""}${band.gain_db} dB (double-click to reset)`}
              style={{
                writingMode: "vertical-lr",
                direction: "rtl",
                WebkitAppearance: "slider-vertical",
                width: 24,
                height: 100,
                accentColor: BAND_COLORS[i],
                cursor: "pointer",
              }}
            />

            {/* Frequency label */}
            <span style={{
              fontSize: 10,
              color: "var(--text-tertiary)",
              fontWeight: 500,
            }}>
              {BAND_LABELS[band.freq] || band.freq + "Hz"}
            </span>
            <span style={{ fontSize: 9, color: "var(--text-tertiary)", opacity: 0.6 }}>
              {band.freq >= 1000 ? (band.freq / 1000).toFixed(1) + "k" : band.freq + "Hz"}
            </span>
          </div>
        ))}
      </div>

      {/* Reset hint */}
      <div style={{ fontSize: 10, color: "var(--text-tertiary)", marginTop: 10, textAlign: "center", opacity: 0.6 }}>
        Double-click a slider to reset to 0 dB
      </div>
    </div>
  );
};

export default EqSettings;
export type { EqState, EqBandInfo, EqPresetInfo };
