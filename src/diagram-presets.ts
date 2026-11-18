export const diagramSchemes = {
  monochrome: {
    name: 'Monochrome',
    colors: {
      '--pele-bg': '#fafafa',
      '--pele-fg': '#252525',
      '--pele-muted': '#6d6d6d',
      '--pele-line': '#686868',
      '--pele-surface': '#ededed',
      '--pele-surface-alt': '#e1e1e1',
      '--pele-border': '#858585',
      '--pele-accent': '#3e3e3e',
      '--pele-critical': '#242424',
      '--pele-series-1': '#353535',
      '--pele-series-2': '#6f6f6f',
      '--pele-series-3': '#505050',
      '--pele-series-4': '#777777',
      '--pele-series-5': '#454545',
      '--pele-series-6': '#646464',
      '--pele-series-7': '#585858',
      '--pele-series-8': '#2b2b2b',
    },
  },
  ocean: {
    name: 'Ocean',
    colors: {
      '--pele-bg': '#f6fbff',
      '--pele-fg': '#173547',
      '--pele-muted': '#526d7c',
      '--pele-line': '#497588',
      '--pele-surface': '#dff0f8',
      '--pele-surface-alt': '#cbe5f3',
      '--pele-border': '#54839a',
      '--pele-accent': '#1e6493',
      '--pele-critical': '#9a414e',
      '--pele-series-1': '#22698b',
      '--pele-series-2': '#2f776f',
      '--pele-series-3': '#626694',
      '--pele-series-4': '#526f45',
      '--pele-series-5': '#317399',
      '--pele-series-6': '#8c526e',
      '--pele-series-7': '#3b807e',
      '--pele-series-8': '#4f6292',
    },
  },
  forest: {
    name: 'Forest',
    colors: {
      '--pele-bg': '#f6faf4',
      '--pele-fg': '#233c31',
      '--pele-muted': '#526a5c',
      '--pele-line': '#547362',
      '--pele-surface': '#e2eedf',
      '--pele-surface-alt': '#cfe3d2',
      '--pele-border': '#5d846d',
      '--pele-accent': '#2a684e',
      '--pele-critical': '#994b36',
      '--pele-series-1': '#37654d',
      '--pele-series-2': '#687141',
      '--pele-series-3': '#4b6c71',
      '--pele-series-4': '#805747',
      '--pele-series-5': '#4c795e',
      '--pele-series-6': '#776b49',
      '--pele-series-7': '#496991',
      '--pele-series-8': '#725972',
    },
  },
  graphite: {
    name: 'Graphite',
    colors: {
      '--pele-bg': '#1a1c20',
      '--pele-fg': '#ebebed',
      '--pele-muted': '#b3b5ba',
      '--pele-line': '#a7aab0',
      '--pele-surface': '#292c32',
      '--pele-surface-alt': '#353942',
      '--pele-border': '#7e8490',
      '--pele-accent': '#c0c9d8',
      '--pele-critical': '#e6a7a7',
      '--pele-series-1': '#c3cad8',
      '--pele-series-2': '#9aa3b5',
      '--pele-series-3': '#d3d5d9',
      '--pele-series-4': '#9297a3',
      '--pele-series-5': '#bfc0c7',
      '--pele-series-6': '#a8b3c6',
      '--pele-series-7': '#b0a9bf',
      '--pele-series-8': '#dce0e8',
    },
  },
};

export const diagramTemplates = [
  {
    name: 'Process flow',
    source: `flowchart LR
  Start([Start]) --> Plan[Plan the work]
  Plan --> Do[Do the work]
  Do --> Review[Review the result]
  Review --> Done([Done])`,
  },
  {
    name: 'Decision tree',
    source: `flowchart TD
  Request[Receive a request] --> Ready{Ready to proceed?}
  Ready -->|Yes| Approve[Approve request]
  Ready -->|No| Revise[Ask for changes]
  Revise --> Request`,
  },
  {
    name: 'Sequence diagram',
    source: `sequenceDiagram
  participant User
  participant App
  participant Service
  User->>App: Submit a request
  App->>Service: Process request
  Service-->>App: Return result
  App-->>User: Show confirmation`,
  },
  {
    name: 'State machine',
    source: `stateDiagram-v2
  [*] --> Draft
  Draft --> Review: Submit
  Review --> Draft: Request changes
  Review --> Published: Approve
  Published --> [*]`,
  },
  {
    name: 'Entity relationship',
    source: `erDiagram
  PROJECT ||--o{ TASK : contains
  TASK }o--|| MEMBER : assigned_to
  PROJECT {
    int id PK
    string name
  }
  TASK {
    int id PK
    string title
  }
  MEMBER {
    int id PK
    string name
  }`,
  },
];
