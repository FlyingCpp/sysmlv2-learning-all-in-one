'use strict';

const assert = require('assert');
const {
  improveInterconnectionSvg,
  countNonOrthogonalConnectors,
  orthogonalPath
} = require('../apps/validator/interconnection-svg-layout');
const { detectDiagramKind, scoreSvgLayout } = require('../apps/validator/plantuml-layout-optimizer');

const OVERLAPPING_INTERCONNECTION_SVG = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" height="360px" style="width:520px;height:360px;background:#FFFFFF;" viewBox="0 0 520 360" width="520px">
<g id="cluster_E1"><a href="psysml:root"><rect fill="#FFFFFF" height="300" id="E1" style="stroke:#383838;stroke-width:1.5;" width="500" x="10" y="40"/><text font-size="14" textLength="80" x="220" y="60">Vehicle</text><line x1="10" x2="510" y1="70" y2="70"/></a></g>
<g id="cluster_E2"><a href="psysml:left"><rect fill="#FFFFFF" height="60" id="E2" rx="10" ry="10" style="stroke:#383838;stroke-width:1.5;" width="210" x="50" y="120"/><text font-size="14" textLength="120" x="95" y="138">left: Controller</text><line x1="50" x2="260" y1="146" y2="146"/></a></g>
<g id="cluster_E4"><a href="psysml:right"><rect fill="#FFFFFF" height="60" id="E4" rx="10" ry="10" style="stroke:#383838;stroke-width:1.5;" width="230" x="235" y="130"/><text font-size="14" textLength="140" x="280" y="148">right: Actuator</text><line x1="235" x2="465" y1="156" y2="156"/></a></g>
<text font-size="14" textLength="82" x="100" y="205">^commandOut</text><rect fill="#FFFFFF" height="12" style="stroke:#181818;stroke-width:1.5;" width="12" x="149" y="174"/>
<text font-size="14" textLength="70" x="300" y="115">^commandIn</text><rect fill="#FFFFFF" height="12" style="stroke:#181818;stroke-width:1.5;" width="12" x="344" y="124"/>
<g id="link_E3_E5"><a href="psysml:connection"><path d="M155,186 C170,215 320,100 350,124" fill="none" id="E3-E5" style="stroke:#181818;stroke-width:3.0;"/></a></g>
</svg>`;

function main() {
  assert.strictEqual(
    detectDiagramKind(
      'view vehicleInterconnection : StandardViewDefinitions::InterconnectionView { expose Vehicle; }',
      'vehicleInterconnection',
      ''
    ),
    'interconnection'
  );
  assert.strictEqual(
    detectDiagramKind('', 'vehicleInterconnection', 'INTERCONNECTION'),
    'interconnection'
  );

  const improved = improveInterconnectionSvg(OVERLAPPING_INTERCONNECTION_SVG);
  assert.strictEqual(improved.applied, true);
  assert.deepStrictEqual(improved.metrics, {
    layoutMode: 'ibd-single-context',
    rootCount: 1,
    compositeContextCount: 1,
    movedClusterCount: 2,
    partCount: 2,
    portCount: 2,
    connectorCount: 1,
    unresolvedConnectorCount: 0,
    partOverlapCount: 0,
    nonOrthogonalConnectorCount: 0
  });
  assert.strictEqual(countNonOrthogonalConnectors(improved.svg), 0);
  assert(improved.svg.includes('text-anchor="middle"'), 'port labels must be anchored to their allocated port positions');
  assert(!improved.svg.includes(' C170,215'), 'the curved connector must be replaced');
  assert.match(improved.svg, /d="M[-\d.]+,[-\d.]+ L[-\d.]+,[-\d.]+/);
  assert.match(improved.svg, /style="width:\d+px;height:\d+px;background:#FFFFFF;"/);

  const multiContextSource = OVERLAPPING_INTERCONNECTION_SVG.replace('</svg>', `
<g id="cluster_E6"><a href="psysml:pack"><rect fill="#FFFFFF" height="150" id="E6" style="stroke:#383838;stroke-width:1.5;" width="500" x="10" y="380"/><text font-size="14" textLength="90" x="215" y="400">BatteryPack</text><line x1="10" x2="510" y1="410" y2="410"/></a></g>
<g id="cluster_E7"><a href="psysml:module"><rect fill="#FFFFFF" height="60" id="E7" rx="10" ry="10" style="stroke:#383838;stroke-width:1.5;" width="210" x="50" y="440"/><text font-size="14" textLength="120" x="95" y="458">module: BatteryModule</text><line x1="50" x2="260" y1="466" y2="466"/></a></g>
</svg>`);
  const multiContext = improveInterconnectionSvg(multiContextSource);
  assert.strictEqual(multiContext.applied, true);
  assert.strictEqual(multiContext.metrics.layoutMode, 'route-only-multi-context');
  assert.strictEqual(multiContext.metrics.rootCount, 2);
  assert.strictEqual(multiContext.metrics.compositeContextCount, 2);
  assert.strictEqual(multiContext.metrics.movedClusterCount, 0);
  assert(multiContext.svg.includes('width="210" x="50" y="120"'),
    'multi-context routing must preserve the official part geometry so non-connector relationships stay attached');
  assert.strictEqual(countNonOrthogonalConnectors(multiContext.svg), 0);

  const unresolvedSource = OVERLAPPING_INTERCONNECTION_SVG.replace(
    'M155,186 C170,215 320,100 350,124',
    'M10,10 C170,215 320,100 500,350'
  );
  const unresolved = improveInterconnectionSvg(unresolvedSource);
  assert.strictEqual(unresolved.metrics.connectorCount, 0);
  assert.strictEqual(unresolved.metrics.unresolvedConnectorCount, 1);
  assert(unresolved.svg.includes('M10,10 C170,215 320,100 500,350'),
    'a connector whose endpoints cannot be bound to ports must remain unchanged');

  const score = scoreSvgLayout(improved.svg, { diagramKind: 'interconnection' });
  assert.strictEqual(score.metrics.textOverlapCount, 0);
  assert.strictEqual(score.metrics.textOutOfBoundsCount, 0);

  assert.strictEqual(orthogonalPath(
    { x: 10, y: 20, side: 'bottom' },
    { x: 50, y: 80, side: 'top' }
  ), 'M10,20 L10,50 L50,50 L50,80');

  console.log('PlantUML InterconnectionView IBD layout test passed');
}

main();
