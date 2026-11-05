# Formatos de importação e exportação

## Estruturas

| Formato | Extensão | Implementação |
| --- | --- | --- |
| JSON | `.json` | `parsers/json-parser.ts` |
| Java | `.java` | `parsers/java-parser.ts`, recursive descent |
| TypeScript | `.ts` | `parsers/typescript-parser.ts`, recursive descent |

Os parsers de Java e TypeScript usam um tokenizador próprio, que descarta comentários e guarda linha e coluna. O texto importado nunca é executado.

### JSON

- Tipos: `string`, `integer`, `number`, `boolean`, `date`, `datetime`, `object`, `array` e `null`.
- `date` e `datetime` exigem formato ISO e uma data real: `2024-02-30` é `string`.
- Os itens de um array são combinados em um único schema, usando até 500 itens. `integer` e `number` resultam em `number`; tipos sem relação resultam em `any`.
- JSON malformado gera erro com linha e coluna. Tamanho e profundidade seguem os limites de **Settings**.

### Java

| Construção | Resultado |
| --- | --- |
| `class`, `record`, `enum`, classes aninhadas | Reconhecidas |
| Primitivos e wrappers | `integer`, `number`, `boolean` ou `string` |
| `String`, `CharSequence`, `UUID` | `string` |
| `BigDecimal`, `BigInteger` | `number`, `integer` |
| `LocalDate` | `date` |
| `LocalDateTime`, `OffsetDateTime`, `ZonedDateTime`, `Instant`, `Date`, `Timestamp` | `datetime` |
| `List`, `Set`, `Collection`, `T[]` | `array` |
| `Optional<T>` | `T`, anulável |
| Enum declarado no texto | `enum`, com os valores |
| Classe declarada no texto | `object`, com os campos |
| `extends` de classe declarada | Herda os campos |
| `@JsonProperty("x")` | Usa `x` como chave |
| `@NotNull`, `@NotBlank`, `@NotEmpty`, `@Nonnull`, `@NonNull` | Campo obrigatório |
| `@JsonIgnore`, `transient` | Ignorado, com informação |
| `static` | Ignorado |

| Avisos | Motivo |
| --- | --- |
| `Map<K, V>` | Tratado como `any` |
| Parâmetro genérico da classe | Tratado como `any` |
| Tipo ou superclasse não informados | Sem campos: inclua a declaração no texto |
| Referência circular | Expansão interrompida; também aparece nos diagnósticos |
| `interface` usada como tipo | Sem campos |

Sintaxe inválida gera erro com linha e coluna, e a árvore fica vazia, sem resultado parcial.

Mais de uma classe pode estar no mesmo texto. A raiz é a classe com o nome da raiz da estrutura; na falta dela, a primeira de nível superior que nenhuma outra referencia; e, por último, a primeira declarada.

### TypeScript

| Construção | Resultado |
| --- | --- |
| `interface`, `extends`, `type X = {...}` | Reconhecidas |
| `prop?:` | Campo não obrigatório |
| `readonly` | Ignorado |
| `T[]`, `Array<T>`, `ReadonlyArray<T>`, `Set<T>` | `array` |
| `string`, `number`, `boolean`, `bigint`, `any`, `unknown` | Tipos correspondentes |
| `Date` | `datetime` |
| `T \| null`, `T \| undefined` | `T`, anulável |
| `'A' \| 'B'` | `enum` |
| Outras unions | `any`, com informação |
| `enum` | `enum`, com os valores |
| Objeto literal aninhado | `object` |

Tuplas, intersections, tipos de função, `keyof`, `Record`, `Partial`, `Map`, genéricos e index signatures geram aviso e o campo vira `any` ou é ignorado. Métodos são ignorados com informação. `class`, `function` e `const` no nível superior são ignorados com aviso.

## Arquivo de projeto

Extensão `.mapforge.json`. Gerado por **Export** e lido por **Import**.

```jsonc
{
  "format": "mapforge-project",
  "formatVersion": 1,
  "exportedAt": "2026-11-05T12:00:00.000Z",
  "metadata": {
    "id": "prj_abc",
    "name": "Cliente",
    "description": "",
    "favorite": false,
    "createdAt": "2026-11-05T11:00:00.000Z",
    "updatedAt": "2026-11-05T11:30:00.000Z",
    "exampleId": "cliente"                  // opcional
  },
  "structures": {
    "source": { "format": "json", "text": "{...}", "rootName": "ClienteDTO", "overrides": {} },
    "target": {
      "format": "typescript",
      "text": "interface Customer { id: number }",
      "rootName": "Customer",
      "overrides": { "id": { "required": true, "type": "integer" } }
    },
    "sampleData": "{...}"
  },
  "mappings": [
    {
      "id": "map_1",
      "sourcePath": "cliente.nome",
      "targetPath": "customer.fullName",
      "sourceType": "string",
      "targetType": "string",
      "transforms": [
        { "id": "step_1", "transformId": "trim", "params": {} },
        { "id": "step_2", "transformId": "capitalize", "params": { "allWords": true }, "disabled": true }
      ],
      "defaultValue": "N/A",                 // opcional
      "conditions": [                        // opcional
        { "field": "cliente.ativo", "operator": "eq", "value": true }
      ],
      "validationStatus": "valid"
    }
  ],
  "scopes": [
    {
      "id": "scope_1",
      "sourcePath": "pedidos[*]",
      "targetPath": "orders[*]",
      "filter": [{ "field": "status", "operator": "eq", "value": "PAGO" }],
      "sort": { "field": "valor", "direction": "desc" },
      "distinctBy": "codigo"
    }
  ],
  "settings": {
    "codegen": {
      "target": "java-mapstruct",
      "mapperName": "ClienteMapper",
      "javaPackage": "com.exemplo",
      "comments": true
    }
  }
}
```

### Validação na importação

O arquivo é recusado, sem alterar nada, nestes casos:

- JSON inválido, ou acima de quatro vezes o limite de tamanho configurado.
- `format` diferente de `mapforge-project`.
- `formatVersion` ausente, inválida ou maior que a suportada.
- Metadados, estruturas ou mapeamentos ausentes, ou nome vazio.
- Formato de estrutura ou tipo de campo desconhecidos.
- Caminho inválido ou com chave proibida.
- Transformação, condição ou escopo malformados.

Um `transformId` desconhecido é aceito e aparece em Diagnostics, para não perder o restante do projeto. O `validationStatus` é recalculado, e configurações de geração ausentes ou inválidas assumem o padrão.

Se já existir um projeto com o mesmo `id`, a importação pergunta se deve sobrescrever, importar como cópia ou cancelar.

### Versionamento

`formatVersion` muda quando o formato deixa de ser compatível. A aplicação lê as versões até a sua e recusa as mais novas, com uma mensagem explicativa. Hoje só existe a versão 1.

## Armazenamento local

| Dado | Onde |
| --- | --- |
| Projetos | IndexedDB, banco `mapforge`, tabela `projects` |
| Histórico, até 200 registros | IndexedDB, tabela `executions` |
| Preferências e último projeto aberto | `localStorage` |

O histórico guarda data, duração e contagens, nunca os dados processados.
