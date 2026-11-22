import type { Map as MapLibreMap, MapMouseEvent } from 'maplibre-gl';
import { contrastInk } from '../data/trainService';
import { stadiumEdgePoint, TRAIN_ARROW_INSET_PX } from '../data/trainPill';
import { RENDER_PIXEL_RATIO } from '../perf';
import { screenProjection } from '../data/screenProjection';
import { PERF_HUD, perfAdd, perfSet } from '../perfHud';

/**
 * Train pills drawn on one canvas above the map.
 *
 * ~120 DOM markers made Chrome recompute style and layout for every marker on
 * every map frame (pans ran at ~12 fps); one canvas redrawn on the map's own
 * render event costs a millisecond or two. Pills keep the old look: a stadium
 * in the delay colour with a white rim, the train type in Geist, and a white
 * heading arrow tucked under the edge.
 */

export interface CanvasPill {
  id: string;
  lng: number;
  lat: number;
  type: string;
  color: string;
  selected: boolean;
  heading: number | null;
  label: string;
  /** Drawn as a small dot, with no arrow and no label (crowded buses, trams and metro seen from afar). */
  dot?: boolean;
  /** Where the train really is, before overlapping pills were pushed apart (lng/lat is where it is drawn). */
  homeLng?: number;
  homeLat?: number;
}

export const PILL_HEIGHT = 14;
const PILL_PADDING_X = 6;
const FONT = '700 10px Geist, Inter, system-ui, sans-serif';
const ARROW_SIZE = 12;
/** Arrows are pre-drawn in this many degrees per step (36 sprites), not rotated per pill per frame. */
const ARROW_STEP_DEG = 10;
const ARROW_STEPS = 360 / ARROW_STEP_DEG;
/** Arrow sprite box (CSS px), anchored at its centre where the arrow's base sits. */
const ARROW_BOX = ARROW_SIZE * 2 + 2;
/** Extra pixels around each pill that still count as a hit (fingers need more). */
const DOT_RADIUS = 2.4;
const HIT_PAD_MOUSE = 9;
const HIT_PAD_TOUCH = 14;
/** How quickly pills settle after a neighbour moved them (time constant, seconds). */
const SPREAD_EASE_SECONDS = 0.055;

/**
 * Every pill and arrow is painted once into one shared atlas canvas and copied from there.
 * Separate tiny canvases per sprite are not GPU-backed on Android Chrome, so each frame had to
 * upload a couple of hundred little bitmaps; one big atlas is a single GPU texture.
 */
const ATLAS_CSS_WIDTH = 512;
const ATLAS_CSS_HEIGHT = 1024;
const ATLAS_GAP = 2;

/** A cell in the atlas (device px), valid while `gen` matches the atlas generation. */
type AtlasImage = { sx: number; sy: number; sw: number; sh: number; gen: number };
type Sprite = AtlasImage & { width: number; height: number; pillWidth: number };

export class TrainCanvasLayer {
  private map: MapLibreMap;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private pills: CanvasPill[] = [];
  /** Draw order (selected and hovered last), rebuilt only when pills, selection or hover change. */
  private ordered: CanvasPill[] = [];
  private sprites = new Map<string, Sprite>();
  private arrows = new Map<number, AtlasImage>();
  private atlas: { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D; x: number; y: number; row: number } | null = null;
  private atlasGen = 0;
  private hovered: string | null = null;
  private dpr = 1;
  private frame = 0;
  private boxes: Array<{ id: string; x: number; y: number; w: number; h: number; label: string }> = [];
  private onPick: (id: string) => void;
  private coarsePointer = false;
  private downAt: { x: number; y: number } | null = null;
  /** How far each pill is currently shown from its true spot (degrees), eased towards its target. */
  private shown = new Map<string, { dLng: number; dLat: number }>();
  private lastDrawMs = 0;

  constructor(map: MapLibreMap, onPick: (id: string) => void) {
    this.map = map;
    this.onPick = onPick;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'train-canvas';
    this.canvas.setAttribute('aria-hidden', 'true');
    Object.assign(this.canvas.style, {
      position: 'absolute',
      left: '0',
      top: '0',
      pointerEvents: 'none',
      zIndex: '2',
    });
    map.getContainer().appendChild(this.canvas);
    const ctx = this.canvas.getContext('2d');
    if (!ctx) {
      throw new Error('2D canvas unavailable');
    }
    this.ctx = ctx;
    try {
      this.coarsePointer = window.matchMedia('(pointer: coarse)').matches;
    } catch {
      this.coarsePointer = false;
    }
    map.on('render', this.handleRender);
    map.on('resize', this.handleResize);
    map.on('mousemove', this.handleMove);
    map.getContainer().addEventListener('pointerdown', this.handleDown, true);
    map.getContainer().addEventListener('click', this.handleClick, true);
    map.getContainer().addEventListener('mouseleave', this.handleLeave);
    // Re-draw once the web font is ready so the labels use Geist.
    document.fonts?.ready.then(() => {
      this.resetAtlas();
      this.requestDraw();
    });
    this.handleResize();
  }

  setPills(pills: CanvasPill[]) {
    this.pills = pills;
    const ids = new Set<string>();
    pills.forEach((pill) => {
      ids.add(pill.id);
      if (!this.shown.has(pill.id)) {
        // First sight: no easing, it simply appears where it belongs.
        this.shown.set(pill.id, {
          dLng: pill.lng - (pill.homeLng ?? pill.lng),
          dLat: pill.lat - (pill.homeLat ?? pill.lat),
        });
      }
    });
    this.shown.forEach((_, id) => {
      if (!ids.has(id)) {
        this.shown.delete(id);
      }
    });
    this.reorder();
    this.requestDraw();
  }

  private reorder() {
    this.ordered = [...this.pills].sort(
      (left, right) =>
        // dots first: they sit beneath every pill
        Number(Boolean(right.dot && !right.selected)) - Number(Boolean(left.dot && !left.selected)) ||
        Number(left.selected) - Number(right.selected) ||
        Number(left.id === this.hovered) - Number(right.id === this.hovered)
    );
  }

  destroy() {
    this.map.off('render', this.handleRender);
    this.map.off('resize', this.handleResize);
    this.map.off('mousemove', this.handleMove);
    this.map.getContainer().removeEventListener('pointerdown', this.handleDown, true);
    this.map.getContainer().removeEventListener('click', this.handleClick, true);
    this.map.getContainer().removeEventListener('mouseleave', this.handleLeave);
    if (this.frame) {
      cancelAnimationFrame(this.frame);
    }
    this.canvas.remove();
  }

  /** Train under a screen point (container pixels), if any. */
  hit(x: number, y: number): string | null {
    const pad = this.coarsePointer ? HIT_PAD_TOUCH : HIT_PAD_MOUSE;
    let best: string | null = null;
    let bestDistance = Infinity;
    // Topmost first: boxes are stored in draw order.
    for (let index = this.boxes.length - 1; index >= 0; index -= 1) {
      const box = this.boxes[index];
      if (
        x >= box.x - pad &&
        x <= box.x + box.w + pad &&
        y >= box.y - pad &&
        y <= box.y + box.h + pad
      ) {
        const cx = box.x + box.w / 2;
        const cy = box.y + box.h / 2;
        const distance = Math.hypot(cx - x, cy - y);
        // Inside the pill itself wins outright; otherwise the nearest padded box.
        if (x >= box.x && x <= box.x + box.w && y >= box.y && y <= box.y + box.h) {
          return box.id;
        }
        if (distance < bestDistance) {
          bestDistance = distance;
          best = box.id;
        }
      }
    }
    return best;
  }

  private handleRender = () => {
    this.draw();
  };

  private draw() {
    if (!PERF_HUD) {
      this.paint();
      return;
    }
    const start = performance.now();
    this.paint();
    perfAdd('pills', performance.now() - start);
    perfSet('drawn', this.boxes.length);
  }

  private handleResize = () => {
    const container = this.map.getContainer();
    this.dpr = RENDER_PIXEL_RATIO;
    const width = container.clientWidth;
    const height = container.clientHeight;
    this.canvas.width = Math.round(width * this.dpr);
    this.canvas.height = Math.round(height * this.dpr);
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    this.resetAtlas();
    this.requestDraw();
  };

  private handleMove = (event: MapMouseEvent) => {
    const id = this.hit(event.point.x, event.point.y);
    if (id !== this.hovered) {
      if (!id && this.hovered) {
        this.map.getCanvas().style.cursor = '';
      }
      this.hovered = id;
      this.reorder();
      this.requestDraw();
    }
    if (id) {
      this.map.getCanvas().style.cursor = 'pointer';
    }
  };

  private handleLeave = () => {
    if (this.hovered) {
      this.hovered = null;
      this.reorder();
      this.requestDraw();
    }
  };

  private handleDown = (event: PointerEvent) => {
    this.downAt = { x: event.clientX, y: event.clientY };
  };

  private handleClick = (event: MouseEvent) => {
    // A click that ends a map drag is not a pick.
    if (this.downAt && Math.hypot(event.clientX - this.downAt.x, event.clientY - this.downAt.y) > 6) {
      return;
    }
    const rect = this.map.getContainer().getBoundingClientRect();
    const id = this.hit(event.clientX - rect.left, event.clientY - rect.top);
    if (!id) {
      return;
    }
    // A train under the pointer wins over the map's own click (stations, background).
    event.stopPropagation();
    event.preventDefault();
    this.onPick(id);
  };

  private requestDraw() {
    if (this.frame) {
      return;
    }
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.draw();
    });
  }

  /**
   * Reserve a cell in the atlas (device px) and set `ctx` up to paint into it in CSS px. A full
   * atlas is wiped and every cached sprite dropped (`atlasGen` moves on); callers holding a
   * sprite from before must fetch it again.
   */
  private atlasCell(cssWidth: number, cssHeight: number): { ctx: CanvasRenderingContext2D; sx: number; sy: number; sw: number; sh: number } {
    const sw = Math.ceil(cssWidth * this.dpr);
    const sh = Math.ceil(cssHeight * this.dpr);
    if (!this.atlas) {
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(ATLAS_CSS_WIDTH * this.dpr);
      canvas.height = Math.ceil(ATLAS_CSS_HEIGHT * this.dpr);
      this.atlas = { canvas, ctx: canvas.getContext('2d')!, x: 0, y: 0, row: 0 };
    }
    let atlas = this.atlas;
    if (atlas.x + sw > atlas.canvas.width) {
      atlas.x = 0;
      atlas.y += atlas.row + ATLAS_GAP;
      atlas.row = 0;
    }
    if (atlas.y + sh > atlas.canvas.height) {
      // Full (rare: only many distinct types/colours/headings over a long session): start over.
      atlas.ctx.setTransform(1, 0, 0, 1, 0, 0);
      atlas.ctx.clearRect(0, 0, atlas.canvas.width, atlas.canvas.height);
      atlas.x = 0;
      atlas.y = 0;
      atlas.row = 0;
      this.sprites.clear();
      this.arrows.clear();
      this.atlasGen += 1;
      atlas = this.atlas;
    }
    const sx = atlas.x;
    const sy = atlas.y;
    atlas.x += sw + ATLAS_GAP;
    atlas.row = Math.max(atlas.row, sh);
    const ctx = atlas.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.save();
    ctx.beginPath();
    ctx.rect(sx, sy, sw, sh);
    ctx.clip();
    ctx.translate(sx, sy);
    ctx.scale(sw / cssWidth, sh / cssHeight);
    return { ctx, sx, sy, sw, sh };
  }

  private resetAtlas() {
    this.atlas = null;
    this.sprites.clear();
    this.arrows.clear();
    this.atlasGen += 1;
  }

  /** White heading arrow for one 10° step, base at the sprite's centre, tip pointing along the heading. */
  private arrowSprite(step: number): AtlasImage {
    const cached = this.arrows.get(step);
    if (cached) {
      return cached;
    }
    const { ctx, sx, sy, sw, sh } = this.atlasCell(ARROW_BOX, ARROW_BOX);
    ctx.translate(ARROW_BOX / 2, ARROW_BOX / 2);
    ctx.rotate((step * ARROW_STEP_DEG * Math.PI) / 180);
    ctx.beginPath();
    ctx.moveTo(0, -ARROW_SIZE);
    ctx.lineTo(ARROW_SIZE / 2, 0);
    ctx.lineTo(-ARROW_SIZE / 2, 0);
    ctx.closePath();
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.restore();
    const arrow = { sx, sy, sw, sh, gen: this.atlasGen };
    this.arrows.set(step, arrow);
    return arrow;
  }

  private sprite(pill: CanvasPill, hovered: boolean): Sprite {
    const key = `${pill.type}|${pill.color}|${pill.selected ? 1 : 0}|${hovered ? 1 : 0}|${this.dpr}`;
    const cached = this.sprites.get(key);
    if (cached) {
      return cached;
    }
    const measure = this.ctx;
    measure.font = FONT;
    const textWidth = Math.ceil(measure.measureText(pill.type).width);
    const pillWidth = Math.max(PILL_HEIGHT + 4, textWidth + PILL_PADDING_X * 2);
    const ring = pill.selected ? 6 : hovered ? 4 : 0;
    const shadow = 4;
    const margin = ring + shadow + 2;
    const width = pillWidth + margin * 2;
    const height = PILL_HEIGHT + margin * 2;
    const { ctx, sx, sy, sw, sh } = this.atlasCell(width, height);
    const x = margin;
    const y = margin;
    const r = PILL_HEIGHT / 2;
    const stadium = (inflate: number) => {
      ctx.beginPath();
      ctx.roundRect(x - inflate, y - inflate, pillWidth + inflate * 2, PILL_HEIGHT + inflate * 2, r + inflate);
    };
    // soft drop shadow
    ctx.save();
    ctx.shadowColor = 'rgba(0, 0, 0, 0.35)';
    ctx.shadowBlur = pill.selected ? 8 : 3;
    ctx.shadowOffsetY = 1;
    stadium(0);
    ctx.fillStyle = pill.color;
    ctx.fill();
    ctx.restore();
    if (ring > 0) {
      stadium(pill.selected ? 5 : 3);
      ctx.fillStyle = pill.selected ? 'rgba(255, 255, 255, 0.34)' : 'rgba(255, 255, 255, 0.22)';
      ctx.fill();
      stadium(pill.selected ? 2 : 1);
      ctx.fillStyle = '#fff';
      ctx.fill();
    }
    stadium(0);
    ctx.fillStyle = pill.color;
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = '#fff';
    ctx.beginPath();
    ctx.roundRect(x + 0.5, y + 0.5, pillWidth - 1, PILL_HEIGHT - 1, r - 0.5);
    ctx.stroke();
    ctx.font = FONT;
    ctx.fillStyle = contrastInk(pill.color);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(pill.type, x + pillWidth / 2, y + PILL_HEIGHT / 2 + 0.5);
    ctx.restore();
    const sprite = { sx, sy, sw, sh, gen: this.atlasGen, width, height, pillWidth };
    this.sprites.set(key, sprite);
    return sprite;
  }

  private paint() {
    const ctx = this.ctx;
    const { width, height } = this.canvas;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const viewWidth = width / this.dpr;
    const viewHeight = height / this.dpr;
    const boxes: typeof this.boxes = [];
    // Pills pushed apart by their neighbours glide to their new spot instead of jumping there.
    const now = performance.now();
    const dt = Math.min(0.1, Math.max(0, (now - (this.lastDrawMs || now)) / 1000));
    this.lastDrawMs = now;
    const ease = 1 - Math.exp(-dt / SPREAD_EASE_SECONDS);
    let settling = false;
    const projection = screenProjection(this.map);
    const degPerPx = 360 / projection.scale;
    // Selected and hovered pills are drawn last so they sit on top.
    for (const pill of this.ordered) {
      const home = { lng: pill.homeLng ?? pill.lng, lat: pill.homeLat ?? pill.lat };
      const target = { dLng: pill.lng - home.lng, dLat: pill.lat - home.lat };
      let offset = this.shown.get(pill.id);
      if (!offset) {
        offset = { ...target };
        this.shown.set(pill.id, offset);
      }
      offset.dLng += (target.dLng - offset.dLng) * ease;
      offset.dLat += (target.dLat - offset.dLat) * ease;
      if (Math.abs(target.dLng - offset.dLng) > degPerPx * 0.25 || Math.abs(target.dLat - offset.dLat) > degPerPx * 0.25) {
        settling = true;
      } else {
        offset.dLng = target.dLng;
        offset.dLat = target.dLat;
      }
      const px = projection.projectX(home.lng + offset.dLng);
      if (px < -40 || px > viewWidth + 40) {
        continue;
      }
      const py = projection.projectY(home.lat + offset.dLat);
      if (py < -40 || py > viewHeight + 40) {
        continue;
      }
      const hovered = pill.id === this.hovered;
      const cx = Math.round(px);
      const cy = Math.round(py);
      if (pill.dot && !pill.selected) {
        // a tiny black dot with a white rim, like the pills in miniature
        const radius = DOT_RADIUS;
        ctx.save();
        ctx.beginPath();
        ctx.arc(cx, cy, radius, 0, Math.PI * 2);
        ctx.shadowColor = 'rgba(0, 0, 0, 0.35)';
        ctx.shadowBlur = 2;
        ctx.fillStyle = pill.color;
        ctx.fill();
        ctx.restore();
        ctx.beginPath();
        ctx.arc(cx, cy, radius - 0.5, 0, Math.PI * 2);
        ctx.lineWidth = 1;
        ctx.strokeStyle = '#fff';
        ctx.stroke();
        // not selectable, not hoverable: no hit box
        continue;
      }
      let sprite = this.sprite(pill, hovered);
      if (pill.heading != null && Number.isFinite(pill.heading)) {
        const step = ((Math.round(pill.heading / ARROW_STEP_DEG) % ARROW_STEPS) + ARROW_STEPS) % ARROW_STEPS;
        const arrow = this.arrowSprite(step);
        if (sprite.gen !== this.atlasGen) {
          // The arrow filled the atlas and wiped it: paint the pill again.
          sprite = this.sprite(pill, hovered);
        }
        const { x, y } = stadiumEdgePoint(sprite.pillWidth, PILL_HEIGHT, step * ARROW_STEP_DEG, TRAIN_ARROW_INSET_PX);
        ctx.drawImage(
          this.atlas!.canvas,
          arrow.sx,
          arrow.sy,
          arrow.sw,
          arrow.sh,
          Math.round(cx + x - ARROW_BOX / 2),
          Math.round(cy + y - ARROW_BOX / 2),
          ARROW_BOX,
          ARROW_BOX
        );
      }
      ctx.drawImage(
        this.atlas!.canvas,
        sprite.sx,
        sprite.sy,
        sprite.sw,
        sprite.sh,
        cx - sprite.width / 2,
        cy - sprite.height / 2,
        sprite.width,
        sprite.height
      );
      boxes.push({
        id: pill.id,
        x: cx - sprite.pillWidth / 2,
        y: cy - PILL_HEIGHT / 2,
        w: sprite.pillWidth,
        h: PILL_HEIGHT,
        label: pill.label,
      });
    }
    this.boxes = boxes;
    if (settling) {
      this.requestDraw();
    } else {
      this.lastDrawMs = 0;
    }
  }
}
