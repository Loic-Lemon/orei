import { parse, PeleError, type ErModel, type ParsedDiagramModel, type StateModel } from 'pele';

type Located<T> = { value: T; line: number };

function parseStatement(source: string): ParsedDiagramModel | undefined {
  try { return parse(source); }
  catch (error) {
    if (!(error instanceof PeleError)) throw error;
    return undefined;
  }
}

// Parse source statements with Pele itself so identifiers in labels, comments, and
// unrelated directives don't get mistaken for the element that was clicked.
function* statements(source: string, type: ParsedDiagramModel['type']) {
  const blank = (text: string) => text.replace(/[^\n]/g, '');
  const lines = source.replace(/\r\n?/g, '\n').replace(/^\uFEFF/, '')
    .replace(/^[ \t\n]*---[ \t]*\n[\s\S]*?\n---[ \t]*(?=\n|$)/, blank)
    .replace(/^[ \t]*%%\{[\s\S]*?\}%%/gm, blank).split('\n');
  const headerIndex = lines.findIndex(line => line.trim() && !line.trimStart().startsWith('%%'));
  if (headerIndex < 0) return;
  const header = lines[headerIndex].split(';', 1)[0];
  const prefix = header + '\n';
  lines[headerIndex] = lines[headerIndex].slice(header.length + 1);
  const statePath: string[] = [];

  for (let index = headerIndex; index < lines.length; index++) {
    const line = index + 1;
    const start = lines[index].trim();
    if (!start || start.startsWith('%%')) continue;
    if (type === 'state' && start === '}') {
      statePath.pop();
      continue;
    }
    const stateGroup = type === 'state' && /^state\b.*\{$/i.test(start);
    const namespace = type === 'class' && /^namespace\b.*\{$/i.test(start);
    const closer = /^(?:subgraph|box|loop|alt|opt|par|critical|break|rect)\b/i.test(start)
      ? '\nend' : stateGroup ? '\n}' : namespace ? '\nnote " "\n}' : '';
    let model = parseStatement(prefix + start);
    if (!model && closer) model = parseStatement(prefix + start + closer);
    if (!model && /[\[({"]|^note\b/i.test(start)) {
      // shortcut: join up to 64 physical lines for a multiline statement. Replace
      // fragment parsing with renderer source locations when Pele exposes them.
      for (let end = index + 1; end < Math.min(lines.length, index + 64); end++) {
        const fragment = prefix + lines.slice(index, end + 1).join('\n');
        model = parseStatement(fragment) ?? (closer ? parseStatement(fragment + closer) : undefined);
        if (!model) continue;
        index = end;
        break;
      }
    }
    if (model?.type === type) {
      yield { model, line, stateScope: statePath.at(-1) ?? 'root' };
      if (stateGroup && model.type === 'state') {
        const group = model.rootDoc[0];
        if (group && typeof group !== 'string' && group.stmt === 'state') statePath.push(group.id);
      }
    }
  }
}

function occurrenceLine<T>(
  items: T[], index: number, locations: Located<T>[], key: (item: T) => string,
): number | undefined {
  if (index < 0 || index >= items.length) return;
  const clicked = key(items[index]);
  const matches = locations.filter(location => key(location.value) === clicked);
  // The count check prevents jumping to the wrong copy of a repeated statement
  // when an occurrence couldn't be parsed in isolation.
  if (matches.length !== items.filter(item => key(item) === clicked).length) return;
  return matches[items.slice(0, index).filter(item => key(item) === clicked).length]?.line;
}

type StateStatement = StateModel['rootDoc'][number];
type StateElement = Extract<StateStatement, {stmt: 'relation' | 'state'}>;
function* stateElements(statements: StateStatement[]): Generator<StateElement> {
  for (const statement of statements) {
    if (typeof statement === 'string') continue;
    if (statement.stmt === 'relation' || (statement.stmt === 'state' && statement.note)) yield statement;
    if (statement.stmt === 'state' && statement.doc) yield* stateElements(statement.doc);
  }
}

export function previewSourceLine(source: string, target: Element): number | undefined {
  // Use the outermost renderer ID so IDs inside imported icons can't shadow it.
  let element: Element | undefined;
  for (let ancestor: Element | null = target; ancestor; ancestor = ancestor.parentElement) {
    if (ancestor.matches('[data-id]')) element = ancestor;
  }
  const id = element?.getAttribute('data-id');
  if (!element || !id) return;
  const edge = element.matches('.pele-edge, .pele-edge-label');
  const cluster = element.matches('.pele-cluster, .pele-cluster-title');
  const model = parseStatement(source);
  if (!model) return;
  if (model.type === 'agentflow') {
    const mappings = model.mappings;
    if (edge) {
      const index = model.edges.findIndex(item => item.id === id);
      const locations = mappings.filter(item => item.type === 'edge')
        .map(item => ({value: item.id, line: item.position.startLine}));
      return occurrenceLine(model.edges.map(item => item.end), index, locations, item => item);
    }
    return mappings.find(item => item.id === id && item.type !== 'edge')?.position.startLine;
  }
  const fragments = statements(source, model.type);
  let first: number | undefined;
  let definition: number | undefined;

  switch (model.type) {
    case 'flowchart': {
      const edges: Located<typeof model.edges[number]>[] = [];
      const groups: Located<typeof model.subgraphs[number]>[] = [];
      for (const { model: part, line } of fragments) {
        if (part.type !== 'flowchart') continue;
        if (edge) edges.push(...part.edges.map(value => ({value, line})));
        else if (cluster) groups.push(...part.subgraphs.map(value => ({value, line})));
        else {
          const node = part.nodes.get(id);
          if (!node) continue;
          first ??= line;
          if (node.type || node.img || node.icon || (node.text !== undefined && node.text !== id)) definition = line;
        }
      }
      if (edge) return occurrenceLine(model.edges, model.edges.findIndex(item => item.id === id), edges,
        item => JSON.stringify([item.start, item.end, item.type, item.stroke, item.text, item.isUserDefinedId ? item.id : null]));
      if (cluster) return occurrenceLine(model.subgraphs, model.subgraphs.findIndex(item => item.id === id), groups,
        group => JSON.stringify([group.id.replace(/^subGraph\d+$/, ''), group.title]));
      break;
    }
    case 'sequence': {
      const messages: Located<typeof model.messages[number]>[] = [];
      const message = edge || element.matches('.pele-note');
      for (const { model: part, line } of fragments) {
        if (part.type !== 'sequence') continue;
        if (message) messages.push(...part.messages.map(value => ({value, line})));
        else if (cluster && part.boxes.some(box => box.name === id)) first ??= line;
        else if (part.actors.has(id)) {
          first ??= line;
          if (!part.messages.length) definition ??= line;
        }
      }
      if (message) return occurrenceLine(model.messages, model.messages.findIndex(item => 'i' + item.id === id), messages,
        item => JSON.stringify([item.from, item.to, item.type, item.message, item.placement]));
      break;
    }
    case 'state': {
      const key = (item: StateElement, scope?: string) => {
        if (item.stmt === 'state') return JSON.stringify([item.id, item.note]);
        const from = scope && item.state1.start === true ? scope + '_start' : item.state1.id;
        const to = scope && item.state2.start === false ? scope + '_end' : item.state2.id;
        return JSON.stringify([from, to, item.description ?? '']);
      };
      const link = edge || element.matches('.pele-note');
      const locations: Located<string>[] = [];
      for (const { model: part, line, stateScope } of fragments) {
        if (part.type !== 'state') continue;
        for (const item of stateElements(part.rootDoc)) {
          if (link) locations.push({value: key(item, stateScope), line});
          else if (item.stmt === 'state') {
            if (item.id === id) first ??= line;
          } else if (
            (item.state1.start === true ? stateScope + '_start' : item.state1.id) === id ||
            (item.state2.start === false ? stateScope + '_end' : item.state2.id) === id
          ) first ??= line;
        }
        if (part.rootDoc.some(item => item === id ||
          (typeof item !== 'string' && item.stmt === 'state' && !item.note && item.id === id))) definition ??= line;
      }
      if (link) {
        const items = [...stateElements(model.rootDoc)];
        const index = items.findIndex((item, index) => {
          if (item.stmt === 'relation') return id === 'edge' + index;
          const noteId = item.id + '----note-' + index;
          return id === noteId || id === item.id + '-' + noteId || id === noteId + '-' + item.id;
        });
        return occurrenceLine(items.map(item => key(item)), index, locations, item => item);
      }
      break;
    }
    case 'er': {
      function relationships(part: ErModel) {
        const names = new Map([...part.entities].map(([name, entity]) => [entity.id, name]));
        return part.relationships.map((item, index) => ({
          id: 'id_' + item.entityA + '_' + item.entityB + '_' + index,
          key: JSON.stringify([names.get(item.entityA), names.get(item.entityB), item.roleA, item.relSpec]),
        }));
      }
      const edges: Located<ReturnType<typeof relationships>[number]>[] = [];
      for (const { model: part, line } of fragments) {
        if (part.type !== 'er') continue;
        if (edge) edges.push(...relationships(part).map(value => ({value, line})));
        else if (cluster && part.subgraphs.some(group => group.id === id)) first ??= line;
        else if (part.entities.has(id)) {
          first ??= line;
          if (!part.relationships.length) definition ??= line;
        }
      }
      if (edge) {
        const items = relationships(model);
        return occurrenceLine(items, items.findIndex(item => item.id === id), edges, item => item.key);
      }
      break;
    }
    case 'class': {
      const relations: Located<typeof model.relations[number]>[] = [];
      for (const { model: part, line } of fragments) {
        if (part.type !== 'class') continue;
        if (edge) relations.push(...part.relations.map(value => ({value, line})));
        else if (cluster && part.namespaces.has(id)) first ??= line;
        else if (part.classes.has(id)) {
          first ??= line;
          if (!part.relations.length) definition ??= line;
        }
      }
      if (edge) return occurrenceLine(model.relations,
        model.relations.findIndex((item, index) => 'id_' + item.id1 + '_' + item.id2 + '_' + (index + 1) === id),
        relations, JSON.stringify);
      break;
    }
  }
  return definition ?? first;
}
