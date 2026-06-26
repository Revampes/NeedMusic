/**
 * CustomContextMenu — OOP context menu manager that renders native-feeling
 * right-click menus and handles boundary detection to prevent off-screen clipping.
 *
 * Design Pattern: Singleton
 */
export interface ContextMenuItem {
  id: string;
  label: string;
  shortcut?: string;
  disabled?: boolean;
  danger?: boolean;
  icon?: string;
  separator?: false;
}

export interface ContextMenuSeparator {
  separator: true;
}

export type ContextMenuEntry = ContextMenuItem | ContextMenuSeparator;

export class CustomContextMenu {
  private static instance: CustomContextMenu | null = null;
  private container: HTMLDivElement | null = null;
  private isOpen: boolean = false;
  private onSelectCallback: ((id: string) => void) | null = null;

  private constructor() {}

  static getInstance(): CustomContextMenu {
    if (!CustomContextMenu.instance) {
      CustomContextMenu.instance = new CustomContextMenu();
    }
    return CustomContextMenu.instance;
  }

  /**
   * Show a context menu at the given coordinates.
   * Automatically adjusts position to stay within window bounds.
   */
  show(
    x: number,
    y: number,
    items: ContextMenuEntry[],
    onSelect: (id: string) => void
  ): void {
    this.close();

    this.onSelectCallback = onSelect;
    this.container = document.createElement("div");
    this.container.className = "ctx-menu";
    this.container.style.position = "fixed";
    this.container.style.zIndex = "99999";
    this.container.style.minWidth = "180px";
    this.container.style.background = "#252525";
    this.container.style.border = "1px solid #3a3a3a";
    this.container.style.borderRadius = "8px";
    this.container.style.padding = "4px";
    this.container.style.boxShadow = "0 8px 32px rgba(0,0,0,0.5)";
    this.container.style.backdropFilter = "blur(12px)";
    this.container.style.fontFamily = "system-ui, sans-serif";
    this.container.style.fontSize = "13px";
    this.container.style.userSelect = "none";

    for (const entry of items) {
      if ("separator" in entry && entry.separator) {
        const sep = document.createElement("div");
        sep.style.height = "1px";
        sep.style.background = "#3a3a3a";
        sep.style.margin = "4px 8px";
        this.container.appendChild(sep);
        continue;
      }

      const item = entry as ContextMenuItem;
      const el = document.createElement("div");
      el.className = "ctx-menu-item";
      el.textContent = item.label;
      el.style.padding = "6px 12px";
      el.style.borderRadius = "4px";
      el.style.cursor = item.disabled ? "default" : "pointer";
      el.style.color = item.disabled ? "#555" : item.danger ? "#e94560" : "#ccc";
      el.style.display = "flex";
      el.style.justifyContent = "space-between";
      el.style.alignItems = "center";

      if (item.shortcut) {
        const shortcut = document.createElement("span");
        shortcut.textContent = item.shortcut;
        shortcut.style.fontSize = "11px";
        shortcut.style.color = "#666";
        shortcut.style.marginLeft = "24px";
        el.appendChild(shortcut);
      }

      if (!item.disabled) {
        el.addEventListener("mouseenter", () => {
          el.style.background = item.danger ? "rgba(233,69,96,0.2)" : "rgba(15,52,96,0.5)";
        });
        el.addEventListener("mouseleave", () => {
          el.style.background = "transparent";
        });
        el.addEventListener("click", () => {
          this.onSelectCallback?.(item.id);
          this.close();
        });
      }

      this.container.appendChild(el);
    }

    document.body.appendChild(this.container);

    // ── Boundary Detection ─────────────────────────────
    const rect = this.container.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let posX = x;
    let posY = y;

    if (posX + rect.width > vw) {
      posX = vw - rect.width - 8;
    }
    if (posY + rect.height > vh) {
      posY = vh - rect.height - 8;
    }
    if (posX < 0) posX = 8;
    if (posY < 0) posY = 8;

    this.container.style.left = `${posX}px`;
    this.container.style.top = `${posY}px`;

    this.isOpen = true;

    // Close on outside click.
    const closeHandler = (e: MouseEvent) => {
      if (this.container && !this.container.contains(e.target as Node)) {
        this.close();
        document.removeEventListener("click", closeHandler);
      }
    };
    setTimeout(() => document.addEventListener("click", closeHandler), 0);

    // Close on Escape.
    const escHandler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        this.close();
        document.removeEventListener("keydown", escHandler);
      }
    };
    document.addEventListener("keydown", escHandler);
  }

  close(): void {
    if (this.container) {
      this.container.remove();
      this.container = null;
    }
    this.isOpen = false;
    this.onSelectCallback = null;
  }

  get opened(): boolean {
    return this.isOpen;
  }
}
