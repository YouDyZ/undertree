import type { TourPlacement, TourStep } from "./steps";

export interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface PopoverPosition {
  top: number;
  left: number;
  placement: "center" | "right" | "left" | "bottom" | "top";
}

const VIEWPORT_MARGIN = 12;
const TARGET_GAP = 14;

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.max(min, Math.min(max, value));
}

function placementOrder(preferred: TourPlacement): Array<"right" | "left" | "bottom" | "top"> {
  switch (preferred) {
    case "left":
      return ["left", "right", "bottom", "top"];
    case "bottom":
      return ["bottom", "top", "left", "right"];
    case "top":
      return ["top", "bottom", "left", "right"];
    case "right":
    case "auto":
    default:
      return ["right", "left", "bottom", "top"];
  }
}

/**
 * Computes a viewport-clamped popover coordinate next to `targetRect`,
 * flipping sides automatically if space is insufficient, or centering when `targetRect` is null.
 */
export function computePopoverPosition(
  targetRect: Rect | null,
  popover: Size,
  viewport: Size,
  preferred: TourPlacement = "auto"
): PopoverPosition {
  const maxLeft = Math.max(VIEWPORT_MARGIN, viewport.width - popover.width - VIEWPORT_MARGIN);
  const maxTop = Math.max(VIEWPORT_MARGIN, viewport.height - popover.height - VIEWPORT_MARGIN);

  if (!targetRect) {
    return {
      top: Math.round(clamp((viewport.height - popover.height) / 2, VIEWPORT_MARGIN, maxTop)),
      left: Math.round(clamp((viewport.width - popover.width) / 2, VIEWPORT_MARGIN, maxLeft)),
      placement: "center",
    };
  }

  const rightSpace = viewport.width - (targetRect.left + targetRect.width) - TARGET_GAP - VIEWPORT_MARGIN;
  const leftSpace = targetRect.left - TARGET_GAP - VIEWPORT_MARGIN;
  const bottomSpace = viewport.height - (targetRect.top + targetRect.height) - TARGET_GAP - VIEWPORT_MARGIN;
  const topSpace = targetRect.top - TARGET_GAP - VIEWPORT_MARGIN;

  const fits = (side: "right" | "left" | "bottom" | "top"): boolean => {
    switch (side) {
      case "right":
        return rightSpace >= popover.width;
      case "left":
        return leftSpace >= popover.width;
      case "bottom":
        return bottomSpace >= popover.height;
      case "top":
        return topSpace >= popover.height;
    }
  };

  const order = placementOrder(preferred);
  const chosen = order.find(fits) ?? order[0] ?? "bottom";

  let rawTop = 0;
  let rawLeft = 0;

  switch (chosen) {
    case "right":
      rawLeft = targetRect.left + targetRect.width + TARGET_GAP;
      rawTop = targetRect.top + (targetRect.height - popover.height) / 2;
      break;
    case "left":
      rawLeft = targetRect.left - popover.width - TARGET_GAP;
      rawTop = targetRect.top + (targetRect.height - popover.height) / 2;
      break;
    case "bottom":
      rawTop = targetRect.top + targetRect.height + TARGET_GAP;
      rawLeft = targetRect.left + (targetRect.width - popover.width) / 2;
      break;
    case "top":
      rawTop = targetRect.top - popover.height - TARGET_GAP;
      rawLeft = targetRect.left + (targetRect.width - popover.width) / 2;
      break;
  }

  return {
    top: Math.round(clamp(rawTop, VIEWPORT_MARGIN, maxTop)),
    left: Math.round(clamp(rawLeft, VIEWPORT_MARGIN, maxLeft)),
    placement: chosen,
  };
}

/**
 * Filters steps to those that either require no target (modal) or whose target exists right now.
 */
export function resolveAvailableSteps(
  steps: readonly TourStep[],
  hasTarget: (selector: string) => boolean
): TourStep[] {
  return steps.filter((step) => step.targetSelector === null || hasTarget(step.targetSelector));
}
