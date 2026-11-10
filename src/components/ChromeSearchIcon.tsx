import React from 'react';

type ChromeSearchIconProps = {
  size?: number;
  className?: string;
};

export const ChromeSearchIcon: React.FC<ChromeSearchIconProps> = ({ size = 16, className }) => (
  <svg
    className={className}
    width={size}
    height={size}
    viewBox="0 0 14 14"
    fill="none"
    aria-hidden="true"
  >
    <path
      d="M9.779 10.5217C8.7437 11.3883 7.4102 11.9112 5.9563 11.9112C2.6684 11.9112 0 9.2428 0 5.9556C0 2.6684 2.6684 0 5.9563 0C9.2428 0 11.9119 2.6684 11.9119 5.9556C11.9119 7.4102 11.389 8.7444 10.5224 9.7783L13.8467 13.1033C13.9489 13.2055 14 13.3399 14 13.475C14 13.8859 13.6241 14 13.475 14C13.3406 14 13.2062 13.9489 13.1033 13.846L9.779 10.5217ZM5.9563 1.0507C3.2487 1.0507 1.0514 3.2487 1.0514 5.9556C1.0514 8.6625 3.2487 10.8605 5.9563 10.8605C8.6625 10.8605 10.8612 8.6625 10.8612 5.9556C10.8612 3.2487 8.6625 1.0507 5.9563 1.0507Z"
      fill="currentColor"
    />
  </svg>
);
