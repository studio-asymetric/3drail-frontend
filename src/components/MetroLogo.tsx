import React from 'react';
import { METRO_LOGO_HEIGHT, METRO_LOGO_PATH, METRO_LOGO_WIDTH } from '../data/metroLogo';

/** The Prague metro logo in the colour of the text around it; goes before the line letter. */
export const MetroLogo: React.FC<{ height?: number }> = ({ height = 12 }) => (
  <svg
    className="metro-logo"
    viewBox={`0 0 ${METRO_LOGO_WIDTH} ${METRO_LOGO_HEIGHT}`}
    height={height}
    width={(height * METRO_LOGO_WIDTH) / METRO_LOGO_HEIGHT}
    fill="currentColor"
    aria-hidden="true"
    focusable="false"
  >
    <path d={METRO_LOGO_PATH} />
  </svg>
);
