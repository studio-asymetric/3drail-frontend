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

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function easeOutCubic(t: number) {
  return 1 - Math.pow(1 - t, 3);
}

type PointerGesture = {
  onPointerDown: (event: React.PointerEvent<HTMLElement>) => void;
  onPointerMove: (event: React.PointerEvent<HTMLElement>) => void;
  onPointerUp: (event: React.PointerEvent<HTMLElement>) => void;
  onPointerCancel: (event: React.PointerEvent<HTMLElement>) => void;
};

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
  const captureElRef = useRef<HTMLElement | null>(null);
  const [progress, setProgress] = useState(expanded ? 1 : 0);
  const [dragging, setDragging] = useState(false);
  const [settling, setSettling] = useState(false);
  const [listAtTop, setListAtTop] = useState(true);

  const applyProgress = useCallback((value: number) => {
    const next = clamp(value, 0, 1);
    progressRef.current = next;
    setProgress(next);
  }, []);

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
    const collapsed =
      (peek?.offsetHeight ?? 0) +
      (handle?.offsetHeight ?? 0) +
      (parseFloat(getComputedStyle(body).paddingTop) || 0) +
      (parseFloat(getComputedStyle(body).paddingBottom) || 0);
    const safeCollapsed = Math.max(collapsed, 112);
    metricsRef.current = {
      collapsed: safeCollapsed,
      expanded: Math.max(expandedPx, safeCollapsed + 120),
      travel: Math.max(expandedPx - safeCollapsed, 120),
    };
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
    const observer = new ResizeObserver(() => measure());
    observer.observe(dock);
    window.visualViewport?.addEventListener('resize', measure);
    window.addEventListener('resize', measure);
    return () => {
      observer.disconnect();
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
    if (!enabled || !expanded) {
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
    return () => {
      dock.removeEventListener('scroll', onScroll, { capture: true });
      observer.disconnect();
    };
  }, [enabled, expanded, syncListAtTop]);

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
        if (inList && viewport.scrollTop > LIST_TOP_EPSILON) {
          return;
        }
        event.currentTarget.setPointerCapture(event.pointerId);
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
        if (!dragRef.current) {
          return;
        }
        releaseCapture(event);
        endDrag();
      },
      onPointerCancel: (event) => {
        if (!dragRef.current) {
          return;
        }
        releaseCapture(event);
        endDrag();
      },
    };
  }, [beginDrag, enabled, endDrag, listViewport, measure, moveDrag, releaseCapture]);

  const listSheetGrab = enabled && expanded && listAtTop;

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
    listSheetGrab,
    measure,
    consumePeekClick,
  };
};
