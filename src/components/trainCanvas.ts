import type { Map as MapLibreMap, MapMouseEvent } from 'maplibre-gl';
import { contrastInk } from '../data/trainService';
import { stadiumEdgePoint, TRAIN_ARROW_INSET_PX } from '../data/trainPill';

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
}

const PILL_HEIGHT = 14;
const PILL_PADDING_X = 6;
const FONT = '700 10px Geist, Inter, system-ui, sans-serif';
const ARROW_SIZE = 12;
/** Extra pixels around each pill that still count as a hit (fingers need more). */
const HIT_PAD_MOUSE = 9;
const HIT_PAD_TOUCH = 14;

type Sprite = { canvas: HTMLCanvasElement; width: number; height: number; pillWidth: number };

export class TrainCanvasLayer {
  private map: MapLibreMap;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private pills: CanvasPill[] = [];
  private sprites = new Map<string, Sprite>();
  private hovered: string | null = null;
  private dpr = 1;
  private frame = 0;
  private boxes: Array<{ id: string; x: number; y: number; w: number; h: number; label: string }> = [];
  private onPick: (id: string) => void;
  private coarsePointer = false;
  private downAt: { x: number; y: number } | null = null;

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
      this.sprites.clear();
      this.requestDraw();
    });
    this.handleResize();
  }

  setPills(pills: CanvasPill[]) {
    this.pills = pills;
    this.requestDraw();
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

  private handleResize = () => {
    const container = this.map.getContainer();
    this.dpr = Math.min(3, window.devicePixelRatio || 1);
    const width = container.clientWidth;
    const height = container.clientHeight;
    this.canvas.width = Math.round(width * this.dpr);
    this.canvas.height = Math.round(height * this.dpr);
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    this.sprites.clear();
    this.requestDraw();
  };

  private handleMove = (event: MapMouseEvent) => {
    const id = this.hit(event.point.x, event.point.y);
    if (id !== this.hovered) {
      if (!id && this.hovered) {
        this.map.getCanvas().style.cursor = '';
      }
      this.hovered = id;
      this.requestDraw();
    }
    if (id) {
      this.map.getCanvas().style.cursor = 'pointer';
    }
  };

  private handleLeave = () => {
    if (this.hovered) {
      this.hovered = null;
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
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(width * this.dpr);
    canvas.height = Math.ceil(height * this.dpr);
    const ctx = canvas.getContext('2d')!;
    ctx.scale(this.dpr, this.dpr);
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
    const sprite = { canvas, width, height, pillWidth };
    this.sprites.set(key, sprite);
    return sprite;
  }

  private draw() {
    const ctx = this.ctx;
    const { width, height } = this.canvas;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const viewWidth = width / this.dpr;
    const viewHeight = height / this.dpr;
    const boxes: typeof this.boxes = [];
    // Selected and hovered pills are drawn last so they sit on top.
    const ordered = [...this.pills].sort(
      (left, right) =>
        Number(left.selected) - Number(right.selected) ||
        Number(left.id === this.hovered) - Number(right.id === this.hovered)
    );
    for (const pill of ordered) {
      const point = this.map.project([pill.lng, pill.lat]);
      if (point.x < -40 || point.y < -40 || point.x > viewWidth + 40 || point.y > viewHeight + 40) {
        continue;
      }
      const hovered = pill.id === this.hovered;
      const sprite = this.sprite(pill, hovered);
      const cx = Math.round(point.x);
      const cy = Math.round(point.y);
      if (pill.heading != null) {
        const { x, y } = stadiumEdgePoint(sprite.pillWidth, PILL_HEIGHT, pill.heading, TRAIN_ARROW_INSET_PX);
        ctx.save();
        ctx.translate(cx + x, cy + y);
        ctx.rotate((pill.heading * Math.PI) / 180);
        ctx.beginPath();
        ctx.moveTo(0, -ARROW_SIZE);
        ctx.lineTo(ARROW_SIZE / 2, 0);
        ctx.lineTo(-ARROW_SIZE / 2, 0);
        ctx.closePath();
        ctx.fillStyle = '#fff';
        ctx.fill();
        ctx.restore();
      }
      ctx.drawImage(sprite.canvas, cx - sprite.width / 2, cy - sprite.height / 2, sprite.width, sprite.height);
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
  }
}
