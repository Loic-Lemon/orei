import { expect, test } from 'vitest';
import { render } from 'pele';
import { previewSourceLine } from '../src/preview-source';

function diagram(source: string) {
  return new DOMParser().parseFromString(render(source).svg, 'image/svg+xml');
}

test('flowchart nodes jump to their definitions and parallel edges keep their own lines', () => {
  const source = [
    '---',
    'title: Demo',
    '---',
    'flowchart LR; A --> B',
    '  %% B[Ignored]',
    '  B["Two',
    '  lines"]',
    '  A -->|Next| B',
    '  A -->|Next| B',
    '  subgraph group[Group]',
    '    C[Inside]',
    '  end',
  ].join('\r\n');
  const svg = diagram(source);
  expect(previewSourceLine(source, svg.querySelector('[data-id="B"] text')!)).toBe(6);
  const labels = [...svg.querySelectorAll('.pele-edge-label text')];
  expect(labels.map(label => previewSourceLine(source, label))).toEqual([8, 9]);
  expect(previewSourceLine(source, svg.querySelector('.pele-edge path')!)).toBe(4);
  expect(previewSourceLine(source, svg.querySelector('[data-id="group"] rect')!)).toBe(10);
});

test.each([
  {
    source: 'sequenceDiagram\n  participant A as Client\n  loop Retry\n  Note over A: Waiting\n  A->>B: Hello\n  end',
    targets: {'.pele-actor[data-id="A"]': 2, '.pele-note': 4, '.pele-message path': 5},
  },
  {
    source: 'stateDiagram-v2\n  [*] --> Work\n  state Work {\n    [*] --> Active\n    note right of Active\n      In progress\n    end note\n    Active --> [*]\n  }\n  Work --> [*]',
    targets: {'.pele-state-composite': 3, '[data-id="Work_start"]': 4, '.pele-note': 5, '[data-id="edge3"] path': 8},
  },
  {
    source: 'erDiagram\n  PROJECT ||--o{ TASK : contains\n  TASK {\n    int id PK\n  }',
    targets: {'[data-id="TASK"]': 3, '.pele-edge-label': 2},
  },
  {
    source: 'classDiagram\n  namespace Animals {\n    class Duck\n  }\n  Animal <|-- Duck',
    targets: {'.pele-namespace': 2, '[data-id="Duck"]': 3, '.pele-edge path': 5},
  },
  {
    source: 'agentflow-beta LR\n  A --> B\n  B custom@--> C',
    targets: {'[data-id="B"]': 2, '[data-id="custom"] path': 3},
  },
])('maps rendered elements in $source', ({source, targets}) => {
  const svg = diagram(source);
  for (const [selector, line] of Object.entries(targets)) {
    expect(previewSourceLine(source, svg.querySelector(selector)!)).toBe(line);
  }
});
