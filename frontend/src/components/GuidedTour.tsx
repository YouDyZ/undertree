import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import {
  type PopoverPosition,
  type Rect,
  computePopoverPosition,
  resolveAvailableSteps,
} from "../tour/positioning";
import { EDITOR_TOUR_STEPS, type TourStep } from "../tour/steps";
import { XIcon } from "./Icons";

interface GuidedTourProps {
  open: boolean;
  steps?: readonly TourStep[];
  onFinish: () => void;
  onDismiss: () => void;
}

const SPOTLIGHT_PAD = 6;
const DEFAULT_POPOVER_SIZE = { width: 360, height: 220 };

function measureTarget(selector: string | null): Rect | null {
  if (!selector) return null;
  const el = document.querySelector(selector);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return null;
  return {
    top: Math.max(0, r.top - SPOTLIGHT_PAD),
    left: Math.max(0, r.left - SPOTLIGHT_PAD),
    width: r.width + SPOTLIGHT_PAD * 2,
    height: r.height + SPOTLIGHT_PAD * 2,
  };
}

export function GuidedTour({
  open,
  steps = EDITOR_TOUR_STEPS,
  onFinish,
  onDismiss,
}: GuidedTourProps) {
  const [stepIndex, setStepIndex] = useState(0);
  const [targetRect, setTargetRect] = useState<Rect | null>(null);
  const [popoverPos, setPopoverPos] = useState<PopoverPosition>({
    top: 120,
    left: 120,
    placement: "center",
  });
  const popoverRef = useRef<HTMLDivElement | null>(null);

  const activeSteps = useMemo(() => {
    if (!open) return [];
    return resolveAvailableSteps(steps, (sel) => document.querySelector(sel) !== null);
  }, [open, steps]);

  useEffect(() => {
    if (open) {
      setStepIndex(0);
    }
  }, [open]);

  const currentStep = activeSteps[stepIndex] ?? null;
  const totalSteps = activeSteps.length;
  const isFirst = stepIndex === 0;
  const isLast = stepIndex >= totalSteps - 1;

  const recalculate = useCallback(() => {
    if (!open || !currentStep) return;
    const rect = measureTarget(currentStep.targetSelector);
    setTargetRect(rect);

    const popEl = popoverRef.current;
    const popSize = popEl
      ? { width: popEl.offsetWidth || DEFAULT_POPOVER_SIZE.width, height: popEl.offsetHeight || DEFAULT_POPOVER_SIZE.height }
      : DEFAULT_POPOVER_SIZE;

    const nextPos = computePopoverPosition(
      rect,
      popSize,
      { width: window.innerWidth, height: window.innerHeight },
      currentStep.preferredPlacement ?? "auto"
    );
    setPopoverPos(nextPos);
  }, [open, currentStep]);

  useLayoutEffect(() => {
    if (!open || !currentStep) return;
    recalculate();
    const raf = window.requestAnimationFrame(recalculate);
    return () => window.cancelAnimationFrame(raf);
  }, [open, currentStep, recalculate]);

  useEffect(() => {
    if (!open) return;
    const onResizeOrScroll = () => recalculate();
    window.addEventListener("resize", onResizeOrScroll);
    window.addEventListener("scroll", onResizeOrScroll, true);
    return () => {
      window.removeEventListener("resize", onResizeOrScroll);
      window.removeEventListener("scroll", onResizeOrScroll, true);
    };
  }, [open, recalculate]);

  const handleNext = useCallback(() => {
    if (isLast) {
      onFinish();
    } else {
      setStepIndex((idx) => Math.min(totalSteps - 1, idx + 1));
    }
  }, [isLast, totalSteps, onFinish]);

  const handlePrev = useCallback(() => {
    setStepIndex((idx) => Math.max(0, idx - 1));
  }, []);

  // Keyboard navigation: Escape closes, ArrowRight advances, ArrowLeft goes back
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") {
        ev.preventDefault();
        onDismiss();
      } else if (ev.key === "ArrowRight") {
        ev.preventDefault();
        handleNext();
      } else if (ev.key === "ArrowLeft" && !isFirst) {
        ev.preventDefault();
        handlePrev();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, isFirst, handleNext, handlePrev, onDismiss]);

  if (!open || !currentStep) return null;

  return (
    <div class="tour-layer" data-tour-step={currentStep.id}>
      {/* Clickable backdrop when no spotlight target or behind spotlight */}
      <div class="tour-backdrop" onClick={onDismiss} aria-hidden="true" />

      {targetRect && (
        <div
          class="tour-spotlight"
          aria-hidden="true"
          style={{
            top: `${targetRect.top}px`,
            left: `${targetRect.left}px`,
            width: `${targetRect.width}px`,
            height: `${targetRect.height}px`,
          }}
        />
      )}

      <div
        ref={popoverRef}
        class={`tour-popover tour-placement-${popoverPos.placement}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="tour-step-title"
        style={{
          top: `${popoverPos.top}px`,
          left: `${popoverPos.left}px`,
        }}
      >
        <div class="tour-header">
          <span class="tour-counter">
            Schritt {stepIndex + 1} von {totalSteps}
          </span>
          <button
            type="button"
            class="icon-btn"
            aria-label="Tour schließen"
            title="Tour schließen (Esc)"
            onClick={onDismiss}
          >
            <XIcon size={14} />
          </button>
        </div>

        <h3 id="tour-step-title" class="tour-title">
          {currentStep.title}
        </h3>

        <p class="tour-desc">{currentStep.description}</p>

        {currentStep.shortcut && (
          <div class="tour-shortcut-row">
            <span class="muted-text">Tastenkürzel:</span>
            <kbd class="tour-kbd">{currentStep.shortcut}</kbd>
          </div>
        )}

        {currentStep.tip && <p class="tour-tip">{currentStep.tip}</p>}

        <div class="tour-dots" aria-hidden="true">
          {activeSteps.map((s, idx) => (
            <button
              key={s.id}
              type="button"
              tabIndex={-1}
              class={`tour-dot-btn ${idx === stepIndex ? "is-active" : ""}`}
              onClick={() => setStepIndex(idx)}
            />
          ))}
        </div>

        <div class="tour-footer">
          <button type="button" class="btn-ghost btn-xs" onClick={onDismiss}>
            Überspringen
          </button>
          <div class="tour-nav">
            {!isFirst && (
              <button type="button" class="btn-ghost btn-xs" onClick={handlePrev}>
                Zurück
              </button>
            )}
            <button type="button" class="btn-primary btn-xs tour-next-btn" onClick={handleNext}>
              {isLast ? "Fertig" : "Weiter"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
