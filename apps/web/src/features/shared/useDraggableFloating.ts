import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';

type Position = { x: number; y: number };
type DragState = {
  pointerId: number;
  captureTarget: HTMLElement;
  offsetX: number;
  offsetY: number;
  startX: number;
  startY: number;
  moved: boolean;
};

export function useDraggableFloating<T extends HTMLElement>({
  ignoreSelector,
  margin = 12,
}: {
  ignoreSelector?: string;
  margin?: number;
} = {}) {
  const elementRef = useRef<T>(null);
  const dragRef = useRef<DragState | undefined>(undefined);
  const suppressClickRef = useRef(false);
  const [position, setPosition] = useState<Position>();

  const boundedPosition = useCallback((x: number, y: number): Position => {
    const rect = elementRef.current?.getBoundingClientRect();
    const width = rect?.width ?? 0;
    const height = rect?.height ?? 0;
    return {
      x: Math.max(margin, Math.min(x, Math.max(margin, window.innerWidth - width - margin))),
      y: Math.max(margin, Math.min(y, Math.max(margin, window.innerHeight - height - margin))),
    };
  }, [margin]);

  useEffect(() => {
    const resize = () => setPosition((current) => current === undefined
      ? undefined
      : boundedPosition(current.x, current.y));
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, [boundedPosition]);

  const onPointerDown = (event: ReactPointerEvent<T>) => {
    if (event.button !== 0) return;
    if (ignoreSelector !== undefined && (event.target as HTMLElement).closest(ignoreSelector) !== null) return;
    const rect = elementRef.current?.getBoundingClientRect();
    if (rect === undefined) return;
    const captureTarget = event.target instanceof HTMLElement ? event.target : event.currentTarget;
    dragRef.current = {
      pointerId: event.pointerId,
      captureTarget,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
    };
    captureTarget.setPointerCapture?.(event.pointerId);
  };

  const onPointerMove = (event: ReactPointerEvent<T>) => {
    const state = dragRef.current;
    if (state === undefined || state.pointerId !== event.pointerId) return;
    if (!state.moved && Math.hypot(event.clientX - state.startX, event.clientY - state.startY) < 4) return;
    state.moved = true;
    setPosition(boundedPosition(event.clientX - state.offsetX, event.clientY - state.offsetY));
    event.preventDefault();
  };

  const stopDragging = (event: ReactPointerEvent<T>) => {
    const state = dragRef.current;
    if (state === undefined || state.pointerId !== event.pointerId) return;
    dragRef.current = undefined;
    if (state.moved) suppressClickRef.current = true;
    state.captureTarget.releasePointerCapture?.(event.pointerId);
  };

  const onClickCapture = (event: ReactMouseEvent<T>) => {
    if (!suppressClickRef.current) return;
    suppressClickRef.current = false;
    event.preventDefault();
    event.stopPropagation();
  };

  return {
    ref: elementRef,
    style: position === undefined ? undefined : {
      left: position.x,
      top: position.y,
      right: 'auto',
    } satisfies CSSProperties,
    dragProps: {
      onPointerDown,
      onPointerMove,
      onPointerUp: stopDragging,
      onPointerCancel: stopDragging,
      onClickCapture,
    },
  };
}
