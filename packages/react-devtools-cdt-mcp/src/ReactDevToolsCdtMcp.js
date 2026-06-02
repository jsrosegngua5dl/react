/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import {installFacade, createTools} from 'react-devtools-facade';
// $FlowFixMe[cannot-resolve-module] — ESM package with .mjs export
import {encode} from '@toon-format/toon';

import type {Facade, Tools} from 'react-devtools-facade';

// A tool definition: its chrome-devtools-mcp metadata plus how to invoke the
// underlying react-devtools-facade tool. `call` maps the params object that
// chrome-devtools-mcp passes (parsed + ajv-validated against inputSchema) onto
// the facade tool's positional arguments.
type ToolDefinition = {
  name: string,
  description: string,
  inputSchema: {[string]: mixed},
  call: (tools: Tools, args: {[string]: any}) => mixed,
};

const TOOL_DEFINITIONS: Array<ToolDefinition> = [
  {
    name: 'react_get_tree',
    description:
      'Snapshot of the React component tree as an array of nodes ' +
      '{label, type, name, key, firstChild, nextSibling}. firstChild and ' +
      'nextSibling reference other nodes by label.',
    inputSchema: {
      type: 'object',
      properties: {
        depth: {
          type: 'number',
          description: 'Maximum tree depth to traverse (default 20).',
        },
        rootLabel: {
          type: 'string',
          description:
            'Start the snapshot from this component label (e.g. "@c5").',
        },
      },
    },
    call: (tools, args) => tools.getTreeSnapshot(args.depth, args.rootLabel),
  },
  {
    name: 'react_get_component',
    description:
      'Detailed info for one component by label: type, name, key, props ' +
      '(excluding children) and, for function components, its hooks tree.',
    inputSchema: {
      type: 'object',
      properties: {
        label: {type: 'string', description: 'Component label, e.g. "@c5".'},
      },
      required: ['label'],
    },
    call: (tools, args) => tools.getComponentByLabel(args.label),
  },
  {
    name: 'react_find_components',
    description:
      'Find components by case-insensitive name substring. Paginated; returns ' +
      '{page, pageSize, totalCount, totalPages, results}.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {type: 'string', description: 'Name substring to match.'},
        rootLabel: {
          type: 'string',
          description: "Limit the search to this component's subtree.",
        },
        page: {type: 'number', description: 'Page number (default 1).'},
        pageSize: {
          type: 'number',
          description: 'Results per page (default 10).',
        },
      },
      required: ['name'],
    },
    call: (tools, args) =>
      tools.findComponents(args.name, args.rootLabel, args.page, args.pageSize),
  },
  {
    name: 'react_get_component_source',
    description:
      'Definition source location of a component {source: {name, fileName, ' +
      'line, column}} or {source: null} if unavailable.',
    inputSchema: {
      type: 'object',
      properties: {
        label: {type: 'string', description: 'Component label, e.g. "@c5".'},
      },
      required: ['label'],
    },
    call: (tools, args) => tools.getComponentSource(args.label),
  },
  {
    name: 'react_get_owners_stack',
    description:
      'Raw owner stack trace string for a component — the chain of JSX ' +
      'creation locations up to the root. DEV-only.',
    inputSchema: {
      type: 'object',
      properties: {
        label: {type: 'string', description: 'Component label, e.g. "@c5".'},
      },
      required: ['label'],
    },
    call: (tools, args) => tools.getOwnersStack(args.label),
  },
  {
    name: 'react_get_owners_branch',
    description:
      'Structured owner list for a component, ordered from immediate owner to ' +
      'root ancestor. Each entry is {label, name, type}. DEV-only.',
    inputSchema: {
      type: 'object',
      properties: {
        label: {type: 'string', description: 'Component label, e.g. "@c5".'},
      },
      required: ['label'],
    },
    call: (tools, args) => tools.getOwnersBranch(args.label),
  },
  {
    name: 'react_start_profiling',
    description:
      'Start a profiling session that records per-commit render timing. ' +
      'Returns {status: "started", trace}.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Trace name (auto-generated if omitted).',
        },
      },
    },
    call: (tools, args) => tools.startProfiling(args.name),
  },
  {
    name: 'react_stop_profiling',
    description:
      'Stop the active profiling session. Returns {status: "stopped", trace, ' +
      'commits}.',
    inputSchema: {type: 'object', properties: {}},
    call: tools => tools.stopProfiling(),
  },
  {
    name: 'react_get_trace_overview',
    description:
      'Overview of a profiling trace — one row per commit with a timing ' +
      'breakdown and the number of components that changed.',
    inputSchema: {
      type: 'object',
      properties: {
        traceName: {type: 'string', description: 'The trace to query.'},
      },
      required: ['traceName'],
    },
    call: (tools, args) => tools.getTraceOverview(args.traceName),
  },
  {
    name: 'react_get_commit_report',
    description:
      'Detailed report for a single commit — timing metadata and per-component ' +
      'render durations sorted descending.',
    inputSchema: {
      type: 'object',
      properties: {
        traceName: {type: 'string', description: 'The trace to query.'},
        commitIndex: {
          type: 'number',
          description: 'Zero-based commit index within the trace.',
        },
      },
      required: ['traceName', 'commitIndex'],
    },
    call: (tools, args) =>
      tools.getCommitReport(args.traceName, args.commitIndex),
  },
];

// A chrome-devtools-mcp third-party tool. `execute` runs in the page and
// returns a value chrome-devtools-mcp forwards to the MCP client; we return a
// compact TOON string for token efficiency.
export type CdtMcpTool = {
  name: string,
  description: string,
  inputSchema: {[string]: mixed},
  execute: (args: {[string]: any}) => string,
};

export type CdtMcpToolGroup = {
  name: string,
  description: string,
  tools: Array<CdtMcpTool>,
};

/**
 * Build the chrome-devtools-mcp tool group from an assembled set of facade
 * tools. Each tool serializes its (plain-object) result to TOON.
 */
export function buildToolGroup(tools: Tools): CdtMcpToolGroup {
  return {
    name: 'react',
    description:
      'React DevTools tools for inspecting and profiling the running React app.',
    tools: TOOL_DEFINITIONS.map(definition => ({
      name: definition.name,
      description: definition.description,
      inputSchema: definition.inputSchema,
      execute: (args: {[string]: any}) =>
        encode(definition.call(tools, args || {})),
    })),
  };
}

/**
 * Install the facade and register the React tools with chrome-devtools-mcp.
 *
 * The facade is installed EAGERLY (synchronously, when this runs) so the
 * DevTools hook is in place before React initializes. The tools, however, are
 * built LAZILY inside the `devtoolstooldiscovery` handler — no tool work
 * happens until chrome-devtools-mcp actually discovers them. The tool group is
 * memoized so component labels stay stable across repeated discovery.
 *
 * chrome-devtools-mcp dispatches a `devtoolstooldiscovery` event and expects a
 * synchronous `respondWith(toolGroup)`.
 *
 * Must run once per page, before React initializes (installFacade throws if a
 * DevTools hook is already installed). Returns the Facade and an `unregister`
 * function that removes the discovery listener.
 */
export function register(target?: any = globalThis): {
  facade: Facade,
  unregister: () => void,
} {
  const facade = installFacade(target);

  let toolGroup: CdtMcpToolGroup | null = null;
  const listener = (event: any) => {
    if (toolGroup === null) {
      toolGroup = buildToolGroup(createTools(facade));
    }
    event.respondWith(toolGroup);
  };
  target.addEventListener('devtoolstooldiscovery', listener);

  return {
    facade,
    unregister: () => {
      target.removeEventListener('devtoolstooldiscovery', listener);
    },
  };
}
