import React, { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { DatabaseManager } from "@core/services/DatabaseManager";

interface HotkeyEntry {
  id: string;
  label: string;
  description: string;
  action: string;
  key: string;
  modifiers: string[];
  isGlobal: boolean;
}

const DEFAULT_HOTKEYS: HotkeyEntry[] = [
  {
    id: "playpause",
    label: "Play / Pause",
    description: "Toggle playback",
    action: "playpause",
    key: "Space",
    modifiers: [],
    isGlobal: false,
  },
  {
    id: "next",
    label: "Next Track",
    description: "Skip to the next track",
    action: "next",
    key: "Right",
    modifiers: ["Ctrl"],
    isGlobal: true,
  },
  {
    id: "previous",
    label: "Previous Track",
    description: "Go back to the previous track",
    action: "previous",
    key: "Left",
    modifiers: ["Ctrl"],
    isGlobal: true,
  },
  {
    id: "stop",
    label: "Stop",
    description: "Stop playback",
    action: "stop",
    key: "S",
    modifiers: ["Ctrl"],
    isGlobal: true,
  },
  {
    id: "loop",
    label: "Toggle Loop",
    description: "Cycle repeat modes (Off → Track → Playlist)",
    action: "loop",
    key: "L",
    modifiers: ["Ctrl"],
    isGlobal: true,
  },
  {
    id: "shuffle",
    label: "Toggle Shuffle",
    description: "Toggle shuffle mode",
    action: "shuffle",
    key: "R",
    modifiers: ["Ctrl"],
    isGlobal: true,
  },
  {
    id: "volup",
    label: "Volume Up",
    description: "Increase volume by 5%",
    action: "volup",
    key: "Up",
    modifiers: ["Ctrl"],
    isGlobal: true,
  },
  {
    id: "voldown",
    label: "Volume Down",
    description: "Decrease volume by 5%",
    action: "voldown",
    key: "Down",
    modifiers: ["Ctrl"],
    isGlobal: true,
  },
];

const HotkeySettings: React.FC = () => {
  const [hotkeys, setHotkeys] = useState<HotkeyEntry[]>(DEFAULT_HOTKEYS);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [listeningKey, setListeningKey] = useState(false);
  const db = DatabaseManager.getInstance();

  // Load saved hotkeys from database
  useEffect(() => {
    (async () => {
      const saved = await db.getSetting("hotkeys");
      if (saved) {
        try {
          const parsed = JSON.parse(saved) as HotkeyEntry[];
          // Merge with defaults to handle new entries
          const merged = DEFAULT_HOTKEYS.map((def) => {
            const custom = parsed.find((h: HotkeyEntry) => h.id === def.id);
            return custom || def;
          });
          setHotkeys(merged);
        } catch {
          setHotkeys(DEFAULT_HOTKEYS);
        }
      }
    })();
  }, [db]);

  const saveHotkeys = useCallback(async (updated: HotkeyEntry[]) => {
    setHotkeys(updated);
    await db.setSetting("hotkeys", JSON.stringify(updated));
  }, [db]);

  const startListening = useCallback((id: string) => {
    setEditingId(id);
    setListeningKey(true);

    const handler = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();

      const key = e.key.length === 1
        ? e.key.toUpperCase()
        : e.key.charAt(0).toUpperCase() + e.key.slice(1);

      const mods: string[] = [];
      if (e.ctrlKey) mods.push("ctrl");
      if (e.altKey) mods.push("alt");
      if (e.shiftKey) mods.push("shift");
      if (e.metaKey) mods.push("meta");

      // Map special keys
      let mappedKey = key;
      if (key === " ") mappedKey = "Space";
      if (key === "ArrowUp") mappedKey = "Up";
      if (key === "ArrowDown") mappedKey = "Down";
      if (key === "ArrowLeft") mappedKey = "Left";
      if (key === "ArrowRight") mappedKey = "Right";

      // Update the hotkey
      const updated = hotkeys.map((h) =>
        h.id === id ? { ...h, key: mappedKey, modifiers: mods } : h
      );

      setHotkeys(updated);
      setEditingId(null);
      setListeningKey(false);
      document.removeEventListener("keydown", handler);
      saveHotkeys(updated);

      // Re-register global hotkey if needed
      const entry = updated.find((h) => h.id === id);
      if (entry && entry.isGlobal) {
        invoke("register_hotkey", {
          hotkeyId: entry.id,
          key: mappedKey,
          modifiers: mods,
          action: entry.action,
        }).catch(console.error);
      }
    };

    document.addEventListener("keydown", handler);
    // Auto-cancel after 5 seconds
    setTimeout(() => {
      document.removeEventListener("keydown", handler);
      setEditingId(null);
      setListeningKey(false);
    }, 5000);
  }, [hotkeys, saveHotkeys]);

  const toggleGlobal = useCallback(async (id: string) => {
    const updated = hotkeys.map((h) => {
      if (h.id !== id) return h;
      const newGlobal = !h.isGlobal;
      if (!newGlobal) {
        // Unregister
        invoke("unregister_hotkey", {
          key: h.key,
          modifiers: h.modifiers,
        }).catch(console.error);
      } else {
        // Register
        invoke("register_hotkey", {
          hotkeyId: h.id,
          key: h.key,
          modifiers: h.modifiers,
          action: h.action,
        }).catch(console.error);
      }
      return { ...h, isGlobal: newGlobal };
    });
    setHotkeys(updated);
    await saveHotkeys(updated);
  }, [hotkeys, saveHotkeys]);

  const formatShortcut = (hk: HotkeyEntry): string => {
    const parts: string[] = [];
    if (hk.modifiers.includes("ctrl")) parts.push("Ctrl");
    if (hk.modifiers.includes("alt")) parts.push("Alt");
    if (hk.modifiers.includes("shift")) parts.push("Shift");
    if (hk.modifiers.includes("meta")) parts.push("Win");
    parts.push(hk.key);
    return parts.join(" + ");
  };

  return (
    <div className="hotkey-settings">
      <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 8, color: "var(--text-secondary)" }}>
        Keyboard Shortcuts
      </div>

      {/* Note about Spacebar */}
      <div style={{
        fontSize: 11,
        color: "var(--text-tertiary)",
        marginBottom: 12,
        padding: "6px 10px",
        background: "rgba(233, 69, 96, 0.06)",
        borderRadius: "var(--radius-sm)",
        lineHeight: 1.5,
      }}>
        <strong>Tip:</strong> Spacebar always works as Play/Pause when the app is focused,
        regardless of settings below. Media keys (▶⏸ ⏭ ⏮) on your keyboard also work globally.
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {hotkeys.map((hk) => (
          <div
            key={hk.id}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "6px 10px",
              borderRadius: "var(--radius-sm)",
              background: editingId === hk.id
                ? "rgba(233, 69, 96, 0.1)"
                : "transparent",
              border: editingId === hk.id
                ? "1px solid var(--accent-primary)"
                : "1px solid transparent",
              transition: "all 0.15s",
            }}
          >
            {/* Label */}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, color: "var(--text-primary)" }}>
                {hk.label}
              </div>
              <div style={{ fontSize: 10, color: "var(--text-tertiary)" }}>
                {hk.description}
              </div>
            </div>

            {/* Shortcut display / edit button */}
            <button
              className="hotkey-input-btn"
              onClick={() => startListening(hk.id)}
              style={{
                padding: "4px 10px",
                fontSize: 12,
                fontFamily: "var(--font-mono, monospace)",
                border: "1px solid var(--border-color)",
                borderRadius: "var(--radius-sm)",
                background: editingId === hk.id
                  ? "var(--accent-primary)"
                  : "var(--bg-tertiary)",
                color: editingId === hk.id ? "#fff" : "var(--text-secondary)",
                cursor: "pointer",
                minWidth: 120,
                textAlign: "center",
                transition: "all 0.15s",
              }}
            >
              {editingId === hk.id
                ? listeningKey
                  ? "Listening..."
                  : formatShortcut(hk)
                : formatShortcut(hk)}
            </button>

            {/* Global toggle */}
            <label
              title={hk.isGlobal ? "Works even when app is in background" : "Only works when app is focused"}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 4,
                cursor: "pointer",
                fontSize: 10,
                color: hk.isGlobal ? "var(--accent-primary)" : "var(--text-tertiary)",
              }}
            >
              <input
                type="checkbox"
                checked={hk.isGlobal}
                onChange={() => toggleGlobal(hk.id)}
                style={{ cursor: "pointer" }}
              />
              Global
            </label>
          </div>
        ))}
      </div>

      <div style={{ fontSize: 10, color: "var(--text-tertiary)", marginTop: 10, opacity: 0.6 }}>
        Click a shortcut button, then press the desired key combination.
        <br />
        "Global" shortcuts work even when NeedMusic is minimized or in the background.
      </div>
    </div>
  );
};

export default HotkeySettings;
export type { HotkeyEntry };
