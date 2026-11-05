import { readFileSync } from 'node:fs';
import {
  dragConnect,
  editorValue,
  expect,
  expectAligned,
  freshStudio,
  lineEnds,
  openExample,
  port,
  setEditor,
  test,
} from './support';

test.describe('navegação', () => {
  for (const [label, path, heading] of [
    ['Dashboard', '/dashboard', 'Dashboard'],
    ['Transformations', '/transformations', 'Transformations'],
    ['Code Generator', '/code', 'Code Generator'],
    ['Examples', '/examples', 'Examples'],
    ['Saved Projects', '/projects', 'Saved Projects'],
    ['Settings', '/settings', 'Settings'],
  ] as const) {
    test(`rota ${label}`, async ({ page }) => {
      await page.goto('/');
      await page.getByRole('navigation').getByRole('link', { name: label }).click();
      await expect(page).toHaveURL(new RegExp(path));
      await expect(page.getByRole('heading', { name: heading, level: 1 })).toBeVisible();
    });
  }

  test('rota Mapping Studio e editores Monaco', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('navigation').getByRole('link', { name: 'Mapping Studio' }).click();
    await expect(page.getByTestId('source-editor').locator('.monaco-editor')).toBeVisible();
    await expect(page.getByTestId('target-editor').locator('.monaco-editor')).toBeVisible();
  });

  test('alterna o tema', async ({ page }) => {
    await page.goto('/dashboard');
    await page.getByTestId('theme-toggle').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  });
});

test.describe('exemplos', () => {
  for (const id of [
    'cliente',
    'pedido',
    'pagamento',
    'api-legada',
    'java-dto',
    'api-rest',
    'arrays',
  ]) {
    test(`${id} executa e produz o resultado esperado`, async ({ page }) => {
      await openExample(page, id);
      await page.getByTestId('dock-preview').click();
      await expect(page.getByTestId('expected-check')).toHaveText(/Igual ao resultado esperado/);
      await expect(page.locator('.connection').first()).toBeAttached();
    });
  }

  test('erros de mapeamento mostram diagnósticos e destacam a conexão', async ({ page }) => {
    await openExample(page, 'erros');
    const list = page.getByTestId('diagnostics');
    await expect(list.locator('[data-code="type-incompatible"]').first()).toBeVisible();
    await expect(list.locator('[data-code="source-missing"]').first()).toBeVisible();
    await expect(list.locator('[data-code="required-unfilled"]').first()).toBeVisible();
    await list.locator('[data-code="type-incompatible"]').first().click();
    await expect(page.locator('.connection.selected')).toHaveCount(1);
    await expect(page.locator('.connection.selected.is-error')).toHaveCount(1);
    await page.getByTestId('filter-error').click();
    await expect(list.locator('.diagnostic-error')).toHaveCount(0);
  });
});

test.describe('canvas', () => {
  const source = {
    cliente: { nome: 'Ana', idade: 30 },
    pedidos: [
      { codigo: 1, valor: 10.5 },
      { codigo: 2, valor: 20 },
    ],
    ...Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`extra${i}`, i])),
    ultimo: 'fim',
  };
  const target = {
    customer: { name: '', age: 0 },
    orders: [{ id: 0, amount: 1.5 }],
    final: '',
  };

  test('conecta arrastando e gera o resultado', async ({ page }) => {
    await freshStudio(page, source, target);
    await dragConnect(page, 'cliente.nome', 'customer.name');
    await expect(page.locator('.connection')).toHaveCount(1);
    await expect(page.getByTestId('prop-source')).toHaveValue('cliente.nome');
    await expectAligned(page, 'cliente.nome', 'customer.name');
    await page.getByTestId('dock-preview').click();
    await expect(page.getByTestId('preview-output')).toContainText('"name": "Ana"');
  });

  test('conecta pelo teclado', async ({ page }) => {
    await freshStudio(page, source, target);
    await port(page, 'source', 'cliente.nome').focus();
    await page.keyboard.press('Enter');
    await port(page, 'target', 'customer.name').focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('.connection')).toHaveCount(1);
  });

  test('as linhas acompanham zoom, pan, scroll, expansão e recolhimento', async ({ page }) => {
    await freshStudio(page, source, target);
    await dragConnect(page, 'cliente.idade', 'customer.age');
    await expect(page.locator('.connection')).toHaveCount(1);
    await expectAligned(page, 'cliente.idade', 'customer.age');

    await page.getByTestId('zoom-in').click();
    await expect(page.getByTestId('zoom-level')).not.toHaveText('100%');
    await expectAligned(page, 'cliente.idade', 'customer.age');
    await page.getByTestId('zoom-out').click();
    await page.getByTestId('zoom-out').click();
    await expectAligned(page, 'cliente.idade', 'customer.age');

    // Pan pelo fundo.
    const canvas = (await page.getByTestId('canvas').boundingBox())!;
    const before = await lineEnds(page);
    await page.mouse.move(canvas.x + canvas.width / 2, canvas.y + canvas.height - 4);
    await page.mouse.down();
    await page.mouse.move(canvas.x + canvas.width / 2 + 40, canvas.y + canvas.height - 34, {
      steps: 3,
    });
    await page.mouse.up();
    await expect.poll(async () => (await lineEnds(page)).sx).not.toBe(before.sx);
    await expectAligned(page, 'cliente.idade', 'customer.age');

    await page.getByTestId('fit').click();
    await expectAligned(page, 'cliente.idade', 'customer.age');

    // Scroll dentro do cartão: um campo no fim da lista.
    await page.locator('[data-card-scroll="source"]').evaluate((el) => (el.scrollTop = 20));
    await expectAligned(page, 'cliente.idade', 'customer.age');

    // Recolher: a linha passa para o objeto pai e fica aproximada.
    await page
      .getByTestId('canvas-source-row-cliente')
      .getByRole('button', { name: 'Recolher cliente' })
      .click();
    await expect(page.locator('.connection.approximate')).toHaveCount(1);
    await expectAligned(page, 'cliente', 'customer.age');
    // Expandir: volta ao campo.
    await page
      .getByTestId('canvas-source-row-cliente')
      .getByRole('button', { name: 'Expandir cliente' })
      .click();
    await expect(page.locator('.connection.approximate')).toHaveCount(0);
    await expectAligned(page, 'cliente.idade', 'customer.age');

    // O painel lateral compartilha o estado da expansão.
    await page
      .getByTestId('source-panel-row-cliente')
      .getByRole('button', { name: 'Recolher cliente' })
      .click();
    await expect(page.getByTestId('canvas-source-row-cliente.idade')).toHaveCount(0);
  });

  test('campo fora da área visível prende a linha na borda do cartão', async ({ page }) => {
    await freshStudio(page, source, target);
    await page
      .locator('[data-card-scroll="source"]')
      .evaluate((el) => (el.scrollTop = el.scrollHeight));
    await dragConnect(page, 'ultimo', 'final');
    await page.locator('[data-card-scroll="source"]').evaluate((el) => (el.scrollTop = 0));
    await expect(page.locator('.connection.approximate')).toHaveCount(1);
    const box = (await page.locator('[data-card-scroll="source"]').boundingBox())!;
    const canvas = (await page.getByTestId('canvas').boundingBox())!;
    const ends = await lineEnds(page);
    expect(ends.sy + canvas.y).toBeLessThanOrEqual(box.y + box.height + 1);
  });

  test('seleciona, remove, desfaz e refaz', async ({ page }) => {
    await freshStudio(page, source, target);
    await dragConnect(page, 'cliente.nome', 'customer.name');
    await expect(page.locator('.connection.selected')).toHaveCount(1);
    await page.getByTestId('remove-connection').click();
    await expect(page.locator('.connection')).toHaveCount(0);
    await page.getByTestId('undo').click();
    await expect(page.locator('.connection')).toHaveCount(1);
    await page.getByTestId('redo').click();
    await expect(page.locator('.connection')).toHaveCount(0);
    await page.keyboard.press('Control+z');
    await expect(page.locator('.connection')).toHaveCount(1);
    await page.locator('.connection-hit').first().click({ force: true });
    await page.locator('body').press('Delete');
    await expect(page.locator('.connection')).toHaveCount(0);
  });

  test('mapeia arrays, com escopo e agregação', async ({ page }) => {
    await freshStudio(page, source, target);
    await dragConnect(page, 'pedidos[*].codigo', 'orders[*].id');
    await dragConnect(page, 'pedidos[*].valor', 'orders[*].amount');
    await page.getByTestId('dock-preview').click();
    await expect
      .poll(async () =>
        JSON.parse((await page.getByTestId('preview-output').textContent()) as string),
      )
      .toEqual({
        orders: [
          { id: 1, amount: 10.5 },
          { id: 2, amount: 20 },
        ],
      });
  });

  test('indica incompatibilidade na linha', async ({ page }) => {
    await freshStudio(page, { flag: true }, { obj: { a: 1 } });
    await dragConnect(page, 'flag', 'obj');
    await expect(page.locator('.connection.is-error')).toHaveCount(1);
    await expect(page.getByTestId('dock-badge-diagnostics')).toHaveText('1');
  });
});

test.describe('transformações', () => {
  test('aplica etapas com formulário e mostra entrada e saída', async ({ page }) => {
    await freshStudio(page, { nome: '  ana  ' }, { name: '' });
    await dragConnect(page, 'nome', 'name');
    await page.getByTestId('add-transform').selectOption('trim');
    await page.getByTestId('add-transform').selectOption('padEnd');
    await page.getByLabel('Comprimento').fill('5');
    await page.getByLabel('Preenchimento').fill('.');
    await expect(page.getByTestId('trace-trim')).toContainText('"  ana  "');
    await expect(page.getByTestId('trace-trim')).toContainText('"ana"');
    await expect(page.getByTestId('trace-padEnd')).toContainText('"ana.."');
    await expect(page.locator('.connection.selected .connection-label')).toContainText(
      'Trim → PadEnd',
    );
    await page.getByTestId('dock-preview').click();
    await expect(page.getByTestId('preview-output')).toContainText('"name": "ana.."');
  });

  test('catálogo mostra prévia real ao configurar', async ({ page }) => {
    await page.goto('/transformations');
    await page.getByTestId('catalog-replace').click();
    await expect(page.getByTestId('playground-output')).toHaveText('"123456789-00"');
    await page.getByTestId('catalog-stringToNumber').click();
    await page.getByTestId('playground-input').fill('abc');
    await expect(page.getByTestId('playground-error')).toContainText('não é numérico');
    await page.getByTestId('catalog-search').fill('sum');
    await expect(page.getByTestId('catalog-sum')).toBeVisible();
    await expect(page.getByTestId('catalog-trim')).toHaveCount(0);
  });
});

test.describe('Smart Mapping', () => {
  test('sugere, aceita e rejeita', async ({ page }) => {
    await freshStudio(
      page,
      {
        nomeCompleto: 'a',
        dataNascimento: '2000-01-01',
        valorTotal: 1.5,
        ativo: true,
        codigoCliente: 1,
      },
      { fullName: 'x', birthDate: '2001-01-01', totalAmount: 2.5, enabled: false, customerId: 2 },
    );
    await page.getByTestId('open-smart').click();
    const low = page.getByTestId('suggestion-customerId');
    await expect(low).toContainText('Baixa');
    await expect(page.getByTestId('suggestion-fullName')).toContainText('Alta');
    await page.getByTestId('reject-totalAmount').click();
    await expect(page.getByTestId('suggestion-totalAmount')).toHaveCount(0);
    await page.getByTestId('accept-fullName').click();
    await expect(page.locator('.connection')).toHaveCount(1);
    // Em lote, apenas confiança alta: a baixa continua pendente de decisão.
    await page.getByTestId('dock-smart').click();
    await page.getByTestId('smart-accept-high').click();
    await expect(page.locator('.connection')).toHaveCount(3);
    await expect(low).toBeVisible();
  });
});

test.describe('importação de estruturas', () => {
  test('dois DTOs Java com mapeamento visual', async ({ page }) => {
    await page.goto('/studio');
    await page.getByTestId('source-format').selectOption('java');
    await setEditor(
      page,
      'source-editor',
      'public class ClienteDTO { private Long id; @NotNull private String nome; private BigDecimal valor; private Boolean ativo; }',
    );
    await page.getByTestId('target-format').selectOption('java');
    await setEditor(
      page,
      'target-editor',
      'public class CustomerDTO { @NotNull private Long id; private String name; }',
    );
    await expect(page.getByTestId('canvas-source-row-valor')).toContainText('number');
    await expect(page.getByTestId('canvas-target-row-id')).toContainText('*');
    await dragConnect(page, 'id', 'id');
    await expect(page.locator('.connection')).toHaveCount(1);
  });

  test('Java inválido mostra erro explícito', async ({ page }) => {
    await page.goto('/studio');
    await page.getByTestId('source-format').selectOption('java');
    await setEditor(page, 'source-editor', 'public class { }');
    await expect(page.locator('.panel .inline-error').first()).toContainText('nome do tipo');
  });

  test('interface TypeScript por arquivo', async ({ page }) => {
    await page.goto('/studio');
    await page.getByTestId('target-file').setInputFiles({
      name: 'customer.ts',
      mimeType: 'text/plain',
      buffer: Buffer.from(
        'interface Customer { id: number; fullName: string; enabled?: boolean; tags: string[] }',
      ),
    });
    await expect(page.getByTestId('canvas-target-row-tags[*]')).toBeVisible();
    await expect(page.getByTestId('canvas-target-row-id')).toContainText('*');
  });

  test('recusa arquivo de formato desconhecido', async ({ page }) => {
    await page.goto('/studio');
    await page
      .getByTestId('source-file')
      .setInputFiles({ name: 'x.xml', mimeType: 'text/xml', buffer: Buffer.from('<a/>') });
    await expect(page.getByTestId('toast')).toContainText('Formato não suportado');
  });

  test('JSON malformado não quebra a tela', async ({ page }) => {
    await page.goto('/studio');
    await setEditor(page, 'source-editor', '{ "a": ');
    await expect(page.locator('.panel .inline-error').first()).toContainText('JSON inválido');
    await page.getByTestId('source-validate').click();
    await expect(page.getByTestId('toast').first()).toContainText('JSON inválido');
  });

  test('busca campos', async ({ page }) => {
    await freshStudio(page, { alfa: 1, beta: 2 }, { x: 1 });
    await page.getByTestId('source-search').fill('bet');
    await expect(page.getByTestId('canvas-source-row-alfa')).toHaveCount(0);
    await expect(page.getByTestId('canvas-source-row-beta')).toBeVisible();
  });
});

test.describe('Code Generator', () => {
  test('gera todos os tipos, com nome e package configuráveis', async ({ page }) => {
    await openExample(page, 'java-dto');
    await page.getByRole('navigation').getByRole('link', { name: 'Code Generator' }).click();
    const code = () => editorValue(page, 'code-editor');
    await expect(page.getByTestId('code-editor').locator('.monaco-editor')).toBeVisible();
    await expect.poll(code).toContain('@Mapper');
    await page.getByTestId('code-name').fill('FuncMapper');
    await page.getByTestId('code-package').fill('br.com.acme');
    await expect(page.getByTestId('file-FuncMapper.java')).toBeVisible();
    await expect.poll(code).toContain('package br.com.acme;');

    await page.getByTestId('target-java-plain').click();
    await expect.poll(code).toContain('public final class');

    await page.getByTestId('target-typescript').click();
    await expect.poll(code).toContain('export function');

    await page.getByTestId('target-angular-service').click();
    await expect.poll(code).toContain('@Injectable');

    await page.getByTestId('target-ts-interfaces').click();
    await expect.poll(code).toContain('export interface');

    await page.getByTestId('target-java-dto').click();
    await expect(page.locator('.code-tabs [role=tab]').first()).toBeVisible();

    await page.getByTestId('target-typescript').click();
    await page.getByTestId('code-copy').click();
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    expect(clip).toContain('export function');
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByTestId('code-download').click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/\.ts$/);
  });

  test('avisa sobre o que o MapStruct não representa', async ({ page }) => {
    await openExample(page, 'arrays');
    await page.getByRole('navigation').getByRole('link', { name: 'Code Generator' }).click();
    await page.getByTestId('target-java-mapstruct').click();
    await expect(page.getByTestId('code-warnings')).toContainText('MapStruct');
  });
});

test.describe('persistência', () => {
  test('salva, recarrega, recupera, duplica, favorita, busca e exclui', async ({ page }) => {
    await openExample(page, 'cliente');
    await expect(page.getByTestId('dirty')).toHaveCount(0);
    await page.getByTestId('project-name').fill('Meu projeto E2E');
    await page.getByTestId('project-name').blur();
    await expect(page.getByTestId('dirty')).toBeVisible();
    await page.getByTestId('save').click();
    await expect(page.getByTestId('dirty')).toHaveCount(0);

    await page.reload();
    await expect(page.getByTestId('project-name')).toHaveValue('Meu projeto E2E');
    await expect(page.locator('.connection')).toHaveCount(8);

    await page.goto('/projects');
    const row = page.getByTestId('project-Meu projeto E2E');
    await row.getByTestId('duplicate').click();
    const copy = page.getByTestId('project-Meu projeto E2E (cópia)');
    await expect(copy).toBeVisible();

    await row.getByTestId('favorite').click();
    await page.getByTestId('only-favorites').check();
    await expect(copy).toHaveCount(0);
    await page.getByTestId('only-favorites').uncheck();

    await copy.getByTestId('rename').click();
    await page.getByTestId('rename-input').fill('Renomeado');
    await page.getByTestId('rename-input').press('Enter');
    await expect(page.getByTestId('project-Renomeado')).toBeVisible();

    await page.getByTestId('project-search').fill('renome');
    await expect(row).toHaveCount(0);
    await page.getByTestId('project-search').fill('');

    await page.getByTestId('project-Renomeado').getByTestId('delete').click();
    await expect(page.getByRole('alertdialog')).toContainText('Renomeado');
    await page.getByRole('alertdialog').getByRole('button', { name: 'Cancelar' }).click();
    await expect(page.getByTestId('project-Renomeado')).toBeVisible();
    await page.getByTestId('project-Renomeado').getByTestId('delete').click();
    await page.getByTestId('confirm-yes').click();
    await expect(page.getByTestId('project-Renomeado')).toHaveCount(0);

    await page.goto('/dashboard');
    await expect(page.getByTestId('metric-projects')).toHaveText('1');
    await expect(page.getByTestId('metric-mappings')).toHaveText('8');
    await expect(page.getByTestId('favorite-projects')).toContainText('Meu projeto E2E');
    await expect(page.getByTestId('top-transformations')).toContainText('Trim');
  });

  test('exporta e importa sem sobrescrever sem confirmação', async ({ page }) => {
    await openExample(page, 'pedido');
    await page.getByTestId('save').click();
    await expect(page.getByTestId('dirty')).toHaveCount(0);
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByTestId('export').click(),
    ]);
    const text = readFileSync(await download.path(), 'utf8');
    const file = JSON.parse(text);
    expect(file.format).toBe('mapforge-project');
    expect(file.formatVersion).toBe(1);
    expect(file.mappings.length).toBe(9);

    await page.goto('/projects');
    await page
      .getByTestId('projects-import')
      .setInputFiles({ name: 'p.json', mimeType: 'application/json', buffer: Buffer.from(text) });
    await expect(page.getByRole('alertdialog')).toContainText('mesmo identificador');
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: 'Importar como cópia' })
      .click();
    await expect(page.locator('.project-row')).toHaveCount(2);

    await page.getByTestId('projects-import').setInputFiles({
      name: 'ruim.json',
      mimeType: 'application/json',
      buffer: Buffer.from('{"format":"x"}'),
    });
    await expect(page.getByTestId('toast').last()).toContainText('não é um projeto MapForge');
    await expect(page.locator('.project-row')).toHaveCount(2);
  });

  test('avisa antes de descartar alterações', async ({ page }) => {
    await openExample(page, 'cliente');
    await page.getByTestId('project-name').fill('Alterado');
    await page.getByTestId('project-name').blur();
    await page.getByTestId('new-mapping').click();
    await expect(page.getByRole('alertdialog')).toContainText('não salvas');
    await page.getByRole('alertdialog').getByRole('button', { name: 'Cancelar' }).click();
    await expect(page.getByTestId('project-name')).toHaveValue('Alterado');
  });

  test('registra o histórico de execuções', async ({ page }) => {
    await openExample(page, 'cliente');
    await page.getByTestId('toolbar-run').click();
    await page.getByTestId('dock-history').click();
    await expect(page.getByTestId('history-table')).toContainText('Sucesso');
  });
});

test.describe('preview', () => {
  test('atualiza sozinho, mostra métricas, copia e baixa', async ({ page }) => {
    await openExample(page, 'cliente');
    await page.getByTestId('dock-preview').click();
    await expect(page.getByTestId('stat-mapped')).toHaveText('8');
    await expect(page.getByTestId('stat-transforms')).toHaveText('6');
    await expect(page.getByTestId('stat-conversion')).toHaveText('0');
    await expect(page.getByTestId('stat-time')).toContainText('ms');
    await page.getByTestId('source-sample-tab').click();
    await setEditor(page, 'source-sample-editor', '{"codigo": 7, "nomeCompleto": "bia"}');
    await expect(page.getByTestId('preview-output')).toContainText('"fullName": "Bia"');
    await expect(page.getByTestId('expected-check')).toContainText('Diferente');

    await page.getByTestId('copy-result').click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('"id": 7');
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByTestId('download-json').click(),
    ]);
    expect(download.suggestedFilename()).toBe('resultado.json');

    await page.getByTestId('reset-preview').click();
    await expect(page.getByTestId('preview-output')).toHaveCount(0);
  });

  test('mostra erros de conversão', async ({ page }) => {
    await openExample(page, 'erros');
    await page.getByTestId('dock-preview').click();
    await expect(page.getByTestId('stat-conversion')).not.toHaveText('0');
    await expect(page.getByTestId('preview-issues')).toContainText('não é numérico');
  });

  test('regex lenta não trava a interface: o worker é interrompido', async ({ page }) => {
    await page.goto('/settings');
    await page.locator('#set-timeout').fill('800');
    await page.locator('#set-timeout').blur();
    await page.getByRole('navigation').getByRole('link', { name: 'Mapping Studio' }).click();
    await setEditor(page, 'source-editor', JSON.stringify({ a: 'a'.repeat(40) + '!' }));
    await setEditor(page, 'target-editor', JSON.stringify({ b: '' }));
    await dragConnect(page, 'a', 'b');
    await page.getByTestId('add-transform').selectOption('replace');
    await page.getByLabel('Procurar').fill('(a+)+$');
    await page.getByLabel('Expressão regular').check();
    await page.getByTestId('dock-preview').click();
    await expect(page.getByTestId('preview-error')).toContainText('interrompida', {
      timeout: 10000,
    });
    await expect(page.getByTestId('zoom-level')).toBeVisible();
    await page.getByTestId('zoom-in').click();
  });
});

test.describe('layout', () => {
  test('tela estreita alterna os painéis sem rolagem horizontal da página', async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 800 });
    await page.goto('/studio');
    await expect(page.getByTestId('canvas')).toBeVisible();
    await expect(page.getByTestId('source-editor')).toBeHidden();
    await page.getByRole('tab', { name: 'Source', exact: true }).click();
    await expect(page.getByTestId('source-editor')).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test('atalho ? mostra a ajuda de teclado', async ({ page }) => {
    await page.goto('/dashboard');
    await page.locator('body').press('?');
    await expect(page.getByRole('dialog')).toContainText('Atalhos de teclado');
  });
});
