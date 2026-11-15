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

    const updateThumb = () => {
      const limit = scrollLimit();
      const view = wrapper.clientHeight;
      const overflow = limit > 1;
      track.classList.toggle('is-visible', overflow);
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

    // Scroll so the train (the dot on the rail, else the bold stop) sits a little above the middle.
    const scrollToNext = () => {
      const marker =
        (content.querySelector('.dock__stop-train') as HTMLElement | null) ??
        (content.querySelector('.is-focus') as HTMLElement | null);
      if (!marker || wrapper.clientHeight < 1) {
        return;
      }
      const rect = marker.getBoundingClientRect();
      const center = rect.top + rect.height / 2;
      const target =
        center - wrapper.getBoundingClientRect().top + wrapper.scrollTop - wrapper.clientHeight * 0.38;
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
