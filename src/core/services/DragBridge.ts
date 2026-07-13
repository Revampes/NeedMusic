/**
 * DragBridge — shared module for track-to-queue drag operations.
 *
 * Tauri/WebView2 cancels HTML5 DnD immediately (dragEnd fires right after
 * dragStart), so we use mouse events (mousedown → mousemove → mouseup)
 * as the primary drag mechanism.  The HTML5 handlers remain as a fallback
 * for environments where they work (e.g. regular browsers in the web build).
 */

const DRAG_THRESHOLD = 4; // px of movement before we consider it a drag (vs click)

let _trackId: string | null = null;
let _startX = 0;
let _startY = 0;
let _dragging = false;
let _mouseDragActive = false; // guards against HTML5 dragEnd resetting mouse drag state

function reset(): void {
  _trackId = null;
  _dragging = false;
  _mouseDragActive = false;
  document.body.classList.remove("nm-dragging");
}

export const DragBridge = {
  // ── HTML5 DnD API (kept as fallback) ──

  setDraggedTrackId(id: string): void {
    // Only set if no mouse drag is active (HTML5 DnD is secondary)
    if (!_mouseDragActive) _trackId = id;
  },

  takeDraggedTrackId(): string | null {
    if (_mouseDragActive) return null; // defer to endMouseDrag
    const id = _trackId;
    reset();
    return id;
  },

  /** Clear HTML5 DnD state — does NOT interfere with active mouse drags. */
  clear(): void {
    if (!_mouseDragActive) reset();
  },

  // ── Mouse-event-based drag API ──

  /** Call on mousedown of a draggable track row. */
  startMouseDrag(trackId: string, clientX: number, clientY: number): void {
    _trackId = trackId;
    _startX = clientX;
    _startY = clientY;
    _dragging = false;
    _mouseDragActive = true; // lock out HTML5 DnD from interfering
  },

  /** Call on mousemove (delegated globally while a drag may be in progress). */
  onMouseMove(clientX: number, clientY: number): void {
    if (_trackId === null || _dragging || !_mouseDragActive) return;
    const dx = clientX - _startX;
    const dy = clientY - _startY;
    if (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD) {
      _dragging = true;
      document.body.classList.add("nm-dragging");
    }
  },

  /** Returns true when a mouse drag is active. */
  get isDragging(): boolean {
    return _dragging;
  },

  /** Returns the track ID if a drag is active, null otherwise. */
  get draggedTrackId(): string | null {
    return _dragging ? _trackId : null;
  },

  /** Call on mouseup to end any active drag and get the track ID (if dragging). */
  endMouseDrag(): string | null {
    const id = _dragging ? _trackId : null;
    reset();
    return id;
  },
};
