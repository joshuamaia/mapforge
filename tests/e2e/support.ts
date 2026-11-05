import { expect, Page, test as base } from '@playwright/test';

/** Falha o teste se houver erro no console, erro não tratado ou requisição para fora da origem. */
export const test = base.extend<{ guard: void }>({
  guard: [
    async ({ page, baseURL }, use) => {
      const errors: string[] = [];
      const external: string[] = [];
      page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
      page.on('console', (m) => {
        if (m.type() === 'error') errors.push(`console: ${m.text()}`);
      });
      page.on('request', (r) => {
        const url = r.url();
        if (
          !url.startsWith(baseURL as string) &&
          !url.startsWith('data:') &&
          !url.startsWith('blob:')
        )
          external.push(url);
      });
      await use();
      expect(errors, 'erros de console').toEqual([]);
      expect(external, 'requisições externas').toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };

export async function setEditor(page: Page, testId: string, value: string): Promise<void> {
  await page.locator(`[data-testid="${testId}"] .monaco-editor`).waitFor();
  await page.evaluate(
    ({ testId, value }) => {
      const host = document.querySelector(`[data-testid="${testId}"]`) as HTMLElement;
      const editors = (
        window as unknown as {
          monaco: {
            editor: {
              getEditors(): { getContainerDomNode(): HTMLElement; setValue(v: string): void }[];
            };
          };
        }
      ).monaco.editor.getEditors();
      const editor = editors.find(
        (e) => host.contains(e.getContainerDomNode()) || e.getContainerDomNode() === host,
      );
      editor?.setValue(value);
    },
    { testId, value },
  );
}

export async function openExample(page: Page, id: string): Promise<void> {
  await page.goto('/examples');
  await page.getByTestId(`open-example-${id}`).click();
  await expect(page).toHaveURL(/studio/);
  await page.getByTestId('canvas').waitFor();
}

/** Studio em projeto novo, com as duas estruturas JSON definidas. */
export async function freshStudio(page: Page, source: unknown, target: unknown): Promise<void> {
  await page.goto('/studio');
  await setEditor(page, 'source-editor', JSON.stringify(source, null, 2));
  await setEditor(page, 'target-editor', JSON.stringify(target, null, 2));
  const firstSource = Object.keys(source as object)[0];
  const firstTarget = Object.keys(target as object)[0];
  await page.getByTestId(`canvas-source-row-${firstSource}`).waitFor();
  await page.getByTestId(`canvas-target-row-${firstTarget}`).waitFor();
}

export function port(page: Page, side: 'source' | 'target', path: string) {
  return page.locator(`.port[data-port-side="${side}"][data-port-path="${path}"]`);
}

/** Arrasta entre dois pontos, com movimentos reais do mouse. */
export async function dragConnect(
  page: Page,
  sourcePath: string,
  targetPath: string,
): Promise<void> {
  const a = (await port(page, 'source', sourcePath).boundingBox())!;
  const b = (await port(page, 'target', targetPath).boundingBox())!;
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 4 });
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 4 });
  await page.mouse.up();
}

export interface LineEnds {
  sx: number;
  sy: number;
  tx: number;
  ty: number;
}

/** Extremos da linha SVG, em coordenadas do viewport do canvas. */
export async function lineEnds(page: Page, index = 0): Promise<LineEnds> {
  const d = await page.locator('.connection-line').nth(index).getAttribute('d');
  const numbers = (d as string).match(/-?\d+(\.\d+)?/g)!.map(Number);
  return {
    sx: numbers[0],
    sy: numbers[1],
    tx: numbers[numbers.length - 2],
    ty: numbers[numbers.length - 1],
  };
}

/** Confere se o extremo da linha coincide com o centro vertical do ponto do campo. */
export async function expectAligned(
  page: Page,
  sourcePath: string,
  targetPath: string,
  index = 0,
): Promise<void> {
  await expect
    .poll(
      async () => {
        const canvas = (await page.getByTestId('canvas').boundingBox())!;
        const ends = await lineEnds(page, index);
        const s = (await port(page, 'source', sourcePath).boundingBox())!;
        const t = (await port(page, 'target', targetPath).boundingBox())!;
        return Math.max(
          Math.abs(ends.sy + canvas.y - (s.y + s.height / 2)),
          Math.abs(ends.ty + canvas.y - (t.y + t.height / 2)),
        );
      },
      { timeout: 4000 },
    )
    .toBeLessThan(1.5);
}

/** Conteúdo completo do editor: o Monaco só renderiza as linhas visíveis. */
export async function editorValue(page: Page, testId: string): Promise<string> {
  return page.evaluate((id) => {
    const host = document.querySelector('[data-testid="' + id + '"]') as HTMLElement;
    const editors = (
      window as unknown as {
        monaco: {
          editor: { getEditors(): { getContainerDomNode(): HTMLElement; getValue(): string }[] };
        };
      }
    ).monaco.editor.getEditors();
    return (
      editors
        .find((e) => host.contains(e.getContainerDomNode()) || e.getContainerDomNode() === host)
        ?.getValue() ?? ''
    );
  }, testId);
}
