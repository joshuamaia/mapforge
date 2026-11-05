/**
 * Equivalências entre termos. Cada grupo reúne palavras intercambiáveis. Um termo marcado em
 * `weak` indica relação plausível, mas não garantida (como `codigo` e `id`): usar essa ligação
 * limita a sugestão à confiança baixa.
 */
export interface SynonymGroup {
  terms: string[];
  /** Pares de termos fracos dentro do grupo. Sem isso, o grupo é considerado forte. */
  weak?: boolean;
}

export const DEFAULT_SYNONYMS: SynonymGroup[] = [
  { terms: ['nome', 'name'] },
  { terms: ['completo', 'full', 'complete'] },
  { terms: ['sobrenome', 'surname', 'lastname', 'last'] },
  { terms: ['primeiro', 'first'] },
  { terms: ['ultimo', 'last'] },
  { terms: ['data', 'date', 'dt'] },
  { terms: ['nascimento', 'birth', 'birthday'] },
  { terms: ['valor', 'amount', 'value', 'vl', 'vlr'] },
  { terms: ['total', 'sum', 'totais'] },
  { terms: ['ativo', 'active', 'enabled', 'habilitado'] },
  { terms: ['inativo', 'inactive', 'disabled', 'desabilitado'] },
  { terms: ['cliente', 'customer', 'client'] },
  { terms: ['usuario', 'user'] },
  { terms: ['pedido', 'pedidos', 'order', 'orders'] },
  { terms: ['item', 'itens', 'items'] },
  { terms: ['produto', 'produtos', 'product', 'products'] },
  { terms: ['codigo', 'code', 'cod'] },
  { terms: ['codigo', 'id', 'identificador', 'identifier'], weak: true },
  { terms: ['id', 'identificador', 'identifier'] },
  { terms: ['endereco', 'address'] },
  { terms: ['rua', 'logradouro', 'street'] },
  { terms: ['numero', 'number', 'num', 'nro'] },
  { terms: ['bairro', 'district', 'neighborhood'] },
  { terms: ['cidade', 'city'] },
  { terms: ['estado', 'uf', 'state'] },
  { terms: ['pais', 'country'] },
  { terms: ['cep', 'zip', 'zipcode', 'postal'] },
  { terms: ['telefone', 'fone', 'phone', 'tel'] },
  { terms: ['celular', 'mobile', 'cell'] },
  { terms: ['email', 'mail', 'correio'] },
  { terms: ['documento', 'document', 'doc'] },
  { terms: ['quantidade', 'qtd', 'qtde', 'quantity', 'qty'] },
  { terms: ['preco', 'price'] },
  { terms: ['desconto', 'discount'] },
  { terms: ['imposto', 'tax'] },
  { terms: ['moeda', 'currency'] },
  { terms: ['pagamento', 'payment'] },
  { terms: ['situacao', 'status'] },
  { terms: ['tipo', 'type', 'kind'] },
  { terms: ['descricao', 'description', 'desc'] },
  { terms: ['titulo', 'title'] },
  { terms: ['criacao', 'criado', 'created', 'creation'] },
  { terms: ['atualizacao', 'atualizado', 'updated', 'update'] },
  { terms: ['vencimento', 'due', 'expiration'] },
  { terms: ['empresa', 'company'] },
  { terms: ['observacao', 'note', 'notes', 'obs'] },
  { terms: ['categoria', 'category'] },
  { terms: ['em', 'at', 'on'] },
  { terms: ['de', 'of', 'do', 'da'] },
];
