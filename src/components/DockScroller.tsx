import React, { useEffect, useRef, useState } from 'react';
import type { DockListPointerHandoff } from '../hooks/useMobileDockSheet';

interface DockScrollerProps {
  loading: boolean;
  error?: string | null;
  label: string;
  contentKey: string;
  children: React.ReactNode;
  listPointerHandoff?: DockListPointerHandoff;
  listAtScrollTop?: boolean;
  /** When false, loading UI is suppressed (e.g. collapsed mobile sheet). */
  loadingVisible?: boolean;
  /** Milliseconds loading must persist before showing UI (0 = immediate). */
  loadingDelayMs?: number;
  loadingVariant?: 'spinner' | 'bar';
  /**
   * When this changes the list scrolls to where the train is again and follows the
   * layout settling for a moment (a mobile sheet opening), until the user touches it.
   */
  revealKey?: string;
}

export const DockScroller: React.FC<DockScrollerProps> = ({
  loading,
  error,
  label,
  contentKey,
  children,
  listPointerHandoff,
  listAtScrollTop,
  loadingVisible = true,
  loadingDelayMs = 0,
  loadingVariant = 'spinner',
  revealKey,
}) => {
  const [showLoadingUi, setShowLoadingUi] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  const trackLoading = loading && loadingVisible;

  useEffect(() => {
    if (!trackLoading) {
      setShowLoadingUi(false);
      return;
    }
    if (loadingDelayMs <= 0) {
      setShowLoadingUi(true);
      return;
    }
    const timer = window.setTimeout(() => setShowLoadingUi(true), loadingDelayMs);
    return () => window.clearTimeout(timer);
  }, [loadingDelayMs, trackLoading, contentKey]);
  const contentRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const wrapper = wrapperRef.current;
    const content = contentRef.current;
    const thumb = thumbRef.current;
    const track = trackRef.current;
    if (loading || error || !wrapper || !content || !thumb || !track) {
      return;
    }

    const scrollLimit = () =>
      Math.max(0, wrapper.scrollHeight - wrapper.clientHeight);

    // Rows sliding under the pinned first/last stop fade out (names, times and studs, not the
    // rail): each gets --edge = 0..1 from how far it is clear of the pinned row.
    const EDGE_FADE_PX = 40;
    // A row is gone by the time its text (about 12 px in from the row's edge) reaches the pinned stop.
    const EDGE_LEAD_PX = 12;
    const DOT_LEAD_PX = 2;
    const fadeEdgeRows = () => {
      const rows = content.querySelectorAll<HTMLElement>('.dock__stops > li');
      if (rows.length < 3) {
        return;
      }
      const moreTop = wrapper.hasAttribute('data-more-top');
      const moreBottom = wrapper.hasAttribute('data-more-bottom');
      const pinBottom = moreTop ? rows[0].getBoundingClientRect().bottom : -Infinity;
      const pinTop = moreBottom ? rows[rows.length - 1].getBoundingClientRect().top : Infinity;
      for (let index = 1; index < rows.length - 1; index += 1) {
        const rect = rows[index].getBoundingClientRect();
        let edge = 1;
        if (moreTop) {
          edge = Math.min(edge, (rect.top - pinBottom + EDGE_LEAD_PX) / EDGE_FADE_PX);
        }
        if (moreBottom) {
          edge = Math.min(edge, (pinTop - rect.bottom + EDGE_LEAD_PX) / EDGE_FADE_PX);
        }
        const value = Math.max(0, Math.min(1, edge)).toFixed(2);
        if (rows[index].style.getPropertyValue('--edge') !== value) {
          rows[index].style.setProperty('--edge', value);
        }
      }
      // The train's dot rides the rail between two rows, so it fades by its own position.
      const dot = content.querySelector<HTMLElement>('.dock__stop-train');
      if (dot) {
        const rect = dot.getBoundingClientRect();
        // The dot is a child of the row it is heading for. When that is a pinned (sticky) row,
        // the row sits away from its natural place and drags the dot along: judge the dot by
        // where the rail really is, i.e. where the row would be without the pinning.
        const home = dot.closest('li');
        let shift = 0;
        if (home === rows[rows.length - 1] && moreBottom) {
          shift = rows[rows.length - 2].getBoundingClientRect().bottom - home.getBoundingClientRect().top;
        }
        const dotTop = rect.top + shift;
        const dotBottom = rect.bottom + shift;
        let edge = 1;
        if (moreTop) {
          edge = Math.min(edge, (dotTop - pinBottom + DOT_LEAD_PX) / EDGE_FADE_PX);
        }
        if (moreBottom) {
          edge = Math.min(edge, (pinTop - dotBottom + DOT_LEAD_PX) / EDGE_FADE_PX);
        }
        dot.style.setProperty('--edge', Math.max(0, Math.min(1, edge)).toFixed(2));
      }
    };

    const updateThumb = () => {
      const limit = scrollLimit();
      const view = wrapper.clientHeight;
      const overflow = limit > 1;
      // The first and last row stay pinned while the list scrolls; these tell the rail
      // whether there is more hidden above or below them.
      // A collapsed mobile sheet shows just the last and next stop: nothing is pinned or faded.
      const peeking = Boolean(wrapper.closest('.dock--collapsed'));
      wrapper.toggleAttribute('data-more-top', !peeking && overflow && wrapper.scrollTop > 2);
      wrapper.toggleAttribute('data-more-bottom', !peeking && overflow && wrapper.scrollTop < limit - 2);
      track.classList.toggle('is-visible', overflow);
      fadeEdgeRows();
      if (!overflow) {
        thumb.style.height = '0px';
        thumb.style.transform = 'translateY(0px)';
        return;
      }
      const trackHeight = track.clientHeight;
      if (trackHeight < 1) {
        return;
      }
      const thumbHeight = Math.max(22, (view / wrapper.scrollHeight) * trackHeight);
      const room = Math.max(0, trackHeight - thumbHeight);
      const progress = limit > 0 ? wrapper.scrollTop / limit : 0;
      thumb.style.height = `${thumbHeight}px`;
      thumb.style.transform = `translateY(${progress * room}px)`;
    };

    // The small (collapsed) sheet is not scrollable: it shows one stretch of the track, the stop
    // the train left (or stands at), the stop it heads for, and the dot between them.
    const alignPeek = (): boolean => {
      if (!wrapper.closest('.dock--collapsed')) {
        return false;
      }
      const headRow = content.querySelector('.dock__stop-train')?.closest('li') ?? null;
      const focusRow = content.querySelector('li.is-focus');
      const top = headRow
        ? headRow.previousElementSibling ?? headRow
        : focusRow && !focusRow.nextElementSibling
          ? focusRow.previousElementSibling ?? focusRow
          : focusRow;
      if (!top || wrapper.clientHeight < 1) {
        return true;
      }
      // the list has 4 px of padding above its first row
      const target =
        top.getBoundingClientRect().top - wrapper.getBoundingClientRect().top + wrapper.scrollTop - 4;
      if (Math.abs(wrapper.scrollTop - target) > 0.5) {
        wrapper.scrollTop = Math.max(0, target);
      }
      updateThumb();
      return true;
    };

    // Scroll so the train (the dot on the rail, else the bold stop) sits a little above the middle.
    const scrollToNext = () => {
      if (alignPeek()) {
        return;
      }
      const marker =
        (content.querySelector('.dock__stop-train') as HTMLElement | null) ??
        (content.querySelector('.is-focus') as HTMLElement | null);
      if (!marker || wrapper.clientHeight < 1) {
        return;
      }
      const rect = marker.getBoundingClientRect();
      const center = rect.top + rect.height / 2;
      const target =
        center - wrapper.getBoundingClientRect().top + wrapper.scrollTop - wrapper.clientHeight * (wrapper.closest('.dock--collapsed') ? 0.5 : 0.38);
      wrapper.scrollTop = Math.max(0, target);
      updateThumb();
    };

    // While the sheet opens the list changes size for a few frames; keep the train in
    // view through that, and stop as soon as the user takes over or the layout is still.
    let following = true;
    const stopFollowing = () => {
      following = false;
    };
    const settleTimer = window.setTimeout(stopFollowing, 1400);
    wrapper.addEventListener('pointerdown', stopFollowing, { passive: true });
    wrapper.addEventListener('wheel', stopFollowing, { passive: true });
    wrapper.addEventListener('touchstart', stopFollowing, { passive: true });

    const scrollFromClientY = (clientY: number) => {
      const limit = scrollLimit();
      if (limit <= 0) {
        return;
      }
      const rect = track.getBoundingClientRect();
      const thumbHeight = Math.max(22, thumb.getBoundingClientRect().height || 22);
      const room = Math.max(1, rect.height - thumbHeight);
      const ratio = Math.min(1, Math.max(0, (clientY - rect.top - thumbHeight / 2) / room));
      wrapper.scrollTop = ratio * limit;
      updateThumb();
    };

    let dragging = false;
    const onPointerMove = (event: PointerEvent) => {
      if (!dragging) {
        return;
      }
      event.preventDefault();
      scrollFromClientY(event.clientY);
    };
    const stopDrag = () => {
      if (!dragging) {
        return;
      }
      dragging = false;
      track.classList.remove('is-dragging');
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', stopDrag);
    };
    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      dragging = true;
      track.classList.add('is-dragging');
      track.setPointerCapture?.(event.pointerId);
      scrollFromClientY(event.clientY);
      window.addEventListener('pointermove', onPointerMove);
      window.addEventListener('pointerup', stopDrag);
    };

    const onScroll = () => updateThumb();
    wrapper.addEventListener('scroll', onScroll, { passive: true });
    track.addEventListener('pointerdown', onPointerDown);

    const resize = () => {
      updateThumb();
      if (following) {
        scrollToNext();
      }
    };
    // While collapsed, keep the shown stretch on the train as it moves and passes stops.
    let peekRaf = 0;
    const peekObserver = new MutationObserver(() => {
      if (peekRaf || !wrapper.closest('.dock--collapsed')) {
        return;
      }
      peekRaf = requestAnimationFrame(() => {
        peekRaf = 0;
        alignPeek();
      });
    });
    peekObserver.observe(content, { subtree: true, attributes: true, childList: true, attributeFilter: ['class', 'style'] });
    const observer = new ResizeObserver(resize);
    observer.observe(wrapper);
    observer.observe(content);
    observer.observe(track);
    requestAnimationFrame(() => {
      scrollToNext();
      updateThumb();
    });

    return () => {
      window.clearTimeout(settleTimer);
      wrapper.removeEventListener('pointerdown', stopFollowing);
      wrapper.removeEventListener('wheel', stopFollowing);
      wrapper.removeEventListener('touchstart', stopFollowing);
      wrapper.removeEventListener('scroll', onScroll);
      stopDrag();
      track.removeEventListener('pointerdown', onPointerDown);
      observer.disconnect();
      peekObserver.disconnect();
      if (peekRaf) {
        cancelAnimationFrame(peekRaf);
      }
    };
  }, [loading, error, contentKey, revealKey]);

  return (
    <div className="dock__pane">
      <div className="dock__scrollbar" ref={trackRef} aria-hidden="true">
        <div className="dock__scrollbar-thumb" ref={thumbRef} />
      </div>
      {trackLoading && showLoadingUi ? (
        loadingVariant === 'bar' ? (
          <div className="dock__loading-bar-wrap" role="status" aria-label={label}>
            <div className="map-loading-bar dock__loading-bar">
              <div className="map-loading-bar__progress dock__loading-bar__progress" />
            </div>
          </div>
        ) : (
          <div className="dock__loading" role="status">
            <span className="dock__spinner" />
            <span>{label}</span>
          </div>
        )
      ) : trackLoading ? (
        <div className="dock__loading-placeholder" aria-hidden="true" />
      ) : error ? (
        <p className="dock__pane-error">{error}</p>
      ) : (
        <div
          className={`dock__pane-viewport${listAtScrollTop ? ' is-list-at-top' : ''}`}
          ref={wrapperRef}
          {...(listPointerHandoff ?? {})}
        >
          <div className="dock__pane-content" ref={contentRef}>
            <div key={contentKey} className="dock__pane-rise">
              {children}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
