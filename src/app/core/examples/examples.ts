import { JsonValue } from '../models/json.model';
import {
  ArrayScope,
  Condition,
  Mapping,
  TransformParams,
  TransformStep,
} from '../models/mapping.model';
import { DiagnosticCode } from '../models/diagnostic.model';
import {
  CodegenSettings,
  defaultCodegen,
  ProjectDocument,
  StructureDefinition,
} from '../models/project.model';
import { StructureFormat } from '../models/schema.model';
import { indexFields, parseStructure } from '../parsers/structure';

export interface ExampleDefinition {
  id: string;
  number: number;
  title: string;
  description: string;
  highlights: string[];
  document: ProjectDocument;
  /** Resultado esperado da execução sobre `document.sampleData`. */
  expectedOutput: JsonValue;
  /** Diagnósticos que o exemplo deve produzir. */
  expectedDiagnostics?: DiagnosticCode[];
}

type StepSpec = [string, TransformParams?];

interface MappingSpec {
  from: string;
  to: string;
  steps?: StepSpec[];
  defaultValue?: JsonValue;
  conditions?: Condition[];
}

const structure = (
  format: StructureFormat,
  text: string,
  rootName: string,
  required: string[] = [],
): StructureDefinition => ({
  format,
  text,
  rootName,
  overrides: Object.fromEntries(required.map((p) => [p, { required: true }])),
});

const pretty = (v: JsonValue): string => JSON.stringify(v, null, 2);

function buildDocument(
  id: string,
  source: StructureDefinition,
  target: StructureDefinition,
  sample: JsonValue,
  specs: MappingSpec[],
  scopes: Omit<ArrayScope, 'id'>[] = [],
  codegen: Partial<CodegenSettings> = {},
): ProjectDocument {
  const sourceFields = indexFields(parseStructure(source).root);
  const targetFields = indexFields(parseStructure(target).root);
  const mappings: Mapping[] = specs.map((spec, i) => ({
    id: `${id}-m${i + 1}`,
    sourcePath: spec.from,
    targetPath: spec.to,
    sourceType: sourceFields.get(spec.from)?.type ?? 'any',
    targetType: targetFields.get(spec.to)?.type ?? 'any',
    transforms: (spec.steps ?? []).map(([transformId, params], j): TransformStep => ({
      id: `${id}-m${i + 1}-s${j + 1}`,
      transformId,
      params: params ?? {},
    })),
    ...(spec.defaultValue !== undefined ? { defaultValue: spec.defaultValue } : {}),
    ...(spec.conditions ? { conditions: spec.conditions } : {}),
    validationStatus: 'unknown',
  }));
  return {
    source,
    target,
    sampleData: pretty(sample),
    mappings,
    scopes: scopes.map((s, i) => ({ ...s, id: `${id}-scope${i + 1}` })),
    codegen: { ...defaultCodegen(), ...codegen },
  };
}

// ------------------------------------------------------------------ 1. Cliente

const clienteSample: JsonValue = {
  codigo: 1042,
  nomeCompleto: '  ana maria de souza ',
  dataNascimento: '15/03/1990',
  ativo: 'S',
  email: 'ANA.SOUZA@EXEMPLO.COM',
  endereco: { logradouro: 'Rua das Flores, 100', cidade: 'São Paulo', uf: 'SP' },
};

const cliente: ExampleDefinition = {
  id: 'cliente',
  number: 1,
  title: 'Cliente',
  description: 'ClienteDTO em português para CustomerDTO em inglês, com datas, nomes e booleanos.',
  highlights: ['Objetos aninhados', 'Conversão de tipos', 'Encadeamento de etapas'],
  document: buildDocument(
    'cliente',
    structure('json', pretty(clienteSample), 'ClienteDTO'),
    structure(
      'json',
      pretty({
        id: 0,
        fullName: '',
        birthDate: '2000-01-31',
        enabled: true,
        email: '',
        address: { street: '', city: '', state: '' },
      }),
      'CustomerDTO',
      ['id', 'fullName'],
    ),
    clienteSample,
    [
      { from: 'codigo', to: 'id' },
      {
        from: 'nomeCompleto',
        to: 'fullName',
        steps: [['trim'], ['capitalize', { allWords: true }]],
      },
      {
        from: 'dataNascimento',
        to: 'birthDate',
        steps: [['stringToDate', { pattern: 'dd/MM/yyyy' }]],
      },
      {
        from: 'ativo',
        to: 'enabled',
        steps: [['stringToBoolean', { trueValues: 's', falseValues: 'n' }]],
      },
      { from: 'email', to: 'email', steps: [['lowercase']] },
      { from: 'endereco.logradouro', to: 'address.street' },
      { from: 'endereco.cidade', to: 'address.city', steps: [['removeAccents']] },
      { from: 'endereco.uf', to: 'address.state' },
    ],
    [],
    { mapperName: 'ClienteMapper', target: 'typescript' },
  ),
  expectedOutput: {
    id: 1042,
    fullName: 'Ana Maria De Souza',
    birthDate: '1990-03-15',
    enabled: true,
    email: 'ana.souza@exemplo.com',
    address: { street: 'Rua das Flores, 100', city: 'Sao Paulo', state: 'SP' },
  },
};

// ------------------------------------------------------------------ 2. Pedido

const pedidoSample: JsonValue = {
  numero: 'PED-2024-001',
  moeda: 'BRL',
  itens: [
    { sku: 'CAM-01', descricao: 'Camiseta', quantidade: 2, precoUnitario: 49.9 },
    { sku: 'CAL-07', descricao: 'Calça', quantidade: 1, precoUnitario: 159.5 },
    { sku: 'MEI-03', descricao: 'Meia', quantidade: 3, precoUnitario: 12.25 },
  ],
};

const pedido: ExampleDefinition = {
  id: 'pedido',
  number: 2,
  title: 'Pedido',
  description: 'Pedido com lista de itens, valores monetários e total calculado por agregação.',
  highlights: ['Listas de objetos', 'Valores monetários', 'Valor do pai em cada item'],
  document: buildDocument(
    'pedido',
    structure('json', pretty(pedidoSample), 'Pedido'),
    structure(
      'json',
      pretty({
        orderNumber: '',
        itemCount: 0,
        items: [
          { sku: '', name: '', quantity: 0, unitPrice: 1.5, unitPriceLabel: '', currency: '' },
        ],
        highestUnitPrice: 1.5,
      }),
      'Order',
    ),
    pedidoSample,
    [
      { from: 'numero', to: 'orderNumber' },
      { from: 'itens[*].sku', to: 'itemCount', steps: [['count']] },
      { from: 'itens[*].sku', to: 'items[*].sku' },
      { from: 'itens[*].descricao', to: 'items[*].name', steps: [['uppercase']] },
      { from: 'itens[*].quantidade', to: 'items[*].quantity' },
      { from: 'itens[*].precoUnitario', to: 'items[*].unitPrice' },
      {
        from: 'itens[*].precoUnitario',
        to: 'items[*].unitPriceLabel',
        steps: [['numberToString', { digits: 2 }]],
      },
      { from: 'moeda', to: 'items[*].currency' },
      { from: 'itens[*].precoUnitario', to: 'highestUnitPrice', steps: [['max']] },
    ],
    [],
    { mapperName: 'PedidoMapper', target: 'java-plain', javaPackage: 'com.exemplo.pedido' },
  ),
  expectedOutput: {
    orderNumber: 'PED-2024-001',
    itemCount: 3,
    items: [
      {
        sku: 'CAM-01',
        name: 'CAMISETA',
        quantity: 2,
        unitPrice: 49.9,
        unitPriceLabel: '49.90',
        currency: 'BRL',
      },
      {
        sku: 'CAL-07',
        name: 'CALÇA',
        quantity: 1,
        unitPrice: 159.5,
        unitPriceLabel: '159.50',
        currency: 'BRL',
      },
      {
        sku: 'MEI-03',
        name: 'MEIA',
        quantity: 3,
        unitPrice: 12.25,
        unitPriceLabel: '12.25',
        currency: 'BRL',
      },
    ],
    highestUnitPrice: 159.5,
  },
};

// ------------------------------------------------------------------ 3. Pagamento

const pagamentoSample: JsonValue = {
  transacao: {
    id: 'TX-9981',
    situacao: 'APROVADO',
    valorCentavos: 125990,
    criadaEm: '2024-05-17T12:30:00Z',
    vencimento: '20240620',
  },
  pagador: { documento: '123.456.789-00', nome: null },
  metodo: { tipo: 'CC', parcelas: 3 },
};

const pagamento: ExampleDefinition = {
  id: 'pagamento',
  number: 3,
  title: 'Pagamento',
  description: 'Status, valores, datas com fuso horário e propriedades aninhadas.',
  highlights: ['Enum Mapping', 'Timezone', 'Valor padrão', 'Lookup Table'],
  document: buildDocument(
    'pagamento',
    structure('json', pretty(pagamentoSample), 'PagamentoLegado'),
    structure(
      'json',
      pretty({
        paymentId: '',
        status: '',
        amount: 1.5,
        amountLabel: '',
        createdAt: '2024-01-01T00:00:00-03:00',
        createdYear: 2024,
        dueDate: '2024-01-01',
        payer: { document: '', name: '' },
        method: '',
        installments: 1,
      }),
      'Payment',
    ),
    pagamentoSample,
    [
      { from: 'transacao.id', to: 'paymentId' },
      {
        from: 'transacao.situacao',
        to: 'status',
        steps: [
          [
            'enumMap',
            {
              table: { APROVADO: 'PAID', PENDENTE: 'PENDING', RECUSADO: 'DECLINED' },
              strict: true,
            },
          ],
        ],
      },
      {
        from: 'transacao.valorCentavos',
        to: 'amount',
        steps: [
          ['divide', { operand: 100 }],
          ['precision', { digits: 2 }],
        ],
      },
      {
        from: 'transacao.valorCentavos',
        to: 'amountLabel',
        steps: [
          ['divide', { operand: 100 }],
          ['numberToString', { digits: 2 }],
          ['concat', { prefix: 'R$ ' }],
        ],
      },
      {
        from: 'transacao.criadaEm',
        to: 'createdAt',
        steps: [['convertTimezone', { from: 'UTC', to: 'America/Sao_Paulo' }]],
      },
      { from: 'transacao.criadaEm', to: 'createdYear', steps: [['datePart', { part: 'year' }]] },
      {
        from: 'transacao.vencimento',
        to: 'dueDate',
        steps: [['formatDate', { inputPattern: 'yyyyMMdd', pattern: 'yyyy-MM-dd' }]],
      },
      {
        from: 'pagador.documento',
        to: 'payer.document',
        steps: [['replace', { search: '[.-]', replacement: '', regex: true }]],
      },
      { from: 'pagador.nome', to: 'payer.name', defaultValue: 'Não informado' },
      {
        from: 'metodo.tipo',
        to: 'method',
        steps: [
          ['lookup', { table: { CC: 'CREDIT_CARD', PX: 'PIX', BO: 'BOLETO' }, fallback: 'OTHER' }],
        ],
      },
      { from: 'metodo.parcelas', to: 'installments' },
    ],
    [],
    { mapperName: 'PagamentoMapper', target: 'typescript' },
  ),
  expectedOutput: {
    paymentId: 'TX-9981',
    status: 'PAID',
    amount: 1259.9,
    amountLabel: 'R$ 1259.90',
    createdAt: '2024-05-17T09:30:00-03:00',
    createdYear: 2024,
    dueDate: '2024-06-20',
    payer: { document: '12345678900', name: 'Não informado' },
    method: 'CREDIT_CARD',
    installments: 3,
  },
};

// ------------------------------------------------------------------ 4. API legada

const legadoSample: JsonValue = {
  COD_CLI: '00042',
  NOM_CLI: 'SILVA, JOAO',
  FLG_ATIVO: 'N',
  DT_CAD: '31/12/2019 08:15',
  VL_SALDO: '1.234,56',
  TEL_RES: null,
  TEL_COM: '11 3333-4444',
  TAGS: 'vip;atacado;;sul',
};

const legado: ExampleDefinition = {
  id: 'api-legada',
  number: 4,
  title: 'API Legada',
  description: 'Registro plano e antigo convertido para uma estrutura moderna e aninhada.',
  highlights: ['String to Number', 'Coalesce', 'Split e Remove Empty', 'Constantes'],
  document: buildDocument(
    'legado',
    structure('json', pretty(legadoSample), 'RegistroLegado'),
    structure(
      'json',
      pretty({
        id: 1,
        name: { display: '', last: '' },
        active: true,
        registeredAt: '2024-01-01T00:00:00',
        balance: 1.5,
        phone: '',
        tags: [''],
        schemaVersion: 2,
      }),
      'ClienteModerno',
    ),
    legadoSample,
    [
      { from: 'COD_CLI', to: 'id', steps: [['stringToNumber']] },
      {
        from: 'NOM_CLI',
        to: 'name.display',
        steps: [
          ['replace', { search: ', ', replacement: ' ' }],
          ['capitalize', { allWords: true }],
        ],
      },
      {
        from: 'NOM_CLI',
        to: 'name.last',
        steps: [['split', { separator: ',' }], ['first'], ['capitalize', { allWords: true }]],
      },
      {
        from: 'FLG_ATIVO',
        to: 'active',
        steps: [['stringToBoolean', { trueValues: 's', falseValues: 'n' }]],
      },
      {
        from: 'DT_CAD',
        to: 'registeredAt',
        steps: [['stringToDate', { pattern: 'dd/MM/yyyy HH:mm' }]],
      },
      { from: 'VL_SALDO', to: 'balance', steps: [['stringToNumber', { decimalSeparator: ',' }]] },
      { from: 'TEL_RES', to: 'phone', steps: [['coalesce', { paths: ['TEL_COM'] }]] },
      { from: 'TAGS', to: 'tags', steps: [['split', { separator: ';' }], ['removeEmpty']] },
      { from: '', to: 'schemaVersion', steps: [['constant', { value: 2 }]] },
    ],
    [],
    { mapperName: 'LegadoMapper', target: 'typescript' },
  ),
  expectedOutput: {
    id: 42,
    name: { display: 'Silva Joao', last: 'Silva' },
    active: false,
    registeredAt: '2019-12-31T08:15:00',
    balance: 1234.56,
    phone: '11 3333-4444',
    tags: ['vip', 'atacado', 'sul'],
    schemaVersion: 2,
  },
};

// ------------------------------------------------------------------ 5. Java DTO para Java DTO

const javaSource = `package com.exemplo.dto;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.List;

public class FuncionarioDTO {
    private Long matricula;
    @NotNull
    private String nome;
    private BigDecimal salario;
    private Boolean ativo;
    private LocalDate admissao;
    private Departamento departamento;
    private List<Dependente> dependentes;

    public Long getMatricula() { return matricula; }
    public void setMatricula(Long matricula) { this.matricula = matricula; }
    public String getNome() { return nome; }
    public void setNome(String nome) { this.nome = nome; }
    public BigDecimal getSalario() { return salario; }
    public void setSalario(BigDecimal salario) { this.salario = salario; }
    public Boolean getAtivo() { return ativo; }
    public void setAtivo(Boolean ativo) { this.ativo = ativo; }
    public LocalDate getAdmissao() { return admissao; }
    public void setAdmissao(LocalDate admissao) { this.admissao = admissao; }
    public Departamento getDepartamento() { return departamento; }
    public void setDepartamento(Departamento departamento) { this.departamento = departamento; }
    public List<Dependente> getDependentes() { return dependentes; }
    public void setDependentes(List<Dependente> dependentes) { this.dependentes = dependentes; }
}

class Departamento {
    private String sigla;
    private String nome;

    public String getSigla() { return sigla; }
    public void setSigla(String sigla) { this.sigla = sigla; }
    public String getNome() { return nome; }
    public void setNome(String nome) { this.nome = nome; }
}

class Dependente {
    private String nome;
    private Integer idade;

    public String getNome() { return nome; }
    public void setNome(String nome) { this.nome = nome; }
    public Integer getIdade() { return idade; }
    public void setIdade(Integer idade) { this.idade = idade; }
}
`;

const javaTarget = `package com.exemplo.dto;

import java.math.BigDecimal;
import java.util.List;

public class EmployeeDTO {
    @NotNull
    private Long id;
    private String fullName;
    private BigDecimal salary;
    private Boolean enabled;
    private String hiredOn;
    private String departmentCode;
    private List<DependentDTO> dependents;

    public Long getId() { return id; }
    public void setId(Long id) { this.id = id; }
    public String getFullName() { return fullName; }
    public void setFullName(String fullName) { this.fullName = fullName; }
    public BigDecimal getSalary() { return salary; }
    public void setSalary(BigDecimal salary) { this.salary = salary; }
    public Boolean getEnabled() { return enabled; }
    public void setEnabled(Boolean enabled) { this.enabled = enabled; }
    public String getHiredOn() { return hiredOn; }
    public void setHiredOn(String hiredOn) { this.hiredOn = hiredOn; }
    public String getDepartmentCode() { return departmentCode; }
    public void setDepartmentCode(String departmentCode) { this.departmentCode = departmentCode; }
    public List<DependentDTO> getDependents() { return dependents; }
    public void setDependents(List<DependentDTO> dependents) { this.dependents = dependents; }
}

class DependentDTO {
    private String name;
    private Integer age;

    public String getName() { return name; }
    public void setName(String name) { this.name = name; }
    public Integer getAge() { return age; }
    public void setAge(Integer age) { this.age = age; }
}
`;

const funcionarioSample: JsonValue = {
  matricula: 7788,
  nome: 'Carla Mendes',
  salario: 8500.75,
  ativo: true,
  admissao: '2021-03-01',
  departamento: { sigla: 'ti', nome: 'Tecnologia' },
  dependentes: [
    { nome: 'Rui', idade: 9 },
    { nome: 'Lia', idade: 5 },
  ],
};

const javaDto: ExampleDefinition = {
  id: 'java-dto',
  number: 5,
  title: 'Java DTO para Java DTO',
  description: 'Importa duas classes Java e gera um mapper MapStruct compilável.',
  highlights: ['Parser Java', 'MapStruct', '@NotNull', 'List<T>'],
  document: buildDocument(
    'java',
    structure('java', javaSource, 'FuncionarioDTO'),
    structure('java', javaTarget, 'EmployeeDTO'),
    funcionarioSample,
    [
      { from: 'matricula', to: 'id' },
      { from: 'nome', to: 'fullName' },
      { from: 'salario', to: 'salary' },
      { from: 'ativo', to: 'enabled' },
      { from: 'admissao', to: 'hiredOn', steps: [['dateToString', { pattern: 'dd/MM/yyyy' }]] },
      { from: 'departamento.sigla', to: 'departmentCode', steps: [['uppercase']] },
      { from: 'dependentes[*].nome', to: 'dependents[*].name' },
      { from: 'dependentes[*].idade', to: 'dependents[*].age' },
    ],
    [],
    { mapperName: 'EmployeeMapper', target: 'java-mapstruct', javaPackage: 'com.exemplo.dto' },
  ),
  expectedOutput: {
    id: 7788,
    fullName: 'Carla Mendes',
    salary: 8500.75,
    enabled: true,
    hiredOn: '01/03/2021',
    departmentCode: 'TI',
    dependents: [
      { name: 'Rui', age: 9 },
      { name: 'Lia', age: 5 },
    ],
  },
};

// ------------------------------------------------------------------ 6. API REST para Frontend

const apiSample: JsonValue = {
  data: {
    id: 55,
    attributes: {
      first_name: 'Marina',
      last_name: 'Costa',
      avatar_url: null,
      created_at: '2023-11-20T14:05:00',
      plan: 'pro',
    },
    relationships: {
      projects: [
        { id: 1, title: 'Portal', stars: 42, archived: false },
        { id: 2, title: 'Mobile', stars: 7, archived: true },
      ],
    },
  },
  meta: { request_id: 'abc-123' },
};

const viewModel = `export interface UserCardViewModel {
  id: number;
  displayName: string;
  avatar: string;
  memberSince: string;
  planLabel: string;
  isPremium: boolean;
  projectTitles: string[];
  totalStars: number;
  projects: ProjectChip[];
}

export interface ProjectChip {
  id: number;
  label: string;
  active: boolean;
}
`;

const apiRest: ExampleDefinition = {
  id: 'api-rest',
  number: 6,
  title: 'API REST para Frontend',
  description: 'Resposta de API em um ViewModel Angular, descrito por uma interface TypeScript.',
  highlights: ['Parser TypeScript', 'Angular Service', 'Concat de campos', 'Conditional'],
  document: buildDocument(
    'api',
    structure('json', pretty(apiSample), 'ApiUserResponse'),
    structure('typescript', viewModel, 'UserCardViewModel'),
    apiSample,
    [
      { from: 'data.id', to: 'id' },
      {
        from: 'data.attributes.first_name',
        to: 'displayName',
        steps: [['concat', { fields: ['data.attributes.last_name'], separator: ' ' }]],
      },
      {
        from: 'data.attributes.avatar_url',
        to: 'avatar',
        defaultValue: 'assets/avatar-padrao.png',
      },
      {
        from: 'data.attributes.created_at',
        to: 'memberSince',
        steps: [['dateToString', { pattern: 'MM/yyyy' }]],
      },
      {
        from: 'data.attributes.plan',
        to: 'planLabel',
        steps: [
          ['lookup', { table: { free: 'Gratuito', pro: 'Profissional' }, keepUnmatched: true }],
        ],
      },
      {
        from: 'data.attributes.plan',
        to: 'isPremium',
        steps: [
          [
            'conditional',
            { operator: 'in', compare: 'pro,enterprise', thenValue: true, elseValue: false },
          ],
        ],
      },
      { from: 'data.relationships.projects[*].title', to: 'projectTitles' },
      { from: 'data.relationships.projects[*].stars', to: 'totalStars', steps: [['sum']] },
      { from: 'data.relationships.projects[*].id', to: 'projects[*].id' },
      {
        from: 'data.relationships.projects[*].title',
        to: 'projects[*].label',
        steps: [['uppercase']],
      },
      {
        from: 'data.relationships.projects[*].archived',
        to: 'projects[*].active',
        steps: [
          ['conditional', { operator: 'eq', compare: false, thenValue: true, elseValue: false }],
        ],
      },
    ],
    [],
    { mapperName: 'UserCard', target: 'angular-service' },
  ),
  expectedOutput: {
    id: 55,
    displayName: 'Marina Costa',
    avatar: 'assets/avatar-padrao.png',
    memberSince: '11/2023',
    planLabel: 'Profissional',
    isPremium: true,
    projectTitles: ['Portal', 'Mobile'],
    totalStars: 49,
    projects: [
      { id: 1, label: 'PORTAL', active: true },
      { id: 2, label: 'MOBILE', active: false },
    ],
  },
};

// ------------------------------------------------------------------ 7. Arrays avançados

const arraysSample: JsonValue = {
  loja: 'Centro',
  vendas: [
    {
      id: 1,
      vendedor: 'Ana',
      regiao: 'Sul',
      valor: 300,
      status: 'PAGO',
      itens: [
        { sku: 'A', qtd: 1 },
        { sku: 'B', qtd: 2 },
      ],
      tags: ['novo', 'promo'],
    },
    {
      id: 2,
      vendedor: 'Bia',
      regiao: 'Norte',
      valor: 120.5,
      status: 'CANCELADO',
      itens: [{ sku: 'A', qtd: 5 }],
      tags: [],
    },
    {
      id: 3,
      vendedor: 'Ana',
      regiao: 'Sul',
      valor: 950,
      status: 'PAGO',
      itens: [{ sku: 'C', qtd: 1 }],
      tags: ['vip'],
    },
    {
      id: 4,
      vendedor: 'Caio',
      regiao: 'Leste',
      valor: 75.25,
      status: 'PAGO',
      itens: [],
      tags: ['promo'],
    },
  ],
};

const arrays: ExampleDefinition = {
  id: 'arrays',
  number: 7,
  title: 'Arrays avançados',
  description:
    'Filtros, ordenação, distinct, agregações e listas aninhadas sem misturar as linhas.',
  highlights: ['Filter', 'Sort', 'Distinct', 'Sum, Average, Min, Max', 'First, Last, Count'],
  document: buildDocument(
    'arrays',
    structure('json', pretty(arraysSample), 'RelatorioVendas'),
    structure(
      'json',
      pretty({
        store: '',
        paidSales: [
          {
            id: 1,
            seller: '',
            amount: 1.5,
            store: '',
            units: 1,
            lines: [{ sku: '', quantity: 1 }],
          },
        ],
        sellers: [{ name: '', region: '' }],
        summary: {
          count: 1,
          total: 1.5,
          average: 1.5,
          lowest: 1.5,
          highest: 1.5,
          firstId: 1,
          lastId: 1,
          regions: [''],
          bigSaleIds: [1],
          allTags: [''],
        },
      }),
      'RelatorioResumo',
    ),
    arraysSample,
    [
      { from: 'loja', to: 'store' },
      { from: 'vendas[*].id', to: 'paidSales[*].id' },
      { from: 'vendas[*].vendedor', to: 'paidSales[*].seller' },
      { from: 'vendas[*].valor', to: 'paidSales[*].amount' },
      { from: 'loja', to: 'paidSales[*].store' },
      { from: 'vendas[*].itens[*].qtd', to: 'paidSales[*].units', steps: [['sum']] },
      { from: 'vendas[*].itens[*].sku', to: 'paidSales[*].lines[*].sku' },
      { from: 'vendas[*].itens[*].qtd', to: 'paidSales[*].lines[*].quantity' },
      { from: 'vendas[*].vendedor', to: 'sellers[*].name' },
      { from: 'vendas[*].regiao', to: 'sellers[*].region' },
      { from: 'vendas[*].id', to: 'summary.count', steps: [['count']] },
      { from: 'vendas[*].valor', to: 'summary.total', steps: [['sum']] },
      {
        from: 'vendas[*].valor',
        to: 'summary.average',
        steps: [['average'], ['round', { digits: 2 }]],
      },
      { from: 'vendas[*].valor', to: 'summary.lowest', steps: [['min']] },
      { from: 'vendas[*].valor', to: 'summary.highest', steps: [['max']] },
      { from: 'vendas[*].id', to: 'summary.firstId', steps: [['first']] },
      { from: 'vendas[*].id', to: 'summary.lastId', steps: [['last']] },
      {
        from: 'vendas[*].regiao',
        to: 'summary.regions',
        steps: [['distinct'], ['sort', { direction: 'asc' }]],
      },
      {
        from: 'vendas',
        to: 'summary.bigSaleIds',
        steps: [
          ['filter', { field: 'valor', operator: 'gte', value: 200 }],
          ['sort', { field: 'valor', direction: 'desc' }],
          ['map', { field: 'id' }],
        ],
      },
      { from: 'vendas[*].tags[*]', to: 'summary.allTags', steps: [['distinct'], ['uppercase']] },
    ],
    [
      {
        sourcePath: 'vendas[*]',
        targetPath: 'paidSales[*]',
        filter: [{ field: 'status', operator: 'eq', value: 'PAGO' }],
        sort: { field: 'valor', direction: 'desc' },
      },
      { sourcePath: 'vendas[*]', targetPath: 'sellers[*]', distinctBy: 'vendedor' },
    ],
    { mapperName: 'RelatorioMapper', target: 'typescript' },
  ),
  expectedOutput: {
    store: 'Centro',
    paidSales: [
      {
        id: 3,
        seller: 'Ana',
        amount: 950,
        store: 'Centro',
        units: 1,
        lines: [{ sku: 'C', quantity: 1 }],
      },
      {
        id: 1,
        seller: 'Ana',
        amount: 300,
        store: 'Centro',
        units: 3,
        lines: [
          { sku: 'A', quantity: 1 },
          { sku: 'B', quantity: 2 },
        ],
      },
      { id: 4, seller: 'Caio', amount: 75.25, store: 'Centro', units: 0, lines: [] },
    ],
    sellers: [
      { name: 'Ana', region: 'Sul' },
      { name: 'Bia', region: 'Norte' },
      { name: 'Caio', region: 'Leste' },
    ],
    summary: {
      count: 4,
      total: 1445.75,
      average: 361.44,
      lowest: 75.25,
      highest: 950,
      firstId: 1,
      lastId: 4,
      regions: ['Leste', 'Norte', 'Sul'],
      bigSaleIds: [3, 1],
      allTags: ['NOVO', 'PROMO', 'VIP'],
    },
  },
};

// ------------------------------------------------------------------ 8. Erros de mapeamento

const errosSample: JsonValue = {
  nome: 'Teste',
  idade: 'trinta',
  ativo: true,
  observacao: null,
  itens: [{ valor: 10 }, { valor: 20 }],
  outros: [{ valor: 1 }],
};

const erros: ExampleDefinition = {
  id: 'erros',
  number: 8,
  title: 'Erros de mapeamento',
  description: 'Incompatibilidade de tipos, campos ausentes e os diagnósticos correspondentes.',
  highlights: ['Mapping Diagnostics', 'Erros de conversão', 'Campos obrigatórios'],
  document: buildDocument(
    'erros',
    structure('json', pretty(errosSample), 'EntradaComProblemas'),
    structure(
      'json',
      pretty({
        name: '',
        age: 1,
        address: { city: '' },
        total: 1,
        notes: '',
        email: '',
        rows: [{ a: 1, b: 1 }],
        label: '',
      }),
      'SaidaEsperada',
      ['email', 'notes'],
    ),
    errosSample,
    [
      { from: 'nome', to: 'name' },
      { from: 'idade', to: 'age', steps: [['stringToNumber']] },
      { from: 'ativo', to: 'address' },
      { from: 'campoQueNaoExiste', to: 'label' },
      { from: 'nome', to: 'campoDestinoInexistente' },
      { from: 'itens[*].valor', to: 'total' },
      { from: 'observacao', to: 'notes' },
      { from: 'itens[*].valor', to: 'rows[*].a' },
      { from: 'outros[*].valor', to: 'rows[*].b' },
      { from: 'nome', to: 'label', steps: [['divide', { operand: 0 }]] },
    ],
    [],
    { mapperName: 'ErrosMapper', target: 'typescript' },
  ),
  expectedOutput: {
    name: 'Teste',
    age: null,
    address: true,
    total: [10, 20],
    notes: null,
    rows: [{ a: 10, b: 1 }, { a: 20 }],
    campoDestinoInexistente: 'Teste',
  },
  expectedDiagnostics: [
    'type-incompatible',
    'source-missing',
    'target-missing',
    'array-incompatible',
    'required-unfilled',
    'unexpected-null',
    'transform-invalid',
    'duplicate-mapping',
  ],
};

export const EXAMPLES: ExampleDefinition[] = [
  cliente,
  pedido,
  pagamento,
  legado,
  javaDto,
  apiRest,
  arrays,
  erros,
];

export function getExample(id: string): ExampleDefinition | undefined {
  return EXAMPLES.find((e) => e.id === id);
}
