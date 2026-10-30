import type { CSSProperties } from "react";

export const PIERRE_TREE_UNSAFE_CSS = `
  :host {
    --trees-bg-override: transparent;
    --trees-selected-bg-override: color-mix(in srgb, currentColor 12%, transparent);
    --trees-hover-bg-override: color-mix(in srgb, currentColor 7%, transparent);
    --trees-border-color-override: color-mix(in srgb, currentColor 14%, transparent);
    --trees-font-family-override: var(--font-sans);
    --trees-font-size-override: 0.75rem;
  }
  [data-truncate-content='visible'] { overflow: hidden; text-overflow: ellipsis; }
  [data-truncate-marker] { display: none; }
  button[data-type='item'], button[data-type='item']::before { border-radius: var(--radius-md); }
  svg[data-icon-name='t3-tree-icon-loading'] { opacity: 0.6; }
  button[data-type='item']:not([data-item-selected]):has(svg[data-icon-name='t3-tree-icon-reviewed']) { opacity: 0.5; }
  button[data-type='item']:not([data-item-selected]):has(svg[data-icon-name='t3-tree-icon-reviewed']):hover { opacity: 0.8; }
  button[data-type='item']:not([data-item-selected]):has(svg[data-icon-name='t3-tree-icon-flagged']) {
    background-color: color-mix(in srgb, var(--warning) 18%, transparent);
    font-weight: 500;
  }
  button[data-type='item']:not([data-item-selected]) svg:is([data-icon-name='t3-tree-icon-reviewed'], [data-icon-name='t3-tree-icon-flagged'], [data-icon-name='t3-tree-icon-changed']) { visibility: hidden; }
  @media (prefers-reduced-motion: no-preference) {
    svg[data-icon-name='t3-tree-icon-loading'] { animation: t3-tree-spin 1s linear infinite; }
  }
  @keyframes t3-tree-spin { to { transform: rotate(360deg); } }
`;

export function pierreTreeStyle(colorScheme: "light" | "dark"): CSSProperties {
  return {
    colorScheme,
    ["--trees-fg-override" as string]: "var(--contrast-foreground)",
  };
}
