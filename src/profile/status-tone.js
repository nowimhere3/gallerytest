// [SYNCV3 / STAGE-10 / STATUS-TONES]
// One five-tone vocabulary and one class-swap boundary for every product
// status row. Semantic ownership remains in each pure state/copy mapper.
export const PRODUCT_STATUS_TONES = Object.freeze([
  "muted",
  "active",
  "success",
  "warning",
  "danger",
]);

export function applyProductStatusTone(element, tone) {
  if (!element?.classList) return;
  const nextTone = PRODUCT_STATUS_TONES.includes(tone) ? tone : "muted";
  // [WHY: remove every prior tone before adding the current semantic result;
  // otherwise a warning/danger class can survive a later healthy render and
  // make CSS ordering, rather than state ownership, decide presentation.]
  element.classList.remove(...PRODUCT_STATUS_TONES.map((entry) => `product-status-${entry}`));
  element.classList.add(`product-status-${nextTone}`);
}
