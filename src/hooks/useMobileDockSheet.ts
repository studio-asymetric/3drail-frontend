import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';

const FLICK_CLOSE_VELOCITY = 0.42;
const FLICK_OPEN_VELOCITY = -0.42;
const LIST_TOP_EPSILON = 2;
/**
 * Two timeline rows (40 px each) plus the list's own border (1), top padding (13) and the
 * stops' top padding (4): the collapsed list runs straight to the sheet's bottom edge.
 */
const COLLAPSED_LIST_PX = 98;
const LIST_SCROLL_SLOP_PX = 6;
/** Sheet height progress above this reveals list content while dragging open. */
export const SHEET_CONTENT_REVEAL = 0.08;
/** Space around the two departures a station shows when collapsed (px). */
const STATION_ROWS_GAP_PX = 40;

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function easeOutCubic(t: number) {
  return 1 - Math.pow(1 - t, 3);
}

export type DockListPointerHandoff = {
  onPointerDown: (event: React.PointerEvent<HTMLElement>) => void;
  onPointerMove: (event: React.PointerEvent<HTMLElement>) => void;
  onPointerUp: (event: React.PointerEvent<HTMLElement>) => void;
  onPointerCancel: (event: React.PointerEvent<HTMLElement>) => void;
};

type PointerGesture = DockListPointerHandoff;

export function useMobileDockSheet(
  enabled: boolean,
  expanded: boolean,
  onExpandedChange: (next: boolean) => void
) {
  const dockRef = useRef<HTMLElement | null>(null);
  const metricsRef = useRef({ collapsed: 128, expanded: 480, travel: 352 });
  const progressRef = useRef(expanded ? 1 : 0);
  const dragRef = useRef<{
    pointerY: number;
    startProgress: number;
    lastY: number;
    lastT: number;
    velocity: number;
  } | null>(null);
  const settleRafRef = useRef(0);
  const skipExpandedSyncRef = useRef(false);
  const suppressPeekClickRef = useRef(false);
  /** A press that began on the grab handle: a short, still one is a tap that toggles the sheet. */
  const handleTapRef = useRef<{ y: number; t: number; from: number } | null>(null);
  const captureElRef = useRef<HTMLElement | null>(null);
  const pendingListRef = useRef<{ startY: number; pointerId: number } | null>(null);
  /** A touch that began on the (not yet scrollable) list of a collapsed sheet: becomes a drag once it moves. */
  const pendingCollapsedRef = useRef<{ startY: number; pointerId: number; element: HTMLElement } | null>(null);
  const stopWatchingRef = useRef<(() => void) | null>(null);
  const [progress, setProgress] = useState(expanded ? 1 : 0);
  const [dragging, setDragging] = useState(false);
  const [settling, setSettling] = useState(false);
  const [listAtTop, setListAtTop] = useState(true);
  /** Bumped when the measured sheet heights change, so the height style is recomputed. */
  const [, setMetricsVersion] = useState(0);

  const applyProgress = useCallback(
    (value: number) => {
      const next = clamp(value, 0, 1);
      const prev = progressRef.current;
      progressRef.current = next;
      setProgress(next);
      if (!enabled) {
        return;
      }
      const wasOpen = prev >= 0.5;
      const isOpen = next >= 0.5;
      if (wasOpen !== isOpen && dragRef.current) {
        skipExpandedSyncRef.current = true;
        onExpandedChange(isOpen);
      }
    },
    [enabled, onExpandedChange]
  );

  const listViewport = useCallback(() => {
    return dockRef.current?.querySelector('.dock__pane-viewport') as HTMLElement | null;
  }, []);

  const measure = useCallback(() => {
    const dock = dockRef.current;
    if (!dock || !enabled) {
      return;
    }
    const body = dock.querySelector('.dock__body') as HTMLElement | null;
    const peek = dock.querySelector('.dock__peek') as HTMLElement | null;
    const handle = dock.querySelector('.dock__sheet-handle') as HTMLElement | null;
    if (!body) {
      return;
    }
    const viewport = window.visualViewport?.height ?? window.innerHeight;
    const expandedPx = Math.min(viewport * 0.72, viewport - 44 - 8);
    // A train's collapsed sheet is everything above the list (header and any notes under it,
    // e.g. "delayed before departure") plus the last and next stop; a station's is its peek.
    const head = dock.querySelector('.dock__body--train .dock__head') as HTMLElement | null;
    const sheetMain = dock.querySelector('.dock__body--train .dock__sheet-main') as HTMLElement | null;
    const pane = sheetMain?.querySelector(':scope > .dock__pane') as HTMLElement | null;
    const aboveList =
      sheetMain && pane && pane.offsetParent === sheetMain.offsetParent
        ? pane.offsetTop - sheetMain.offsetTop
        : head?.offsetHeight ?? 0;
    // A station's collapsed sheet is its peek plus the first two departures.
    const boardRows = Array.from(
      dock.querySelectorAll<HTMLElement>('.dock__body:not(.dock__body--train) .dock__board > li')
    ).slice(0, 2);
    const stationHead = dock.querySelector('.dock__body:not(.dock__body--train) .dock__head') as HTMLElement | null;
    const boardPx =
      boardRows.length > 0
        ? boardRows.reduce((sum, row) => sum + row.offsetHeight, 0) +
          (stationHead?.offsetHeight ?? 0) +
          STATION_ROWS_GAP_PX
        : 0;
    const collapsed =
      (head ? aboveList + COLLAPSED_LIST_PX : (peek?.offsetHeight ?? 0) + boardPx) +
      (handle?.offsetHeight ?? 0) +
      (parseFloat(getComputedStyle(body).paddingTop) || 0) +
      (parseFloat(getComputedStyle(body).paddingBottom) || 0);
    const safeCollapsed = Math.max(collapsed, 112);
    const previous = metricsRef.current;
    metricsRef.current = {
      collapsed: safeCollapsed,
      expanded: Math.max(expandedPx, safeCollapsed + 120),
      travel: Math.max(expandedPx - safeCollapsed, 120),
    };
    // The sheet's height is computed from these while rendering: re-render when they moved
    // (a note appeared above the list, the header wrapped), or the old height stays.
    if (
      Math.abs(previous.collapsed - safeCollapsed) >= 0.5 ||
      Math.abs(previous.expanded - metricsRef.current.expanded) >= 0.5
    ) {
      setMetricsVersion((version) => version + 1);
    }
  }, [enabled]);

  const cancelSettle = useCallback(() => {
    if (settleRafRef.current) {
      window.cancelAnimationFrame(settleRafRef.current);
      settleRafRef.current = 0;
    }
    setSettling(false);
  }, []);

  const animateTo = useCallback(
    (target: number) => {
      cancelSettle();
      const from = progressRef.current;
      const delta = Math.abs(target - from);
      if (delta < 0.004) {
        applyProgress(target);
        skipExpandedSyncRef.current = true;
        onExpandedChange(target >= 0.5);
        return;
      }
      const duration = Math.min(480, Math.max(180, 200 + delta * 280));
      const start = performance.now();
      setSettling(true);
      skipExpandedSyncRef.current = true;

      const tick = (now: number) => {
        const t = clamp((now - start) / duration, 0, 1);
        applyProgress(from + (target - from) * easeOutCubic(t));
        if (t < 1) {
          settleRafRef.current = window.requestAnimationFrame(tick);
          return;
        }
        settleRafRef.current = 0;
        setSettling(false);
        onExpandedChange(target >= 0.5);
      };
      settleRafRef.current = window.requestAnimationFrame(tick);
    },
    [applyProgress, cancelSettle, onExpandedChange]
  );

  useLayoutEffect(() => {
    if (!enabled) {
      return;
    }
    measure();
    const dock = dockRef.current;
    if (!dock) {
      return;
    }
    // The dock's own height is fixed by the sheet, so a header that wraps or a note that appears
    // (they sit above the list) does not resize it: watch those directly, and re-pick them when
    // the sheet's content changes.
    const observer = new ResizeObserver(() => measure());
    observer.observe(dock);
    const watchAbove = () => {
      dock
        .querySelectorAll('.dock__body--train .dock__sheet-main > :not(.dock__pane)')
        .forEach((node) => observer.observe(node));
    };
    watchAbove();
    // Only nodes coming or going above the list matter (a note appearing); text changes resize
    // the watched elements and reach the ResizeObserver. Batched to one measure per frame, since
    // measuring forces a layout.
    let pending = 0;
    const mutations = new MutationObserver(() => {
      if (pending) {
        return;
      }
      pending = window.requestAnimationFrame(() => {
        pending = 0;
        watchAbove();
        measure();
      });
    });
    mutations.observe(dock, { childList: true, subtree: true });
    window.visualViewport?.addEventListener('resize', measure);
    window.addEventListener('resize', measure);
    return () => {
      observer.disconnect();
      mutations.disconnect();
      if (pending) {
        window.cancelAnimationFrame(pending);
      }
      window.visualViewport?.removeEventListener('resize', measure);
      window.removeEventListener('resize', measure);
    };
  }, [enabled, measure, expanded]);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    return () => cancelSettle();
  }, [cancelSettle, enabled]);

  const syncListAtTop = useCallback(() => {
    const viewport = listViewport();
    if (!viewport) {
      setListAtTop(true);
      return;
    }
    setListAtTop(viewport.scrollTop <= LIST_TOP_EPSILON);
  }, [listViewport]);

  useEffect(() => {
    if (!enabled || progress < SHEET_CONTENT_REVEAL) {
      setListAtTop(true);
      return;
    }
    syncListAtTop();
    const dock = dockRef.current;
    if (!dock) {
      return;
    }
    const onScroll = (event: Event) => {
      const target = event.target;
      if (target instanceof HTMLElement && target.classList.contains('dock__pane-viewport')) {
        setListAtTop(target.scrollTop <= LIST_TOP_EPSILON);
      }
    };
    dock.addEventListener('scroll', onScroll, { passive: true, capture: true });
    const observer = new MutationObserver(() => syncListAtTop());
    observer.observe(dock, { childList: true, subtree: true });

    let touchStartY = 0;
    let touchTrackingTop = false;
    const onTouchStart = (event: TouchEvent) => {
      const target = event.target;
      const viewport = listViewport();
      if (!viewport || !(target instanceof Node) || !viewport.contains(target)) {
        touchTrackingTop = false;
        return;
      }
      if (viewport.scrollTop > LIST_TOP_EPSILON) {
        touchTrackingTop = false;
        return;
      }
      touchTrackingTop = true;
      touchStartY = event.touches[0]?.clientY ?? 0;
    };
    const onTouchMove = (event: TouchEvent) => {
      const viewport = listViewport();
      if (!viewport) {
        return;
      }
      if (dragRef.current) {
        event.preventDefault();
        return;
      }
      if (!touchTrackingTop || viewport.scrollTop > LIST_TOP_EPSILON) {
        return;
      }
      const clientY = event.touches[0]?.clientY ?? touchStartY;
      const dy = clientY - touchStartY;
      if (dy < -LIST_SCROLL_SLOP_PX) {
        touchTrackingTop = false;
        return;
      }
      if (dy > 0) {
        event.preventDefault();
      }
    };
    const onTouchEnd = () => {
      touchTrackingTop = false;
    };
    dock.addEventListener('touchstart', onTouchStart, { passive: true, capture: true });
    dock.addEventListener('touchmove', onTouchMove, { passive: false, capture: true });
    dock.addEventListener('touchend', onTouchEnd, { passive: true, capture: true });
    dock.addEventListener('touchcancel', onTouchEnd, { passive: true, capture: true });

    return () => {
      dock.removeEventListener('scroll', onScroll, { capture: true });
      observer.disconnect();
      dock.removeEventListener('touchstart', onTouchStart, { capture: true });
      dock.removeEventListener('touchmove', onTouchMove, { capture: true });
      dock.removeEventListener('touchend', onTouchEnd, { capture: true });
      dock.removeEventListener('touchcancel', onTouchEnd, { capture: true });
    };
  }, [enabled, expanded, listViewport, syncListAtTop]);

  useEffect(() => {
    if (!enabled || dragging || settling) {
      return;
    }
    if (skipExpandedSyncRef.current) {
      skipExpandedSyncRef.current = false;
      return;
    }
    const target = expanded ? 1 : 0;
    if (Math.abs(progressRef.current - target) < 0.004) {
      applyProgress(target);
      return;
    }
    animateTo(target);
  }, [animateTo, applyProgress, dragging, enabled, expanded, settling]);

  const beginDrag = useCallback(
    (clientY: number, captureEl?: HTMLElement) => {
      cancelSettle();
      if (captureEl) {
        captureElRef.current = captureEl;
      }
      const start = progressRef.current;
      dragRef.current = {
        pointerY: clientY,
        startProgress: start,
        lastY: clientY,
        lastT: performance.now(),
        velocity: 0,
      };
      setDragging(true);
    },
    [cancelSettle]
  );

  const moveDrag = useCallback(
    (clientY: number) => {
      const drag = dragRef.current;
      if (!drag) {
        return;
      }
      const now = performance.now();
      const dt = Math.max(now - drag.lastT, 8);
      drag.velocity = (clientY - drag.lastY) / dt;
      drag.lastY = clientY;
      drag.lastT = now;
      const delta = clientY - drag.pointerY;
      const { travel } = metricsRef.current;
      const next = clamp(drag.startProgress - delta / travel, 0, 1);
      applyProgress(next);
    },
    [applyProgress]
  );

  const endDrag = useCallback(() => {
    const drag = dragRef.current;
    dragRef.current = null;
    pendingListRef.current = null;
    captureElRef.current = null;
    setDragging(false);
    if (!drag) {
      return;
    }
    const flick = drag.velocity;
    const current = progressRef.current;
    if (Math.abs(current - drag.startProgress) > 0.025) {
      suppressPeekClickRef.current = true;
    }
    let target = current;
    if (flick >= FLICK_CLOSE_VELOCITY) {
      target = 0;
    } else if (flick <= FLICK_OPEN_VELOCITY) {
      target = 1;
    } else if (current >= 0.5) {
      target = 1;
    } else {
      target = 0;
    }
    animateTo(target);
  }, [animateTo]);

  const releaseCapture = useCallback((event: React.PointerEvent<HTMLElement>) => {
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // Ignore when capture was never taken.
    }
  }, []);

  const gesture = useMemo((): PointerGesture => {
    if (!enabled) {
      return {
        onPointerDown: () => {},
        onPointerMove: () => {},
        onPointerUp: () => {},
        onPointerCancel: () => {},
      };
    }
    return {
      onPointerDown: (event) => {
        if (event.pointerType === 'mouse' && event.button !== 0) {
          return;
        }
        measure();
        const viewport = listViewport();
        const target = event.target;
        const inList = viewport && target instanceof Node && viewport.contains(target);
        // The station tabs are taps too while the sheet is collapsed (the sheet does not capture them).
        const inTabs =
          target instanceof Element && target.closest('.dock__tabs') != null && progressRef.current < SHEET_CONTENT_REVEAL;
        if (inList || inTabs) {
          // While the sheet is collapsed its list cannot scroll, so a drag from the list is a drag
          // of the sheet. A plain tap stays a tap on the row: capture is taken only once it moves.
          if (progressRef.current < SHEET_CONTENT_REVEAL) {
            const element = event.currentTarget;
            const pending = { startY: event.clientY, pointerId: event.pointerId, element };
            pendingCollapsedRef.current = pending;
            stopWatchingRef.current?.();
            // Watch the whole window: a quick swipe leaves the (small) sheet before the first move.
            const onMove = (moveEvent: PointerEvent) => {
              if (moveEvent.pointerId !== pending.pointerId || pendingCollapsedRef.current !== pending) {
                return;
              }
              if (Math.abs(moveEvent.clientY - pending.startY) <= 8) {
                return;
              }
              stop();
              pendingCollapsedRef.current = null;
              handleTapRef.current = null;
              try {
                element.setPointerCapture(pending.pointerId);
              } catch {
                // the pointer is gone
                return;
              }
              beginDrag(pending.startY, element);
              moveDrag(moveEvent.clientY);
            };
            const onEnd = (endEvent: PointerEvent) => {
              if (endEvent.pointerId === pending.pointerId) {
                stop();
                if (pendingCollapsedRef.current === pending) {
                  pendingCollapsedRef.current = null;
                }
              }
            };
            const stop = () => {
              window.removeEventListener('pointermove', onMove);
              window.removeEventListener('pointerup', onEnd);
              window.removeEventListener('pointercancel', onEnd);
              stopWatchingRef.current = null;
            };
            stopWatchingRef.current = stop;
            window.addEventListener('pointermove', onMove);
            window.addEventListener('pointerup', onEnd);
            window.addEventListener('pointercancel', onEnd);
          }
          return;
        }
        event.currentTarget.setPointerCapture(event.pointerId);
        handleTapRef.current =
          target instanceof Element && target.closest('.dock__sheet-handle')
            ? { y: event.clientY, t: performance.now(), from: progressRef.current }
            : null;
        beginDrag(event.clientY, event.currentTarget);
      },
      onPointerMove: (event) => {
        if (!dragRef.current) {
          return;
        }
        event.preventDefault();
        moveDrag(event.clientY);
      },
      onPointerUp: (event) => {
        pendingCollapsedRef.current = null;
        if (!dragRef.current) {
          return;
        }
        const tap = handleTapRef.current;
        handleTapRef.current = null;
        releaseCapture(event);
        endDrag();
        // Tapping the handle (rather than dragging it) flips the sheet.
        if (tap && Math.abs(event.clientY - tap.y) < 8 && performance.now() - tap.t < 500) {
          animateTo(tap.from >= 0.5 ? 0 : 1);
        }
      },
      onPointerCancel: (event) => {
        handleTapRef.current = null;
        pendingCollapsedRef.current = null;
        if (!dragRef.current) {
          return;
        }
        releaseCapture(event);
        endDrag();
      },
    };
  }, [animateTo, beginDrag, enabled, endDrag, listViewport, measure, moveDrag, releaseCapture]);

  const listAtScrollTop = enabled && progress >= SHEET_CONTENT_REVEAL && listAtTop;
  const sheetContentRevealed = enabled && progress >= SHEET_CONTENT_REVEAL;

  const listPointerHandoff = useMemo((): DockListPointerHandoff | undefined => {
    if (!enabled || progress < SHEET_CONTENT_REVEAL) {
      return undefined;
    }
    const finishListPointer = (event: React.PointerEvent<HTMLElement>) => {
      if (pendingListRef.current?.pointerId === event.pointerId) {
        pendingListRef.current = null;
      }
      if (!dragRef.current) {
        return;
      }
      releaseCapture(event);
      endDrag();
    };
    return {
      onPointerDown: (event) => {
        if (event.pointerType === 'mouse' && event.button !== 0) {
          return;
        }
        const viewport = event.currentTarget;
        if (viewport.scrollTop > LIST_TOP_EPSILON) {
          return;
        }
        measure();
        pendingListRef.current = { startY: event.clientY, pointerId: event.pointerId };
      },
      onPointerMove: (event) => {
        if (dragRef.current) {
          event.preventDefault();
          moveDrag(event.clientY);
          return;
        }
        const pending = pendingListRef.current;
        if (!pending || pending.pointerId !== event.pointerId) {
          return;
        }
        const viewport = event.currentTarget;
        if (viewport.scrollTop > LIST_TOP_EPSILON) {
          pendingListRef.current = null;
          return;
        }
        const dy = event.clientY - pending.startY;
        if (dy < -LIST_SCROLL_SLOP_PX) {
          pendingListRef.current = null;
          return;
        }
        if (dy <= 0) {
          return;
        }
        event.preventDefault();
        if (!dragRef.current) {
          pendingListRef.current = null;
          event.currentTarget.setPointerCapture(event.pointerId);
          beginDrag(pending.startY, event.currentTarget);
        }
        moveDrag(event.clientY);
      },
      onPointerUp: finishListPointer,
      onPointerCancel: finishListPointer,
    };
  }, [beginDrag, enabled, endDrag, measure, moveDrag, progress, releaseCapture]);

  const { collapsed, expanded: expandedPx } = metricsRef.current;
  const heightPx = collapsed + progress * (expandedPx - collapsed);

  const dockStyle: CSSProperties | undefined = enabled
    ? {
        height: `${heightPx}px`,
        maxHeight: `${heightPx}px`,
        ['--sheet-progress' as string]: String(progress),
        transition: dragging || settling ? 'none' : undefined,
      }
    : undefined;

  const consumePeekClick = useCallback(() => {
    if (!suppressPeekClickRef.current) {
      return false;
    }
    suppressPeekClickRef.current = false;
    return true;
  }, []);

  return {
    dockRef,
    dockStyle,
    dragging,
    settling,
    progress,
    gesture,
    listPointerHandoff,
    listAtScrollTop,
    sheetContentRevealed,
    measure,
    consumePeekClick,
  };
};
