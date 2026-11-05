import { parsePathOrEmpty, formatPath } from '../../../core/mapping-engine/path';

export interface Point {
  x: number;
  y: number;
}

/** Curva cúbica horizontal entre dois pontos. */
export function connectionPath(a: Point, b: Point): string {
  const distance = Math.max(40, Math.abs(b.x - a.x) * 0.5);
  return `M ${a.x} ${a.y} C ${a.x + distance} ${a.y}, ${b.x - distance} ${b.y}, ${b.x} ${b.y}`;
}

/** Ponto no meio da curva (t = 0,5 em uma cúbica com essa forma). */
export function connectionMiddle(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/** Caminhos de `path` até a raiz, do próprio campo para os ancestrais. */
export function ancestorChain(path: string): string[] {
  let segs;
  try {
    segs = parsePathOrEmpty(path);
  } catch {
    return [];
  }
  const chain: string[] = [];
  for (let i = segs.length; i > 0; i--) chain.push(formatPath(segs.slice(0, i)));
  return chain;
}

/** Mantém o valor dentro do intervalo. */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Zoom ao redor de um ponto da tela: esse ponto continua sobre o mesmo lugar do conteúdo. */
export function zoomAround(
  view: { x: number; y: number; scale: number },
  nextScale: number,
  focus: Point,
): { x: number; y: number; scale: number } {
  const ratio = nextScale / view.scale;
  return {
    scale: nextScale,
    x: focus.x - (focus.x - view.x) * ratio,
    y: focus.y - (focus.y - view.y) * ratio,
  };
}
