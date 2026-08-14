/**
 * gateway-front-door.ts: the only MCP-exposed workflow. One trigger, nine tools.
 *
 * This file IS the workflow; `node n8n/workflows/build.js front-door --create` deploys it. The
 * one value it cannot hold is the decision workflow's id, which does not exist until n8n has
 * created that workflow. So DECIDE_WORKFLOW_ID appears once per tool below, as its name between
 * doubled at-signs, and the build resolves it by name; newest live copy wins. Nothing else here
 * is substituted.
 *
 * TWO WORKFLOWS, NOT ELEVEN. An earlier version gave each tool its own thin wrapper workflow so
 * each could advertise a typed, per-field schema. That reason does not hold: under an MCP Server
 * Trigger, n8n hands a tool call's whole argument object to a single field rather than
 * distributing it across named ones. Confirmed from execution data, where five arguments arrived
 * nested inside the first. The arguments travel together anyway, so the wrappers had nothing to
 * do but stamp a tool name, which a `toolWorkflow` node does with a literal. So: one front door,
 * one decision workflow, nine tools on the trigger.
 *
 * WHY EACH TOOL PASSES ITS OWN NAME AS A LITERAL. `tool` is stamped by the gateway and absent
 * from every advertised schema, for the same reason the actor is a constant inside the decision
 * workflow: a request that names its own tool is choosing which rules apply to it. The caller
 * supplies `args` and nothing else.
 *
 * WHAT A DESCRIPTION IS FOR. The agent reads it when deciding whether to call the tool, so it
 * says what the tool does and stays quiet about what the policy will decide. The argument list
 * appears twice per tool, once for the agent choosing a tool and once for the model filling in
 * `args`, both written out in full rather than assembled, so what the agent sees is legible
 * here.
 *
 * Node versions come from `get_node_types` rather than from the SDK reference's examples,
 * which pin older ones.
 */

import { workflow, trigger, tool, fromAi } from '@n8n/workflow-sdk';

const whoamiTool = tool({
  type: '@n8n/n8n-nodes-langchain.toolWorkflow',
  version: 2.2,
  config: {
    name: 'whoami',
    parameters: {
      description: 'Return the identity this session is acting as, its role, and what that role is entitled to reach. Call this first to find out what is possible. Arguments — query (string): What the user asked, in their own words.',
      source: 'database',
      workflowId: { __rl: true, mode: 'id', value: '@@DECIDE_WORKFLOW_ID@@' },
      workflowInputs: {
        mappingMode: 'defineBelow',
        value: {
          tool: 'whoami',
          args: fromAi('args', 'A JSON object with the arguments for this call: query (string): What the user asked, in their own words.', 'string'),
        },
        schema: [
          { id: 'args', displayName: 'args', required: true, display: true, type: 'string', canBeUsedToMatch: true },
        ],
      },
    },
    output: [{ status: 'DENY', matched_rule: 'R1', answer: '...' }],
  },
});

const listdatasetsTool = tool({
  type: '@n8n/n8n-nodes-langchain.toolWorkflow',
  version: 2.2,
  config: {
    name: 'list_datasets',
    parameters: {
      description: "List the datasets available, with each one's classification and residency. Metadata only: this never returns records. Arguments — query (string): What the user asked, in their own words.",
      source: 'database',
      workflowId: { __rl: true, mode: 'id', value: '@@DECIDE_WORKFLOW_ID@@' },
      workflowInputs: {
        mappingMode: 'defineBelow',
        value: {
          tool: 'list_datasets',
          args: fromAi('args', 'A JSON object with the arguments for this call: query (string): What the user asked, in their own words.', 'string'),
        },
        schema: [
          { id: 'args', displayName: 'args', required: true, display: true, type: 'string', canBeUsedToMatch: true },
        ],
      },
    },
    output: [{ status: 'DENY', matched_rule: 'R1', answer: '...' }],
  },
});

const describedatasetTool = tool({
  type: '@n8n/n8n-nodes-langchain.toolWorkflow',
  version: 2.2,
  config: {
    name: 'describe_dataset',
    parameters: {
      description: 'Describe one dataset: its schema, volume and accountable owner. Arguments — query (string): What the user asked, in their own words.; resource (string): Dataset id, e.g. fleet.clip_catalog.',
      source: 'database',
      workflowId: { __rl: true, mode: 'id', value: '@@DECIDE_WORKFLOW_ID@@' },
      workflowInputs: {
        mappingMode: 'defineBelow',
        value: {
          tool: 'describe_dataset',
          args: fromAi('args', 'A JSON object with the arguments for this call: query (string): What the user asked, in their own words.; resource (string): Dataset id, e.g. fleet.clip_catalog.', 'string'),
        },
        schema: [
          { id: 'args', displayName: 'args', required: true, display: true, type: 'string', canBeUsedToMatch: true },
        ],
      },
    },
    output: [{ status: 'DENY', matched_rule: 'R1', answer: '...' }],
  },
});

// The cohort size and the smallest resulting group are asked for explicitly, and the tool says
// they must be measured before the query runs. Both are policy inputs: R2's k-anonymity floor
// and R10's cell floor. docs/GATEWAY_CONTRACT.md section 4 is candid that taking them from the
// caller is the weak version of this; the contract wants them measured inside the enclave,
// pre-decision, and the reply carries a profile_check block until they are.
const queryaggregateTool = tool({
  type: '@n8n/n8n-nodes-langchain.toolWorkflow',
  version: 2.2,
  config: {
    name: 'query_aggregate',
    parameters: {
      description: 'Run a counting or distribution query over a dataset and return the aggregate. Supply the cohort size and, if grouping, the size of the smallest resulting group, both measured before the query runs. Arguments — query (string): What the user asked, in their own words.; resource (string): Dataset id to aggregate over.; columns (array): Columns to group by. Empty for an ungrouped total.; record_count (number): How many records the filter selects.; min_cell_count (number): Records in the smallest resulting group.',
      source: 'database',
      workflowId: { __rl: true, mode: 'id', value: '@@DECIDE_WORKFLOW_ID@@' },
      workflowInputs: {
        mappingMode: 'defineBelow',
        value: {
          tool: 'query_aggregate',
          args: fromAi('args', 'A JSON object with the arguments for this call: query (string): What the user asked, in their own words.; resource (string): Dataset id to aggregate over.; columns (array): Columns to group by. Empty for an ungrouped total.; record_count (number): How many records the filter selects.; min_cell_count (number): Records in the smallest resulting group.', 'string'),
        },
        schema: [
          { id: 'args', displayName: 'args', required: true, display: true, type: 'string', canBeUsedToMatch: true },
        ],
      },
    },
    output: [{ status: 'DENY', matched_rule: 'R1', answer: '...' }],
  },
});

// `columns` is advertised so a read can be projected. The resolver always passed it through,
// and every policy predicate that reads it is scoped to aggregate requests, so naming it here
// changes no verdict. It only lets a caller ask for three columns instead of every column,
// which eval/queries/allow_clip_catalog_metadata_read.yaml describes.
const readrecordsTool = tool({
  type: '@n8n/n8n-nodes-langchain.toolWorkflow',
  version: 2.2,
  config: {
    name: 'read_records',
    parameters: {
      description: "Read rows from a dataset. Set projection to 'index' for index or metadata rows only, or 'records' for full records. Arguments — query (string): What the user asked, in their own words.; resource (string): Dataset id to read from.; record_count (number): How many rows the read would return.; projection (string): 'records' or 'index'.; columns (array): Columns to return. Empty for whole rows.",
      source: 'database',
      workflowId: { __rl: true, mode: 'id', value: '@@DECIDE_WORKFLOW_ID@@' },
      workflowInputs: {
        mappingMode: 'defineBelow',
        value: {
          tool: 'read_records',
          args: fromAi('args', "A JSON object with the arguments for this call: query (string): What the user asked, in their own words.; resource (string): Dataset id to read from.; record_count (number): How many rows the read would return.; projection (string): 'records' or 'index'.; columns (array): Columns to return. Empty for whole rows.", 'string'),
        },
        schema: [
          { id: 'args', displayName: 'args', required: true, display: true, type: 'string', canBeUsedToMatch: true },
        ],
      },
    },
    output: [{ status: 'DENY', matched_rule: 'R1', answer: '...' }],
  },
});

const requestexportTool = tool({
  type: '@n8n/n8n-nodes-langchain.toolWorkflow',
  version: 2.2,
  config: {
    name: 'request_export',
    parameters: {
      description: "Request that data be moved to a destination outside the dataset's current location, such as a workstation or an external host. Arguments — query (string): What the user asked, in their own words.; resource (string): Dataset id to export.; destination (string): Where it should go, e.g. host:workstation.; record_count (number): How many records the export would carry.; projection (string): 'records' or 'index'.",
      source: 'database',
      workflowId: { __rl: true, mode: 'id', value: '@@DECIDE_WORKFLOW_ID@@' },
      workflowInputs: {
        mappingMode: 'defineBelow',
        value: {
          tool: 'request_export',
          args: fromAi('args', "A JSON object with the arguments for this call: query (string): What the user asked, in their own words.; resource (string): Dataset id to export.; destination (string): Where it should go, e.g. host:workstation.; record_count (number): How many records the export would carry.; projection (string): 'records' or 'index'.", 'string'),
        },
        schema: [
          { id: 'args', displayName: 'args', required: true, display: true, type: 'string', canBeUsedToMatch: true },
        ],
      },
    },
    output: [{ status: 'DENY', matched_rule: 'R1', answer: '...' }],
  },
});

const starttrainingjobTool = tool({
  type: '@n8n/n8n-nodes-langchain.toolWorkflow',
  version: 2.2,
  config: {
    name: 'start_training_job',
    parameters: {
      description: 'Start a training job against a dataset at a named execution location. Returns evaluation metrics, logs and a model card rather than data. Arguments — query (string): What the user asked, in their own words.; resource (string): Dataset id to train on.; destination (string): Where the job runs, e.g. enclave:governed.',
      source: 'database',
      workflowId: { __rl: true, mode: 'id', value: '@@DECIDE_WORKFLOW_ID@@' },
      workflowInputs: {
        mappingMode: 'defineBelow',
        value: {
          tool: 'start_training_job',
          args: fromAi('args', 'A JSON object with the arguments for this call: query (string): What the user asked, in their own words.; resource (string): Dataset id to train on.; destination (string): Where the job runs, e.g. enclave:governed.', 'string'),
        },
        schema: [
          { id: 'args', displayName: 'args', required: true, display: true, type: 'string', canBeUsedToMatch: true },
        ],
      },
    },
    output: [{ status: 'DENY', matched_rule: 'R1', answer: '...' }],
  },
});

const publishmodelTool = tool({
  type: '@n8n/n8n-nodes-langchain.toolWorkflow',
  version: 2.2,
  config: {
    name: 'publish_model',
    parameters: {
      description: 'Publish a trained model artifact to a registry or deployment target. Arguments — query (string): What the user asked, in their own words.; resource (string): Model artifact id, e.g. models.pedestrian_v4.; destination (string): Where to publish, e.g. registry:global.',
      source: 'database',
      workflowId: { __rl: true, mode: 'id', value: '@@DECIDE_WORKFLOW_ID@@' },
      workflowInputs: {
        mappingMode: 'defineBelow',
        value: {
          tool: 'publish_model',
          args: fromAi('args', 'A JSON object with the arguments for this call: query (string): What the user asked, in their own words.; resource (string): Model artifact id, e.g. models.pedestrian_v4.; destination (string): Where to publish, e.g. registry:global.', 'string'),
        },
        schema: [
          { id: 'args', displayName: 'args', required: true, display: true, type: 'string', canBeUsedToMatch: true },
        ],
      },
    },
    output: [{ status: 'DENY', matched_rule: 'R1', answer: '...' }],
  },
});

// Registers a request for sign-off and returns immediately, granting nothing.
// docs/GATEWAY_CONTRACT.md section 8 explains why this build has no resume path: an approval
// that can be replayed against a different request is a token, not a decision.
const requestapprovalTool = tool({
  type: '@n8n/n8n-nodes-langchain.toolWorkflow',
  version: 2.2,
  config: {
    name: 'request_approval',
    parameters: {
      description: "Record a request for a dataset owner's sign-off. This registers the request and returns immediately; it does not grant access and does not wait. Arguments — query (string): What the user asked, in their own words.; resource (string): Dataset id the request concerns.; destination (string): Where the data would go if approved.",
      source: 'database',
      workflowId: { __rl: true, mode: 'id', value: '@@DECIDE_WORKFLOW_ID@@' },
      workflowInputs: {
        mappingMode: 'defineBelow',
        value: {
          tool: 'request_approval',
          args: fromAi('args', 'A JSON object with the arguments for this call: query (string): What the user asked, in their own words.; resource (string): Dataset id the request concerns.; destination (string): Where the data would go if approved.', 'string'),
        },
        schema: [
          { id: 'args', displayName: 'args', required: true, display: true, type: 'string', canBeUsedToMatch: true },
        ],
      },
    },
    output: [{ status: 'DENY', matched_rule: 'R1', answer: '...' }],
  },
});

// The path is part of the URL the agent's MCP client is configured with, so renaming it means
// reinstalling the skill in the sandbox. isolate.sh then makes this the one workflow the n8n
// management surface will serve, and verifies it.
const frontDoor = trigger({
  type: '@n8n/n8n-nodes-langchain.mcpTrigger',
  version: 2,
  config: {
    name: 'Access Gateway (MCP)',
    parameters: { path: 'kerbline-access-gateway' },
    subnodes: { tools: [whoamiTool, listdatasetsTool, describedatasetTool, queryaggregateTool, readrecordsTool, requestexportTool, starttrainingjobTool, publishmodelTool, requestapprovalTool] },
    output: [{}],
  },
});

export default workflow('gateway-front-door', 'Kerbline Access Gateway — Front Door')
  .add(frontDoor);
