import {gql, useQuery} from '@apollo/client';
import {Colors, NonIdealState} from '@blueprintjs/core';
import {pathVerticalDiagonal} from '@vx/shape';
import * as dagre from 'dagre';
import qs from 'query-string';
import React from 'react';
import {Link, RouteComponentProps} from 'react-router-dom';
import styled, {CSSProperties} from 'styled-components/macro';

import {QueryCountdown} from '../app/QueryCountdown';
import {AssetDetails} from '../assets/AssetDetails';
import {AssetMaterializations} from '../assets/AssetMaterializations';
import {SVGViewport} from '../graph/SVGViewport';
import {useDocumentTitle} from '../hooks/useDocumentTitle';
import {Description} from '../pipelines/Description';
import {SidebarSection} from '../pipelines/SidebarComponents';
import {METADATA_ENTRY_FRAGMENT} from '../runs/MetadataEntry';
import {titleForRun} from '../runs/RunUtils';
import {TimeElapsed} from '../runs/TimeElapsed';
import {POLL_INTERVAL} from '../runs/useCursorPaginatedQuery';
import {TimestampDisplay} from '../schedules/TimestampDisplay';
import {Box} from '../ui/Box';
import {Loading} from '../ui/Loading';
import {PageHeader} from '../ui/PageHeader';
import {SplitPanelContainer} from '../ui/SplitPanelContainer';
import {Heading} from '../ui/Text';
import {FontFamily} from '../ui/styles';

import {repoAddressToSelector} from './repoAddressToSelector';
import {RepoAddress} from './types';
import {
  AssetGraphQuery_repositoryOrError_Repository_assetDefinitions,
  AssetGraphQuery_repositoryOrError_Repository_assetDefinitions_assetKey,
} from './types/AssetGraphQuery';
import {workspacePath} from './workspacePath';

type AssetDefinition = AssetGraphQuery_repositoryOrError_Repository_assetDefinitions;
type AssetKey = AssetGraphQuery_repositoryOrError_Repository_assetDefinitions_assetKey;

interface Props extends RouteComponentProps {
  repoAddress: RepoAddress;
}

interface Node {
  id: string;
  assetKey: AssetKey;
  definition: AssetDefinition;
}
interface LayoutNode {
  id: string;
  x: number;
  y: number;
}
interface GraphData {
  nodes: {[id: string]: Node};
  downstream: {[upstream: string]: {[downstream: string]: string}};
}
interface IPoint {
  x: number;
  y: number;
}
export type IEdge = {
  from: IPoint;
  to: IPoint;
  dashed: boolean;
};

const getNodeDimensions = (def: AssetDefinition) => {
  let height = 40;
  if (def.description) {
    height += 25;
  }
  if (def.assetMaterializations.length) {
    height += 22;
    if (runForDisplay(def)) {
      height += 22;
    }
  }
  return {width: Math.max(250, def.assetKey.path.join('>').length * 9.5) + 25, height};
};

const buildGraphData = (assetDefinitions: AssetDefinition[]) => {
  const nodes: {[id: string]: {id: string; assetKey: AssetKey; definition: AssetDefinition}} = {};
  const downstream: {[downstreamId: string]: {[upstreamId: string]: string}} = {};

  assetDefinitions.forEach((definition) => {
    const assetKeyJson = JSON.stringify(definition.assetKey.path);
    nodes[assetKeyJson] = {
      id: assetKeyJson,
      assetKey: definition.assetKey,
      definition,
    };
    definition.dependencies.forEach((dependency) => {
      const upstreamAssetKeyJson = JSON.stringify(dependency.upstreamAsset.assetKey.path);
      downstream[upstreamAssetKeyJson] = {
        ...(downstream[upstreamAssetKeyJson] || {}),
        [assetKeyJson]: dependency.inputName,
      };
    });
  });

  return {nodes, downstream};
};

const graphHasCycles = (graphData: GraphData) => {
  const nodes = new Set(Object.keys(graphData.nodes));
  const search = (stack: string[], node: string): boolean => {
    if (stack.indexOf(node) !== -1) {
      return true;
    }
    if (nodes.delete(node) === true) {
      const nextStack = stack.concat(node);
      return Object.keys(graphData.downstream[node] || {}).some((nextNode) =>
        search(nextStack, nextNode),
      );
    }
    return false;
  };
  let hasCycles = false;
  while (nodes.size !== 0) {
    hasCycles = hasCycles || search([], nodes.values().next().value);
  }
  return hasCycles;
};

const layoutGraph = (graphData: GraphData) => {
  const g = new dagre.graphlib.Graph();
  const marginBase = 100;
  const marginy = marginBase;
  const marginx = marginBase;
  g.setGraph({rankdir: 'TB', marginx, marginy});
  g.setDefaultEdgeLabel(() => ({}));

  Object.values(graphData.nodes).forEach((node) => {
    g.setNode(node.id, getNodeDimensions(node.definition));
  });
  Object.keys(graphData.downstream).forEach((upstreamId) => {
    const downstreamIds = Object.keys(graphData.downstream[upstreamId]);
    downstreamIds.forEach((downstreamId) => {
      g.setEdge({v: upstreamId, w: downstreamId}, {weight: 1});
    });
  });

  dagre.layout(g);

  const dagreNodesById: {[id: string]: dagre.Node} = {};
  g.nodes().forEach((id) => {
    const node = g.node(id);
    if (!node) {
      return;
    }
    dagreNodesById[id] = node;
  });

  let maxWidth = 0;
  let maxHeight = 0;
  const nodes: LayoutNode[] = [];
  Object.keys(dagreNodesById).forEach((id) => {
    const dagreNode = dagreNodesById[id];
    nodes.push({
      id,
      x: dagreNode.x - dagreNode.width / 2,
      y: dagreNode.y - dagreNode.height / 2,
    });
    maxWidth = Math.max(maxWidth, dagreNode.x + dagreNode.width);
    maxHeight = Math.max(maxHeight, dagreNode.y + dagreNode.height);
  });

  const edges: IEdge[] = [];
  g.edges().forEach((e) => {
    const points = g.edge(e).points;
    edges.push({
      from: points[0],
      to: points[points.length - 1],
      dashed: false,
    });
  });

  return {
    nodes,
    edges,
    width: maxWidth,
    height: maxHeight + marginBase,
  };
};

const buildSVGPath = pathVerticalDiagonal({
  source: (s: any) => s.source,
  target: (s: any) => s.target,
  x: (s: any) => s.x,
  y: (s: any) => s.y,
});

export const AssetGraphRoot: React.FC<Props> = (props) => {
  const {repoAddress} = props;
  const repositorySelector = repoAddressToSelector(repoAddress);
  const queryResult = useQuery(ASSETS_GRAPH_QUERY, {
    variables: {repositorySelector},
    notifyOnNetworkStatusChange: true,
    pollInterval: POLL_INTERVAL,
  });
  const [nodeSelection, setSelectedNode] = React.useState<Node | undefined>();

  const selectNode = (node: Node) => {
    setSelectedNode(node);
  };

  // Show the name of the composite solid we are within (-1 is the selection, -2 is current parent)
  // or the name of the pipeline tweaked to look a bit more like a graph name.

  useDocumentTitle('Workspace Asset Graph');

  return (
    <Box flex={{direction: 'column'}} style={{height: '100%'}}>
      <Box
        padding={24}
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          width: '100%',
        }}
      >
        <PageHeader
          title={<Heading>Asset Graph</Heading>}
          description={`Static asset definitions and dependencies defined in ${repoAddress.name}`}
        />
        <Box padding={{bottom: 8}}>
          <QueryCountdown pollInterval={POLL_INTERVAL} queryResult={queryResult} />
        </Box>
      </Box>
      <div style={{flex: 1, display: 'flex', borderTop: '1px solid #ececec', minHeight: 0}}>
        <SplitPanelContainer
          identifier="assets"
          firstInitialPercent={70}
          firstMinSize={600}
          first={
            <Loading allowStaleData queryResult={queryResult}>
              {({repositoryOrError}) => {
                if (repositoryOrError.__typename !== 'Repository') {
                  return null;
                }
                const graphData = buildGraphData(repositoryOrError.assetDefinitions);
                const hasCycles = graphHasCycles(graphData);
                const layout = hasCycles ? null : layoutGraph(graphData);
                const computeStatuses = hasCycles ? {} : buildGraphComputeStatuses(graphData);

                const nodeSelectionPipeline =
                  nodeSelection && runForDisplay(nodeSelection.definition)?.pipelineName;
                const samePipelineNodes = nodeSelectionPipeline
                  ? Object.values(graphData.nodes).filter(
                      (n) => runForDisplay(n.definition)?.pipelineName === nodeSelectionPipeline,
                    )
                  : [];

                return layout ? (
                  <SVGViewport
                    interactor={SVGViewport.Interactors.PanAndZoom}
                    graphWidth={layout.width}
                    graphHeight={layout.height}
                    onKeyDown={() => {}}
                    onDoubleClick={() => {}}
                    maxZoom={1.2}
                    maxAutocenterZoom={1.0}
                  >
                    {({scale: _scale}: any) => (
                      <SVGContainer width={layout.width} height={layout.height}>
                        <defs>
                          <marker
                            id="arrow"
                            viewBox="0 0 10 10"
                            refX="1"
                            refY="5"
                            markerUnits="strokeWidth"
                            markerWidth="2"
                            markerHeight="4"
                            orient="auto"
                          >
                            <path d="M 0 0 L 10 5 L 0 10 z" fill={Colors.LIGHT_GRAY1} />
                          </marker>
                        </defs>
                        <g opacity={0.8}>
                          {layout.edges.map((edge, idx) => (
                            <StyledPath
                              key={idx}
                              d={buildSVGPath({source: edge.from, target: edge.to})}
                              dashed={edge.dashed}
                              markerEnd="url(#arrow)"
                            />
                          ))}
                        </g>
                        {layout.nodes.map((layoutNode) => {
                          const graphNode = graphData.nodes[layoutNode.id];
                          const {width, height} = getNodeDimensions(graphNode.definition);
                          return (
                            <foreignObject
                              key={layoutNode.id}
                              x={layoutNode.x}
                              y={layoutNode.y}
                              width={width}
                              height={height}
                              onClick={() => selectNode(graphNode)}
                            >
                              <AssetNode
                                definition={graphNode.definition}
                                selected={nodeSelection?.id === graphNode.id}
                                seondaryHighlight={samePipelineNodes.includes(graphNode)}
                                computeStatus={computeStatuses[graphNode.id]}
                                repoAddress={repoAddress}
                              />
                            </foreignObject>
                          );
                        })}
                      </SVGContainer>
                    )}
                  </SVGViewport>
                ) : null;
              }}
            </Loading>
          }
          second={
            nodeSelection ? (
              <AssetPanel node={nodeSelection} repoAddress={repoAddress} />
            ) : (
              <NonIdealState
                title="No asset selected"
                description="Select an asset to see its definition and ops."
              />
            )
          }
        />
      </div>
    </Box>
  );
};

const AssetPanel = ({node, repoAddress}: {node: Node; repoAddress: RepoAddress}) => {
  return (
    <div style={{overflowY: 'auto'}}>
      <Box margin={32} style={{fontWeight: 'bold', fontSize: 18}}>
        {node.assetKey.path.join(' > ')}
      </Box>
      <SidebarSection title="Description">
        <Description description={node.definition.description || null} />
      </SidebarSection>
      <SidebarSection title="Jobs">
        {node.definition.jobNames
          ? node.definition.jobNames.map((name) => (
              <div key={name}>
                <Link to={workspacePath(repoAddress.name, repoAddress.location, `/jobs/${name}`)}>
                  {name}
                </Link>
              </div>
            ))
          : null}
      </SidebarSection>
      <SidebarSection title={'Latest Event'}>
        <AssetDetails assetKey={node.assetKey} asOf={null} asSidebarSection />
      </SidebarSection>

      <SidebarSection title={'Graphs'}>
        <AssetMaterializations assetKey={node.assetKey} asOf={null} asSidebarSection />
      </SidebarSection>
    </div>
  );
};

function runForDisplay(d: AssetDefinition) {
  const run = d.assetMaterializations[0]?.runOrError;
  return run.__typename === 'PipelineRun' ? run : null;
}

const ASSETS_GRAPH_QUERY = gql`
  query AssetGraphQuery($repositorySelector: RepositorySelector!) {
    repositoryOrError(repositorySelector: $repositorySelector) {
      ... on Repository {
        id
        name
        location {
          id
          name
        }
        assetDefinitions {
          id
          assetKey {
            path
          }
          opName
          description
          jobNames
          dependencies {
            inputName
            upstreamAsset {
              id
              assetKey {
                path
              }
            }
          }
          assetMaterializations(limit: 1) {
            materializationEvent {
              materialization {
                metadataEntries {
                  ...MetadataEntryFragment
                }
              }
              stepStats {
                stepKey
                startTime
                endTime
              }
            }
            runOrError {
              ... on PipelineRun {
                id
                runId
                status
                pipelineName
                mode
              }
            }
          }
        }
      }
    }
  }
  ${METADATA_ENTRY_FRAGMENT}
`;

const SVGContainer = styled.svg`
  overflow: visible;
  border-radius: 0;
`;
const StyledPath = styled('path')<{dashed: boolean}>`
  stroke-width: 4;
  stroke: ${Colors.LIGHT_GRAY1};
  ${({dashed}) => (dashed ? `stroke-dasharray: 8 2;` : '')}
  fill: none;
`;

const AssetNode: React.FC<{
  definition: AssetDefinition;
  selected: boolean;
  computeStatus: Status;
  repoAddress: RepoAddress;
  seondaryHighlight: boolean;
}> = ({definition, selected, computeStatus, repoAddress, seondaryHighlight}) => {
  const {materializationEvent: event, runOrError} = definition.assetMaterializations[0] || {};

  return (
    <div
      style={{
        border: '1px solid #ececec',
        outline: selected
          ? `2px solid ${Colors.BLUE4}`
          : seondaryHighlight
          ? `2px solid ${Colors.BLUE4}55`
          : 'none',
        marginTop: 10,
        marginRight: 4,
        marginLeft: 4,
        marginBottom: 2,
        position: 'absolute',
        background: 'white',
        inset: 0,
      }}
    >
      <div
        style={{
          display: 'flex',
          padding: '4px 8px',
          fontFamily: FontFamily.monospace,
          fontWeight: 600,
        }}
      >
        {definition.assetKey.path.join(' > ')}
        <div style={{flex: 1}} />
        <div
          title="Green if this asset has been materialized since it's upstream dependencies."
          style={{
            background: {old: 'red', 'downstream-from-old': 'orange', good: 'green', none: '#ccc'}[
              computeStatus
            ],
            borderRadius: 7.5,
            width: 15,
            height: 15,
          }}
        />
      </div>
      {definition.description && (
        <div
          style={{
            background: '#EFF4F7',
            padding: '4px 8px',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            borderTop: '1px solid #ccc',
            fontSize: 12,
          }}
        >
          {definition.description}
        </div>
      )}
      {event ? (
        <div
          style={{
            background: '#E1EAF0',
            padding: '4px 8px',
            borderTop: '1px solid #ccc',
            fontSize: 12,
            lineHeight: '18px',
          }}
        >
          {runOrError.__typename === 'PipelineRun' && (
            <div style={{display: 'flex', justifyContent: 'space-between'}}>
              <Link
                data-tooltip={`${runOrError.pipelineName}${
                  runOrError.mode !== 'default' ? `:${runOrError.mode}` : ''
                }`}
                data-tooltip-style={RunLinkTooltipStyle}
                style={{flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', paddingRight: 8}}
                to={workspacePath(
                  repoAddress.name,
                  repoAddress.location,
                  `jobs/${runOrError.pipelineName}:${runOrError.mode}`,
                )}
              >
                {`${runOrError.pipelineName}${
                  runOrError.mode !== 'default' ? `:${runOrError.mode}` : ''
                }`}
              </Link>
              <Link
                style={{fontFamily: FontFamily.monospace}}
                to={`/instance/runs/${runOrError.runId}?${qs.stringify({
                  timestamp: event.stepStats.endTime,
                  selection: event.stepStats.stepKey,
                  logs: `step:${event.stepStats.stepKey}`,
                })}`}
                target="_blank"
              >
                {titleForRun({runId: runOrError.runId})}
              </Link>
            </div>
          )}

          <div style={{display: 'flex', justifyContent: 'space-between'}}>
            {event.stepStats.endTime ? (
              <TimestampDisplay
                timestamp={event.stepStats.endTime}
                timeFormat={{showSeconds: false, showTimezone: false}}
              />
            ) : (
              'Never'
            )}
            <TimeElapsed startUnix={event.stepStats.startTime} endUnix={event.stepStats.endTime} />
          </div>
        </div>
      ) : (
        <span></span>
      )}
    </div>
  );
};

function buildGraphComputeStatuses(graphData: GraphData) {
  const timestamps: {[key: string]: number} = {};
  for (const node of Object.values(graphData.nodes)) {
    timestamps[node.id] =
      node.definition.assetMaterializations[0]?.materializationEvent.stepStats?.startTime || 0;
  }
  const upstream: {[key: string]: string[]} = {};
  Object.keys(graphData.downstream).forEach((upstreamId) => {
    const downstreamIds = Object.keys(graphData.downstream[upstreamId]);

    downstreamIds.forEach((downstreamId) => {
      upstream[downstreamId] = upstream[downstreamId] || [];
      upstream[downstreamId].push(upstreamId);
    });
  });

  const statuses: {[key: string]: Status} = {};

  for (const asset of Object.values(graphData.nodes)) {
    if (asset.definition.assetMaterializations.length === 0) {
      statuses[asset.id] = 'none';
    }
  }
  for (const asset of Object.values(graphData.nodes)) {
    const id = JSON.stringify(asset.assetKey.path);
    statuses[id] = findComputeStatusForId(timestamps, statuses, upstream, id);
  }
  return statuses;
}

type Status = 'good' | 'old' | 'downstream-from-old' | 'none';

function findComputeStatusForId(
  timestamps: {[key: string]: number},
  statuses: {[key: string]: Status},
  upstream: {[key: string]: string[]},
  id: string,
): Status {
  const ts = timestamps[id];
  const upstreamIds = upstream[id] || [];
  if (id in statuses) {
    return statuses[id];
  }

  statuses[id] = upstreamIds.some((uid) => timestamps[uid] > ts)
    ? 'old'
    : upstreamIds.some(
        (uid) => findComputeStatusForId(timestamps, statuses, upstream, uid) !== 'good',
      )
    ? 'downstream-from-old'
    : 'good';

  return statuses[id];
}

const RunLinkTooltipStyle = JSON.stringify({
  background: '#E1EAF0',
  padding: '4px 8px',
  marginLeft: -10,
  marginTop: -8,
  fontSize: 13,
  color: Colors.BLUE2,
  border: 0,
  borderRadius: 4,
} as CSSProperties);