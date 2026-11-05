# Motor de mapeamento

O motor fica em `src/app/core/mapping-engine` e não depende de Angular. A entrada é um valor JSON, uma lista de mapeamentos e uma lista de escopos. A saída é um novo valor JSON, com problemas, estatísticas e o rastro das etapas.

```ts
const result = executeMappings({ source, mappings, scopes });
// result.output, result.issues, result.ignored, result.stats, result.traces
```

Garantias:

- A entrada nunca é alterada, e o resultado não compartilha referências com ela (testado com objetos congelados).
- O resultado é determinístico para uma mesma entrada.
- Nenhum código fornecido pelo usuário é executado.

## Mapeamento

```ts
interface Mapping {
  id: string;
  sourcePath: string;     // '' = sem origem, por exemplo com Constant Value
  targetPath: string;
  sourceType: FieldType;
  targetType: FieldType;
  transforms: TransformStep[];
  defaultValue?: JsonValue;
  conditions?: Condition[];
  validationStatus: 'unknown' | 'valid' | 'warning' | 'error';
}
```

## Caminhos

| Sintaxe | Significado |
| --- | --- |
| `cliente.nome` | Propriedades aninhadas |
| `pedidos[*].codigo` | Cada item do array |
| `pedidos[0].codigo` | Item específico, somente na origem |
| `matriz[*][*]` | Arrays aninhados |
| `[*].id` | Array na raiz |
| `dados["chave com ponto.e espaço"]` | Chave arbitrária |

As chaves `__proto__`, `constructor` e `prototype` são rejeitadas. A leitura considera só propriedades próprias do objeto.

## Ordem de execução

1. **Validação.** Caminho inválido, índice fixo no destino, transformação desconhecida ou parâmetro inválido fazem o mapeamento ser ignorado por inteiro, com um erro.
2. **Mapeamentos que definem linhas**, na ordem declarada.
3. **Mapeamentos que copiam valores para linhas existentes**, ou seja, com mais `[*]` no destino do que na origem.

Por causa dessa ordem, o resultado não depende de onde a cópia do valor pai foi declarada.

## Nulo e ausente

| Valor | Passa pelas etapas? | É escrito? |
| --- | --- | --- |
| Valor presente | Sim | Sim |
| `null` | Só nas etapas que tratam nulos | Sim, como `null` |
| Ausente | Só nas etapas que tratam nulos | Não, e entra em "ignorados" |

Se o resultado final for nulo ou ausente e houver `defaultValue`, ele é usado. Condição não atendida não aplica o valor padrão.

Tratam nulos: Default Value, Coalesce, Conditional Mapping, Constant Value, Null Handling, Concat e Count.

## Níveis de array

Sendo S a quantidade de `[*]` na origem e T a do destino, os níveis são alinhados da esquerda para a direita.

| Caso | Exemplo | Comportamento |
| --- | --- | --- |
| S = T | `p[*].a` → `o[*].x` | Um valor por linha |
| S > T | `p[*].a` → `t` | A etapa recebe a lista dos valores; use uma agregação |
| S > T > 0 | `p[*].i[*].q` → `o[*].t` | A lista é montada dentro de cada linha de `o` |
| S < T | `m` → `o[*].x` | Copia para cada linha já criada por outro mapeamento |

Regras complementares:

- Array de origem vazio escreve `[]`. Array ausente, nulo ou com outro tipo não escreve nada; o caso de outro tipo gera um aviso.
- Item coletado sem o campo vira `null`, para preservar a posição.
- Cada linha é criada mesmo que todos os seus campos sejam omitidos.

## Escopos de linha

```ts
interface ArrayScope {
  id: string;
  sourcePath: string; // pedidos[*]
  targetPath: string; // orders[*]
  filter?: Condition[]; // campo relativo ao item
  sort?: { field: string; direction: 'asc' | 'desc' };
  distinctBy?: string;
}
```

O escopo é aplicado na ordem filtro, distinct e ordenação, e produz uma lista de **posições**. Todos os mapeamentos daquele par de arrays iteram as mesmas posições, então os campos de uma linha sempre vêm do mesmo item.

As transformações Filter, Sort, Distinct e Map têm outro papel: operam sobre o valor de um único mapeamento. Para manter vários campos alinhados, use o escopo.

## Etapas

Cada transformação tem um tipo de aplicação:

| Tipo | Com lista na entrada | Exemplos |
| --- | --- | --- |
| `scalar` | Aplica a cada item | Uppercase, Round, Lookup Table |
| `array` | Recebe a lista inteira; com escalar gera erro de conversão | Sum, Filter, Join |
| `any` | Recebe o valor como está | Constant Value, Default Value, Remove Empty Values |

Uma etapa com falha registra um erro de conversão, o valor passa a `null` e as etapas seguintes continuam. Etapas desativadas são ignoradas.

## Condições

Em um mapeamento, `field` é um caminho absoluto. Os `[*]` são vinculados à linha corrente, então `pedidos[*].status` lê o status do mesmo pedido. Em uma coleta, a condição vale por elemento.

Operadores: `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `contains`, `startsWith`, `endsWith`, `in`, `notIn`, `exists`, `notExists`, `empty`, `notEmpty` e `matches`.

As comparações de ordem são numéricas quando os dois lados são numéricos e, caso contrário, por unidade de código, sem depender de localidade. A igualdade compara a forma textual, então `1` é igual a `"1"`.

## Datas

Datas são sempre strings ISO normalizadas e são manipuladas sem `Date`, salvo em conversões de fuso. O resultado não depende do fuso da máquina.

| Forma | Exemplo |
| --- | --- |
| Data | `2024-01-31` |
| Data e hora local | `2024-01-31T10:00:00` |
| Com milissegundos | `2024-01-31T10:00:00.250` |
| Com deslocamento | `2024-01-31T10:00:00-03:00` ou `...Z` |

Tokens de padrão: `yyyy`, `MM`, `dd`, `HH`, `mm`, `ss`, `SSS`, `XXX` e literais entre aspas simples, como `'T'`.

## Equivalência com os geradores

Todos os geradores percorrem o mesmo plano (`code-generators/plan.ts`), a árvore do destino derivada dos mapeamentos. O runtime gerado fica em `code-generators/templates/`, e só as funções usadas entram no código.

`tests/equivalence` executa o código gerado e compara com o motor nos oito exemplos, em entradas vazias e com nulos e, em TypeScript e Java puro, no catálogo de transformações. As diferenças conhecidas estão em "Limitações conhecidas", no README.

Ao alterar uma transformação, mude três lugares: `transformations/catalog.ts`, `templates/runtime.ts.txt` e `templates/runtime.java.txt`. Os testes de equivalência apontam divergências de comportamento nos casos cobertos.

## Diagnósticos

`validators/diagnostics.ts` faz a análise estática, sem executar os mapeamentos.

| Código | Gravidade | Detecta |
| --- | --- | --- |
| `source-missing` | Error, Warning | Campo de origem inexistente ou mapeamento sem valor |
| `target-missing` | Error | Campo de destino inexistente ou inválido |
| `type-incompatible` | Error | Tipo final incompatível com o destino |
| `unsafe-conversion` | Warning | Conversão que pode falhar ou perder informação |
| `duplicate-mapping` | Error, Info | Destino repetido; Info se todos tiverem condições |
| `required-unfilled` | Error | Campo obrigatório sem valor |
| `transform-invalid` | Error, Warning | Configuração inválida ou entrada de tipo errado |
| `circular-reference` | Warning | Ciclo entre mapeamentos ou entre tipos de DTO |
| `path-conflict` | Error | Um destino dentro de outro já mapeado por inteiro |
| `array-incompatible` | Error, Warning, Info | Níveis de array, escopo sem uso ou arrays misturados |
| `unexpected-null` | Warning | Nulo nos dados para um campo que não o admite |
| `structure-invalid` | Error | Estrutura ou dados de entrada inválidos |
| `parser-notice` | Warning, Info | Construção não suportada pelo parser |

O tipo final é propagado pelas etapas (`flowStep`), de modo que `number → Number to String → string` é aceito sem aviso.

## Smart Mapping

`smart-mapping/smart-mapping.ts` divide os nomes em palavras (camelCase, snake_case, kebab-case, sem acentos) e aplica regras em ordem de força.

| Regra | Pontos | Exemplo |
| --- | --- | --- |
| Nomes idênticos | 100 | `id` → `id` |
| Iguais após normalizar | 90 | `nome_completo` → `nomeCompleto` |
| Mesmas palavras em outra ordem | 85 | `totalValue` → `valueTotal` |
| Todas equivalem por sinônimo | 80 | `nomeCompleto` → `fullName` |
| Nomes parecidos | 55 | `endereco` → `enderecos` |
| Metade ou mais das palavras | 45 | `valorPago` → `amountDue` |
| Sinônimo fraco | 40 | `codigoCliente` → `customerId` |

Ajustes: tipo diferente subtrai 15; caminho pai equivalente soma 8 e diferente subtrai 8; mesmo nível de array soma 5 e nível diferente subtrai 25.

Confiança **alta** exige ao menos 75 pontos, com tipo igual ou nome igual após normalizar, e o mesmo nível de array. **Média** exige ao menos 50 pontos. Sinônimo fraco ou nível de array diferente é sempre **baixa**. Tipos incompatíveis não geram sugestão.

Os pontos só ordenam os candidatos e não são exibidos: não representam probabilidade. Cada destino e cada origem recebem no máximo uma sugestão. Em caso de empate, a sugestão é marcada como ambígua e deixa de ser de confiança alta.
