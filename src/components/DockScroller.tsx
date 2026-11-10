import React, { useEffect, useRef } from 'react';

interface DockScrollerProps {
  loading: boolean;
  error?: string | null;
  label: string;
  contentKey: string;
  children: React.ReactNode;
}

export const DockScroller: React.FC<DockScrollerProps> = ({
  loading,
  error,
  label,
  contentKey,
  children,
}) => {
  const wrapperRef = useRef<HTMLDivElement>(null);
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

    const scrollToNext = () => {
      const nextStop = content.querySelector('.is-next') as HTMLElement | null;
      if (!nextStop) {
        return;
      }
      const target =
        nextStop.getBoundingClientRect().top -
        wrapper.getBoundingClientRect().top +
        wrapper.scrollTop -
        wrapper.clientHeight * 0.38;
      wrapper.scrollTop = Math.max(0, target);
      updateThumb();
    };

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
      wrapper.removeEventListener('scroll', onScroll);
      stopDrag();
      track.removeEventListener('pointerdown', onPointerDown);
      observer.disconnect();
    };
  }, [loading, error, contentKey]);

  return (
    <div className="dock__pane">
      <div className="dock__scrollbar" ref={trackRef} aria-hidden="true">
        <div className="dock__scrollbar-thumb" ref={thumbRef} />
      </div>
      {loading ? (
        <div className="dock__loading" role="status">
          <span className="dock__spinner" />
          <span>{label}</span>
        </div>
      ) : error ? (
        <p className="dock__pane-error">{error}</p>
      ) : (
        <div className="dock__pane-viewport" ref={wrapperRef}>
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
