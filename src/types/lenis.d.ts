declare module 'lenis';
declare module 'lenis/dist/lenis.mjs' {
  export interface LenisOptions {
    duration?: number;
    easing?: (t: number) => number;
    direction?: 'vertical' | 'horizontal';
    wheelMultiplier?: number;
    smoothWheel?: boolean;
    smoothTouch?: boolean;
    wrapper?: HTMLElement | null;
    content?: HTMLElement | null;
  }

  export default class Lenis {
    constructor(options?: LenisOptions);
    raf(time: number): void;
    destroy(): void;
  }
}

