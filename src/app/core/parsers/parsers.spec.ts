import { FieldNode } from '../models/schema.model';
import { inferSchema, parseJsonSafe, parseJsonStructure } from './json-parser';
import { parseJavaStructure } from './java-parser';
import { flattenFields, indexFields, parseStructure, sampleFromSchema } from './structure';
import { parseTypeScriptStructure } from './typescript-parser';

const paths = (root: FieldNode | null): string[] => flattenFields(root).map((n) => n.path);

describe('parser JSON', () => {
  it('identifica tipos, objetos e arrays aninhados', () => {
    const f = indexFields(
      inferSchema({
        id: 1,
        v: 1.5,
        nome: 'a',
        ativo: true,
        nasc: '2020-01-01',
        ts: '2020-01-01T10:00:00Z',
        nulo: null,
        end: { rua: 'x' },
        tags: ['a'],
        vazio: [],
        pedidos: [{ codigo: 1, itens: [{ q: 1 }] }],
        m: [[1]],
      }),
    );
    expect(f.get('id')?.type).toBe('integer');
    expect(f.get('v')?.type).toBe('number');
    expect(f.get('nome')?.type).toBe('string');
    expect(f.get('ativo')?.type).toBe('boolean');
    expect(f.get('nasc')?.type).toBe('date');
    expect(f.get('ts')?.type).toBe('datetime');
    expect(f.get('nulo')?.type).toBe('null');
    expect(f.get('end.rua')?.type).toBe('string');
    expect(f.get('tags')?.itemType).toBe('string');
    expect(f.get('tags[*]')?.type).toBe('string');
    expect(f.get('vazio')?.itemType).toBe('any');
    expect(f.get('pedidos[*].itens[*].q')?.type).toBe('integer');
    expect(f.get('m[*][*]')?.type).toBe('integer');
  });

  it('combina os itens de um array', () => {
    const f = indexFields(
      inferSchema({
        l: [
          { a: 1, b: null },
          { a: 1.5, b: 'x', c: true },
        ],
      }),
    );
    expect(f.get('l[*].a')?.type).toBe('number');
    expect(f.get('l[*].b')?.type).toBe('string');
    expect(f.get('l[*].b')?.nullable).toBe(true);
    expect(f.get('l[*].c')?.type).toBe('boolean');
  });

  it('tipos mistos viram any', () => {
    expect(indexFields(inferSchema({ l: [1, 'a'] })).get('l')?.itemType).toBe('any');
  });

  it('aceita raiz array', () => {
    const s = inferSchema([{ a: 1 }]);
    expect(s.type).toBe('array');
    expect(paths(s)).toEqual(['[*].a']);
  });

  it('informa posição de JSON malformado', () => {
    const r = parseJsonSafe('{\n  "a": 1,\n  "b": \n}');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.kind).toBe('syntax');
      expect(r.line).toBeGreaterThan(1);
    }
    expect(parseJsonSafe('').ok).toBe(false);
  });

  it('respeita os limites de tamanho e profundidade', () => {
    expect(parseJsonSafe('{"a":1}', { maxBytes: 3, maxDepth: 5 })).toMatchObject({
      ok: false,
      kind: 'limit',
    });
    expect(parseJsonSafe('{"a":{"b":{"c":1}}}', { maxBytes: 1000, maxDepth: 2 })).toMatchObject({
      ok: false,
      kind: 'limit',
    });
    expect(parseJsonSafe('{"a":{"b":{"c":1}}}', { maxBytes: 1000, maxDepth: 3 }).ok).toBe(true);
    expect(parseJsonStructure('{', 'r').issues[0].severity).toBe('error');
  });

  it('não polui protótipo com __proto__', () => {
    expect(paths(inferSchema(JSON.parse('{"__proto__":{"x":1},"y":1}')))).toEqual(['y']);
  });
});

describe('parser Java', () => {
  const dto = `
    package com.acme.dto;
    import java.math.BigDecimal;
    import java.util.*;

    /** Comentário com class Falsa { int x; } */
    @Data
    public class ClienteDTO extends Base implements java.io.Serializable {
      private static final long serialVersionUID = 1L;
      private Long id;
      @NotNull @JsonProperty("nome_completo") private String nome;
      private BigDecimal valor;
      private Boolean ativo;
      private int idade, pontos = calc(1, 2);
      private LocalDate nascimento;
      private LocalDateTime criadoEm;
      private Status status = Status.ATIVO;
      private List<Item> itens = new ArrayList<>();
      private Set<String> tags;
      private double[] notas;
      private Endereco endereco;
      private Optional<String> apelido;
      private Map<String, Object> extras;
      private transient String cache;
      @JsonIgnore private String segredo;

      public ClienteDTO() { this.id = 1L; }
      public String getNome() { if (nome == null) { return ""; } return nome; }
      static { System.out.println("x"); }

      public static class Endereco { private String rua; @NotBlank private String cidade; }
      enum Interno { A }
    }
    enum Status { ATIVO("a"), INATIVO("b") { }; private final String c; Status(String c) { this.c = c; } }
    class Item { Integer qtd; BigDecimal preco; }
    class Base { protected String origem; }
  `;

  it('interpreta nome, campos, tipos e anotações', () => {
    const r = parseJavaStructure(dto);
    expect(r.rootName).toBe('ClienteDTO');
    expect(r.packageName).toBe('com.acme.dto');
    const f = indexFields(r.root);
    expect(f.get('origem')?.type).toBe('string');
    expect(f.get('id')?.type).toBe('integer');
    expect(f.get('valor')?.type).toBe('number');
    expect(f.get('valor')?.nativeType).toBe('BigDecimal');
    expect(f.get('ativo')?.type).toBe('boolean');
    expect(f.get('idade')?.type).toBe('integer');
    expect(f.get('pontos')?.type).toBe('integer');
    expect(f.get('nascimento')?.type).toBe('date');
    expect(f.get('criadoEm')?.type).toBe('datetime');
    expect(f.get('status')?.type).toBe('enum');
    expect(f.get('status')?.enumValues).toEqual(['ATIVO', 'INATIVO']);
    expect(f.get('itens')?.type).toBe('array');
    expect(f.get('itens')?.typeName).toBe('Item');
    expect(f.get('itens[*].preco')?.type).toBe('number');
    expect(f.get('tags[*]')?.type).toBe('string');
    expect(f.get('notas[*]')?.type).toBe('number');
    expect(f.get('endereco')?.typeName).toBe('ClienteDTO.Endereco');
    expect(f.get('endereco.cidade')?.required).toBe(true);
    expect(f.get('apelido')?.nullable).toBe(true);
  });

  it('aplica @JsonProperty e @NotNull', () => {
    const n = indexFields(parseJavaStructure(dto).root).get('nome_completo');
    expect(n?.javaName).toBe('nome');
    expect(n?.required).toBe(true);
    expect(n?.annotations).toEqual(['@NotNull', '@JsonProperty']);
  });

  it('ignora static, transient, @JsonIgnore e métodos', () => {
    const p = paths(parseJavaStructure(dto).root);
    for (const x of ['serialVersionUID', 'cache', 'segredo', 'getNome']) expect(p).not.toContain(x);
    expect(parseJavaStructure(dto).issues.some((i) => i.message.includes('cache'))).toBe(true);
  });

  it('avisa sobre Map e tipos desconhecidos em vez de fingir sucesso', () => {
    const r = parseJavaStructure('class A { Map<String,String> m; Desconhecido d; }');
    expect(r.issues.map((i) => i.kind)).toEqual(['unsupported', 'unresolved']);
    expect(indexFields(r.root).get('m')?.type).toBe('any');
  });

  it('interpreta records', () => {
    const r = parseJavaStructure(
      'public record P(@NotNull String nome, int idade, List<String> t) { static int x; P { } }',
    );
    expect(paths(r.root)).toEqual(['nome', 'idade', 't', 't[*]']);
  });

  it('não confunde genéricos no inicializador', () => {
    const r = parseJavaStructure(
      'class A { Map<String, List<Integer>> a = new HashMap<String, List<Integer>>(); int b; }',
    );
    expect(paths(r.root)).toEqual(['a', 'b']);
  });

  it('detecta referência circular', () => {
    const r = parseJavaStructure('class No { String v; No proximo; List<No> filhos; }');
    expect(r.issues.filter((i) => i.kind === 'circular')).toHaveLength(2);
    expect(indexFields(r.root).get('proximo')?.children).toBeUndefined();
  });

  it('seleciona a raiz pedida e a classe não referenciada', () => {
    const text = 'class B { String x; } class A { B b; }';
    expect(parseJavaStructure(text).rootName).toBe('A');
    expect(parseJavaStructure(text, 'B').rootName).toBe('B');
  });

  it.each([
    ['class A { int x', 'fim do arquivo'],
    ['class { }', 'nome do tipo'],
    ['class A { int ; }', 'nome do membro'],
    ['classe A { }', 'declaração'],
    ['/* aberto', 'não terminado'],
  ])('erro de sintaxe explícito: %s', (text, fragment) => {
    const r = parseJavaStructure(text);
    expect(r.root).toBeNull();
    expect(r.issues.at(-1)?.severity).toBe('error');
    expect(r.issues.at(-1)?.message.toLowerCase()).toContain(fragment.toLowerCase());
    expect(r.issues.at(-1)?.line).toBeGreaterThan(0);
  });

  it('interface sozinha é erro explícito', () => {
    const r = parseJavaStructure('public interface X { String a(); }');
    expect(r.root).toBeNull();
    expect(r.issues.some((i) => i.severity === 'error')).toBe(true);
  });
});

describe('parser TypeScript', () => {
  const ts = `
    import { X } from './x';
    export interface Base { createdAt: Date; }
    export interface Customer extends Base {
      readonly id: number;
      fullName: string;
      nick?: string;
      enabled: boolean;
      tags: string[];
      scores: Array<number>;
      address: Address;
      inline: { a: string; b?: number };
      orders: Order[];
      status: 'A' | 'B';
      code: string | null;
      mix: string | number;
      save(): void;
      [k: string]: unknown;
    }
    type Address = { street: string; city?: string };
    interface Order { id: number; kind: Kind }
    enum Kind { X = 'x', Y = 'y', Z }
    const helper = 1;
  `;

  it('interpreta interfaces, aliases e propriedades', () => {
    const r = parseTypeScriptStructure(ts);
    expect(r.rootName).toBe('Customer');
    const f = indexFields(r.root);
    expect(f.get('createdAt')?.type).toBe('datetime');
    expect(f.get('id')).toMatchObject({ type: 'number', required: true });
    expect(f.get('nick')).toMatchObject({ type: 'string', required: false });
    expect(f.get('tags[*]')?.type).toBe('string');
    expect(f.get('scores[*]')?.type).toBe('number');
    expect(f.get('address.city')?.required).toBe(false);
    expect(f.get('inline.a')?.required).toBe(true);
    expect(f.get('orders')?.typeName).toBe('Order');
    expect(f.get('orders[*].kind')).toMatchObject({ type: 'enum', enumValues: ['x', 'y', 'Z'] });
    expect(f.get('status')).toMatchObject({ type: 'enum', enumValues: ['A', 'B'] });
    expect(f.get('code')).toMatchObject({ type: 'string', nullable: true });
    expect(f.get('mix')?.type).toBe('any');
  });

  it('avisa sobre métodos, index signatures e declarações não suportadas', () => {
    const msgs = parseTypeScriptStructure(ts)
      .issues.map((i) => i.message)
      .join('\n');
    expect(msgs).toContain('Método "save"');
    expect(msgs).toContain('Index signature');
    expect(msgs).toContain('Declaração "const"');
  });

  it('type alias de objeto como raiz', () => {
    const r = parseTypeScriptStructure('export type P = { a: number; l: { b: string }[] };');
    expect(r.rootName).toBe('P');
    expect(paths(r.root)).toEqual(['a', 'l', 'l[*].b']);
  });

  it('avisa sobre tuplas, intersection e genéricos', () => {
    const r = parseTypeScriptStructure(
      'interface A { t: [number, string]; i: B & C; g: Partial<B>; f: () => void }',
    );
    expect(r.issues.filter((i) => i.kind === 'unsupported')).toHaveLength(4);
  });

  it('detecta referência circular', () => {
    const r = parseTypeScriptStructure('interface T { v: string; kids: T[] }');
    expect(r.issues.some((i) => i.kind === 'circular')).toBe(true);
  });

  it('erros de sintaxe são explícitos', () => {
    const r = parseTypeScriptStructure('interface A { x: }');
    expect(r.root).toBeNull();
    expect(r.issues.at(-1)?.severity).toBe('error');
    expect(parseTypeScriptStructure('const a = 1;').root).toBeNull();
    expect(parseTypeScriptStructure('type A = string;').root).toBeNull();
  });
});

describe('estrutura', () => {
  it('aplica overrides e gera exemplo do schema', () => {
    const r = parseStructure({
      format: 'typescript',
      text: 'interface A { x: string; y?: number; k: "P"|"Q"; l: { z: boolean }[]; t: string[] }',
      rootName: 'A',
      overrides: { y: { required: true }, x: { type: 'date' } },
    });
    const f = indexFields(r.root);
    expect(f.get('y')?.required).toBe(true);
    expect(f.get('x')?.type).toBe('date');
    expect(sampleFromSchema(r.root)).toEqual({
      x: '2024-01-31',
      y: 12.5,
      k: 'P',
      l: [{ z: true }],
      t: ['exemplo'],
    });
  });
});
