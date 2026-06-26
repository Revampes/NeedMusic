import React from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { IconMusic, IconWinMin, IconWinMax, IconClose } from "@ui/components/Icons";

/**
 * CustomTitleBar — replaces native window decorations with a styled
 * drag region containing the app name and window controls.
 */
const CustomTitleBar: React.FC = () => {
  const win = getCurrentWindow();

  return (
    <div className="title-bar" data-tauri-drag-region>
      <div className="title-bar-label"><IconMusic size={13} style={{ marginRight: 4 }} />NeedMusic</div>
      <div className="title-bar-controls">
        <button className="title-btn" onClick={() => win.minimize()} title="Minimize"><IconWinMin size={12} /></button>
        <button className="title-btn" onClick={() => win.toggleMaximize()} title="Maximize"><IconWinMax size={12} /></button>
        <button className="title-btn title-btn-close" onClick={() => win.close()} title="Close"><IconClose size={12} /></button>
      </div>
    </div>
  );
};

export default CustomTitleBar;
