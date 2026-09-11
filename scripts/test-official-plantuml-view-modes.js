'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { compileOfficialValidator, resolveOfficialPaths } = require('./compile-official-validator');
const { improveInterconnectionSvg, countNonOrthogonalConnectors } = require('../packages/sysml-plantuml-service/interconnection-svg-layout');

const VEHICLE_BRAKE_GENERAL_VIEW = fs.readFileSync(
  path.join(__dirname, 'fixtures', 'plantuml-view-regressions', 'vehicle-brake-detail.sysml'),
  'utf8'
);
const EV_LESSON_01_STARTER = fs.readFileSync(
  path.join(__dirname, '..', 'courses', 'ev-sysml-v2-foundation', 'courses', 'course-01', 'lesson-01', 'starter.sysml'),
  'utf8'
);
const ELECTRIC_VEHICLE_CHARGING_INTERCONNECTION = fs.readFileSync(
  path.join(__dirname, 'fixtures', 'plantuml-view-regressions', 'electric-vehicle-charging-interconnection.sysml'),
  'utf8'
);
const ELECTRIC_VEHICLE_CHARGING_COMPLEX_INTERCONNECTION = fs.readFileSync(
  path.join(__dirname, 'fixtures', 'plantuml-view-regressions', 'electric-vehicle-charging-complex-interconnection.sysml'),
  'utf8'
);
const INTERFACE_SANDBOX = `package InterfaceSandbox {
  part def Controller;
  part def Actuator;

  item def Command;

  port def CommandPort {
    out item command : Command;
  }

  part controller : Controller;
  part actuator : Actuator;
}
`;

const CUSTOM_SEQUENCE = {
  label: 'custom SequenceView specialization',
  viewName: 'CustomSequenceModeTest::customSequenceView',
  content: `
package CustomSequenceModeTest {
  view def CustomSequenceView specializes StandardViewDefinitions::SequenceView;
  occurrence def InteractionSequence;

  view customSequenceView : CustomSequenceView {
    expose InteractionSequence;
  }
}
`
};

const MODEL_RENDERING_OVERRIDE = {
  viewName: 'ModelRenderingOverrideTest::sequenceAsTree',
  content: `
package ModelRenderingOverrideTest {
  private import Views::*;
  occurrence def InteractionSequence;
  view sequenceAsTree : StandardViewDefinitions::SequenceView {
    expose InteractionSequence;
    render asTreeDiagram;
  }
}
`
};

function customViewCase(testCase) {
  const shortViewName = testCase.viewName.slice(testCase.viewName.lastIndexOf('::') + 2);
  const customDefinitionName = `Custom${testCase.label}`;
  const directDeclaration = `view ${shortViewName} : ${testCase.expectedDefinition}`;
  const customDeclaration = `view def ${customDefinitionName} specializes ${testCase.expectedDefinition};\n\n  view ${shortViewName} : ${customDefinitionName}`;
  return {
    ...testCase,
    label: `custom ${testCase.label} specialization`,
    content: testCase.content.replace(directDeclaration, customDeclaration)
  };
}

function clusterRectGeometry(svg) {
  const geometry = [];
  const clusterPattern = /<g\b[^>]*\bid=["']cluster_(E\d+)["'][^>]*>[\s\S]*?<\/g>/gi;
  for (const match of String(svg || '').matchAll(clusterPattern)) {
    const rect = match[0].match(new RegExp(`<rect\\b[^>]*\\bid=["']${match[1]}["'][^>]*>`, 'i'))?.[0] || '';
    geometry.push([
      match[1],
      svgNumberAttr(rect, 'x'),
      svgNumberAttr(rect, 'y'),
      svgNumberAttr(rect, 'width'),
      svgNumberAttr(rect, 'height')
    ].join(':'));
  }
  return geometry.sort();
}

function svgNumberAttr(tag, name) {
  return Number.parseFloat(String(tag || '').match(new RegExp(`\\b${name}=["'](-?\\d+(?:\\.\\d+)?)["']`, 'i'))?.[1] || 'NaN');
}

async function main() {
  const {
    PLANTUML_VIEW_FEW_SHOTS,
    SYSML_STANDARD_VIEW_EXAMPLES,
    PLANTUML_VIEW_MODELING_GUIDANCE,
    PLANTUML_VIEW_RESPONSE_GUIDANCE,
    PLANTUML_VIEW_KNOWLEDGE_GUIDANCE,
    PLANTUML_VIEW_SELECTION_GUIDANCE
  } = await import('../apps/teacher/dist/agent/sysml-view-guidance.mjs');
  const ALL_STANDARD_CASES = SYSML_STANDARD_VIEW_EXAMPLES.map((example) => ({
    label: example.viewDefinition.split('::').at(-1),
    viewName: example.viewName,
    expectedDefinition: example.viewDefinition,
    content: example.content
  }));
  const CASES = PLANTUML_VIEW_FEW_SHOTS.map((example) => ({
    label: example.viewDefinition.split('::').at(-1),
    viewName: example.viewName,
    expectedMode: example.renderMode,
    expectedDefinition: example.viewDefinition,
    expectedSvgText: example.expectedSvgText,
    content: example.content
  }));
  const sequenceCase = CASES.find((testCase) => testCase.expectedMode === 'SEQUENCE');
  const generalCase = CASES.find((testCase) => testCase.expectedMode === 'DEFAULT');
  assert(sequenceCase && generalCase, 'view few-shot set must include SequenceView and GeneralView');
  const OCCURRENCE_SEQUENCE = {
    viewName: sequenceCase.viewName.replace('SequenceViewExample', 'OccurrenceSequenceModeTest'),
    content: sequenceCase.content
      .replaceAll('SequenceViewExample', 'OccurrenceSequenceModeTest')
      .replace('part def Interaction', 'occurrence def Interaction')
  };
  assert.equal(CASES.length, 5, 'AI Teacher prompt must expose exactly the five dedicated PlantUML view modes');
  assert.deepEqual(
    ALL_STANDARD_CASES.map((testCase) => testCase.label),
    ['GeneralView', 'InterconnectionView', 'ActionFlowView', 'StateTransitionView', 'SequenceView', 'GeometryView', 'GridView', 'BrowserView'],
    'AI Teacher prompt must enumerate every definition in official StandardViewDefinitions'
  );
  const rendererSource = fs.readFileSync(
    path.join(__dirname, '..', 'packages', 'sysml-plantuml-service', 'official', 'src', 'org', 'sysmlv2', 'learning', 'validator', 'OfficialPlantUmlCli.java'),
    'utf8'
  );
  const rendererModes = [...rendererSource.matchAll(/new ViewModeSpec\("([^"]+)",\s*"([^"]+)"\)/gu)]
    .map((match) => `${match[1]}=${match[2]}`)
    .sort();
  const promptModes = CASES.map((testCase) => `${testCase.expectedDefinition}=${testCase.expectedMode}`).sort();
  assert.deepEqual(promptModes, rendererModes,
    'AI Teacher supported-view prompt and OfficialPlantUmlCli dedicated mode registry must stay synchronized');
  assert(PLANTUML_VIEW_MODELING_GUIDANCE.includes('候选中必须包含至少一个显式view usage及其expose'));
  assert(PLANTUML_VIEW_MODELING_GUIDANCE.includes('需求为主、普通结构或混合内容默认选GeneralView'));
  assert(!PLANTUML_VIEW_MODELING_GUIDANCE.includes('学生没有明确要求视图或图形呈现时，不新增View'));
  assert(PLANTUML_VIEW_MODELING_GUIDANCE.includes('禁止生成`view def Name { expose ...; }`'));
  for (const testCase of CASES) {
    assert(PLANTUML_VIEW_SELECTION_GUIDANCE.includes(testCase.expectedDefinition),
      `PlantUML View选择清单缺少${testCase.expectedDefinition}`);
    assert(PLANTUML_VIEW_SELECTION_GUIDANCE.includes(`renderMode=${testCase.expectedMode}`),
      `PlantUML View选择清单缺少${testCase.expectedMode}映射`);
  }
  assert(PLANTUML_VIEW_KNOWLEDGE_GUIDANCE.includes('这8种都可以在SysML v2模型中使用'));
  assert(PLANTUML_VIEW_KNOWLEDGE_GUIDANCE.includes('GeometryView、GridView、BrowserView'));
  assert(PLANTUML_VIEW_RESPONSE_GUIDANCE.indexOf('以下每个最小示例')
    < PLANTUML_VIEW_RESPONSE_GUIDANCE.indexOf('平台渲染能力边界'));
  assert(PLANTUML_VIEW_RESPONSE_GUIDANCE.indexOf('平台渲染能力边界')
    < PLANTUML_VIEW_RESPONSE_GUIDANCE.indexOf('终末回答职责'));
  assert(PLANTUML_VIEW_RESPONSE_GUIDANCE.includes('“没有平台专用渲染”绝不等于“不是标准View”'));

  const {validateWorkspace,generatePlantUml,backend,outlineBackend,plantUmlBackend}=require('./diagram-test-runtime').diagramTestRuntime();

  try {
    const standardExamplesValidation = await validateWorkspace({
      files: ALL_STANDARD_CASES.map((testCase) => ({
        path: `${testCase.label}.sysml`,
        content: testCase.content
      }))
    });
    assert.strictEqual(standardExamplesValidation.fallbackActive, false,
      'all eight standard View examples must use the Official Validator');
    assert.strictEqual(standardExamplesValidation.syntaxValid, true,
      `standard View examples have syntax errors: ${JSON.stringify(standardExamplesValidation.diagnostics, null, 2)}`);
    assert.strictEqual(standardExamplesValidation.semanticValid, true,
      `standard View examples have semantic errors: ${JSON.stringify(standardExamplesValidation.diagnostics, null, 2)}`);

    for (const testCase of CASES) {
      const result = await generatePlantUml({
        content: testCase.content,
        viewName: testCase.viewName,
        layoutOptimization: { mode: 'off' }
      });

      assert.strictEqual(result.ok, true, `${testCase.label} render failed: ${JSON.stringify(result, null, 2)}`);
      assert.strictEqual(result.kind, 'SVG', `${testCase.label} must return a visible SVG`);
      assert.strictEqual(result.requestedRenderMode, '', `${testCase.label} must be inferred without a request override`);
      assert.strictEqual(result.resolvedRenderMode, testCase.expectedMode, `${testCase.label} mapped to the wrong PlantUML mode`);
      assert.strictEqual(result.renderMode, testCase.expectedMode, `${testCase.label} compatibility mode field must report the resolved mode`);
      assert.strictEqual(result.renderModeSource, 'standard-view-definition', `${testCase.label} must be resolved from official view semantics`);
      assert.strictEqual(result.standardViewDefinition, testCase.expectedDefinition, `${testCase.label} must report the matched standard view definition`);
      assert(String(result.svg || '').includes('<svg'), `${testCase.label} did not return SVG markup`);
      for (const expectedText of testCase.expectedSvgText) {
        assert(String(result.svg).includes(expectedText), `${testCase.label} SVG is missing ${expectedText}`);
      }
    }

    const customResult = await generatePlantUml({
      content: CUSTOM_SEQUENCE.content,
      viewName: CUSTOM_SEQUENCE.viewName,
      layoutOptimization: { mode: 'off' }
    });
    // 此映射用例只有空 occurrence definition，没有生命线或消息；不能把空图算生成成功。
    assert.strictEqual(customResult.ok, false, JSON.stringify(customResult, null, 2));
    assert.strictEqual(customResult.kind, 'EMPTY');
    assert(customResult.diagnostics.some(diagnostic => diagnostic.code === 'EMPTY_VIEW'));
    assert.strictEqual(customResult.resolvedRenderMode, 'SEQUENCE', 'indirect specialization must resolve to SequenceView');
    assert.strictEqual(customResult.standardViewDefinition, 'StandardViewDefinitions::SequenceView');

    for (const testCase of CASES.map(customViewCase)) {
      const result = await generatePlantUml({
        content: testCase.content,
        viewName: testCase.viewName,
        layoutOptimization: { mode: 'off' }
      });
      assert.strictEqual(result.ok, true, `${testCase.label} render failed: ${JSON.stringify(result, null, 2)}`);
      assert.strictEqual(result.resolvedRenderMode, testCase.expectedMode, `${testCase.label} must follow the standard specialization chain`);
      assert.strictEqual(result.standardViewDefinition, testCase.expectedDefinition, `${testCase.label} must report its standard ancestor`);
    }

    const occurrenceSequence = await generatePlantUml({
      content: OCCURRENCE_SEQUENCE.content,
      viewName: OCCURRENCE_SEQUENCE.viewName,
      layoutOptimization: { mode: 'off' }
    });
    assert.strictEqual(occurrenceSequence.ok, true, JSON.stringify(occurrenceSequence, null, 2));
    assert.strictEqual(occurrenceSequence.resolvedRenderMode, 'SEQUENCE', 'the original occurrence-def interaction shape must resolve from SequenceView semantics');
    assert(String(occurrenceSequence.svg).includes('client') && String(occurrenceSequence.svg).includes('response'), 'occurrence-def SequenceView must render lifeline and message content');

    const modelRenderingOverride = await generatePlantUml({
      content: MODEL_RENDERING_OVERRIDE.content,
      viewName: MODEL_RENDERING_OVERRIDE.viewName,
      renderMode: 'SEQUENCE',
      layoutOptimization: { mode: 'off' }
    });
    assert.strictEqual(modelRenderingOverride.ok, true, JSON.stringify(modelRenderingOverride, null, 2));
    assert.strictEqual(modelRenderingOverride.requestedRenderMode, 'SEQUENCE');
    assert.strictEqual(modelRenderingOverride.resolvedRenderMode, 'TREE', 'model-declared rendering must override the request and standard view mapping');
    assert.strictEqual(modelRenderingOverride.renderModeSource, 'model-rendering');

    const requestOverride = await generatePlantUml({
      content: generalCase.content,
      viewName: generalCase.viewName,
      renderMode: 'INTERCONNECTION',
      layoutOptimization: { mode: 'off' }
    });
    assert.strictEqual(requestOverride.ok, true, JSON.stringify(requestOverride, null, 2));
    assert.strictEqual(requestOverride.requestedRenderMode, 'INTERCONNECTION');
    assert.strictEqual(requestOverride.resolvedRenderMode, 'INTERCONNECTION');
    assert.strictEqual(requestOverride.renderModeSource, 'request');

    const sequenceAgain = await generatePlantUml({
      content: sequenceCase.content,
      viewName: sequenceCase.viewName,
      layoutOptimization: { mode: 'off' }
    });
    const generalAgain = await generatePlantUml({
      content: generalCase.content,
      viewName: generalCase.viewName,
      layoutOptimization: { mode: 'off' }
    });
    assert.strictEqual(sequenceAgain.resolvedRenderMode, 'SEQUENCE');
    assert.strictEqual(generalAgain.resolvedRenderMode, 'DEFAULT', 'DEFAULT must reset the long-lived renderer after SEQUENCE');
    assert(String(generalAgain.svg).includes('Vehicle'), 'GeneralView after SequenceView must remain a structural rendering');
    assert.strictEqual(generalAgain.viewPolicy.renderMode.resolved, 'DEFAULT');
    assert.strictEqual(generalAgain.viewPolicy.renderMode.source, 'standard-view-definition');

    const electricVehicleValidation = await validateWorkspace({
      content: ELECTRIC_VEHICLE_CHARGING_INTERCONNECTION
    });
    assert.strictEqual(electricVehicleValidation.syntaxValid, true,
      JSON.stringify(electricVehicleValidation.diagnostics, null, 2));
    assert.strictEqual(electricVehicleValidation.semanticValid, true,
      JSON.stringify(electricVehicleValidation.diagnostics, null, 2));
    const electricVehicleInterconnection = await generatePlantUml({
      content: ELECTRIC_VEHICLE_CHARGING_INTERCONNECTION,
      viewName: 'ElectricVehicleCharging::vehicleInterconnection'
    });
    assert.strictEqual(electricVehicleInterconnection.ok, true, JSON.stringify(electricVehicleInterconnection, null, 2));
    assert.strictEqual(electricVehicleInterconnection.resolvedRenderMode, 'INTERCONNECTION');
    assert.strictEqual(electricVehicleInterconnection.interconnectionLayout?.applied, true,
      JSON.stringify(electricVehicleInterconnection.interconnectionLayout, null, 2));
    assert.strictEqual(electricVehicleInterconnection.interconnectionLayout.metrics.partOverlapCount, 0);
    assert.strictEqual(electricVehicleInterconnection.interconnectionLayout.metrics.nonOrthogonalConnectorCount, 0);
    assert.strictEqual(electricVehicleInterconnection.interconnectionLayout.metrics.unresolvedConnectorCount, 0);
    assert.strictEqual(electricVehicleInterconnection.interconnectionLayout.metrics.connectorCount,
      electricVehicleInterconnection.renderer === 'local-layout' ? 10 : 5);
    assert.strictEqual(countNonOrthogonalConnectors(electricVehicleInterconnection.svg), 0);
    assert.doesNotMatch(electricVehicleInterconnection.svg, /<\/\w+\s+[^>]*>/,
      'optimized InterconnectionView SVG closing elements must not contain attributes');
    if (electricVehicleInterconnection.renderer === 'local-layout') {
      assert.strictEqual(electricVehicleInterconnection.layoutOptimization.selected, 'ELK_ORTHOGONAL');
      assert.deepStrictEqual(electricVehicleInterconnection.geometryQuality.issues, []);
      const scene = electricVehicleInterconnection.layoutScene;
      assert.strictEqual(scene.edges.length, 10);
      const roots = scene.nodes.filter(node => !node.parentId);
      assert.deepStrictEqual(roots.map(node => node.name).sort(), ['ElectricVehicle', 'ev']);
      for (const root of roots) assert.strictEqual(scene.edges.filter(edge => edge.contextId === root.id).length, 5,
        'definition and usage each retain their five inherited connections');
    } else {
      assert.match(electricVehicleInterconnection.svg, /<text\b[^>]*text-anchor="middle"[^>]*>\^\w+<\/text>/,
        'optimized InterconnectionView port-label attributes must remain on opening text elements');
      assert.strictEqual(electricVehicleInterconnection.renderer, 'engineering-native');
      assert.strictEqual(electricVehicleInterconnection.layoutOptimization.selected, 'PLANTUML_NATIVE');
      assert(electricVehicleInterconnection.plantuml.indexOf('<style>') < electricVehicleInterconnection.plantuml.indexOf('rec usage'),
        'native Interconnection fallback must apply its skin before official rec nodes');
      assert.strictEqual(electricVehicleInterconnection.layoutOptimization.candidates[0].metrics.textOverlapCount, 0);
      assert.strictEqual(electricVehicleInterconnection.layoutOptimization.candidates[0].metrics.textOutOfBoundsCount, 0);
    }
    for (const expectedText of [
      'chargePort: ChargingPort',
      'obc: OnBoardCharger',
      'bms: BatteryManagementSystem',
      'tms: ThermalManagementSystem',
      'battery: BatteryPack'
    ]) {
      const [expectedName, expectedType] = expectedText.split(': ');
      assert(electricVehicleInterconnection.renderer === 'local-layout'
        ? electricVehicleInterconnection.layoutScene.nodes.some(node => node.name === expectedName && node.typeName === expectedType)
        : String(electricVehicleInterconnection.svg).includes(expectedText),
        `ElectricVehicle InterconnectionView SVG is missing ${expectedText}`);
    }

    const complexInterconnectionValidation = await validateWorkspace({
      content: ELECTRIC_VEHICLE_CHARGING_COMPLEX_INTERCONNECTION
    });
    assert.strictEqual(complexInterconnectionValidation.syntaxValid, true,
      JSON.stringify(complexInterconnectionValidation.diagnostics, null, 2));
    assert.strictEqual(complexInterconnectionValidation.semanticValid, true,
      JSON.stringify(complexInterconnectionValidation.diagnostics, null, 2));
    const complexInterconnectionRaw = await generatePlantUml({
      content: ELECTRIC_VEHICLE_CHARGING_COMPLEX_INTERCONNECTION,
      viewName: 'ElectricVehicleCharging::vehicleInterconnection',
      layoutOptimization: { mode: 'off' }
    });
    const complexInterconnection = await generatePlantUml({
      content: ELECTRIC_VEHICLE_CHARGING_COMPLEX_INTERCONNECTION,
      viewName: 'ElectricVehicleCharging::vehicleInterconnection'
    });
    assert.strictEqual(complexInterconnectionRaw.ok, true, JSON.stringify(complexInterconnectionRaw, null, 2));
    assert.strictEqual(complexInterconnection.ok, true, JSON.stringify(complexInterconnection, null, 2));
    assert.strictEqual(complexInterconnection.resolvedRenderMode, 'INTERCONNECTION');
    assert.strictEqual(complexInterconnection.interconnectionLayout?.applied, true,
      JSON.stringify(complexInterconnection.interconnectionLayout, null, 2));
    assert.strictEqual(complexInterconnection.renderer, 'local-layout');
    assert.strictEqual(complexInterconnection.diagramDocument.nodes.filter(n => !n.parentId).length, 9);
    assert.strictEqual(complexInterconnection.interconnectionLayout.metrics.unresolvedConnectorCount, 0,
      JSON.stringify(complexInterconnection.interconnectionLayout.metrics, null, 2));
    // 模块 8 条；电池包 16 + 4*8；整车 5 + 48；定义和用法各有独立继承上下文。
    assert.strictEqual(complexInterconnection.interconnectionLayout.metrics.connectorCount, 53 + 53 + 48 + 8);
    assert.strictEqual(complexInterconnection.interconnectionLayout.metrics.nonOrthogonalConnectorCount, 0);
    assert.strictEqual(countNonOrthogonalConnectors(complexInterconnection.svg), 0);
    const directComplexLayout = improveInterconnectionSvg(complexInterconnectionRaw.svg);
    assert.strictEqual(directComplexLayout.applied, true, JSON.stringify(directComplexLayout, null, 2));
    assert.strictEqual(directComplexLayout.metrics.layoutMode, 'route-only-multi-context');
    assert.strictEqual(directComplexLayout.metrics.connectorCount, 29);
    assert.strictEqual(directComplexLayout.metrics.unresolvedConnectorCount, 0);
    assert.strictEqual(directComplexLayout.metrics.nonOrthogonalConnectorCount, 0);
    const complexClusterGeometry = clusterRectGeometry(directComplexLayout.svg);
    const complexRawClusterGeometry = clusterRectGeometry(complexInterconnectionRaw.svg);
    assert.strictEqual(complexRawClusterGeometry.length, 23, 'complex fixture must retain all expected context and part clusters');
    assert.deepStrictEqual(
      complexClusterGeometry,
      complexRawClusterGeometry,
      'multi-context routing must not detach official typing/dependency edges by moving their endpoint clusters'
    );
    for (const expectedText of ['ElectricVehicle', 'BatteryPack', 'BatteryModule', 'CellGroup', 'PackSensor']) {
      assert(String(complexInterconnection.svg).includes(expectedText),
        `complex InterconnectionView must retain exposed ${expectedText} content`);
    }

    const vehicleBrakeDetail = await generatePlantUml({
      content: VEHICLE_BRAKE_GENERAL_VIEW,
      viewName: 'Sandbox::vehicleBrakeDetail',
      layoutOptimization: { mode: 'off' }
    });
    assert.strictEqual(vehicleBrakeDetail.ok, true, JSON.stringify(vehicleBrakeDetail, null, 2));
    assert.strictEqual(vehicleBrakeDetail.kind, 'SVG', 'the reported Vehicle/BrakeSystem GeneralView regression must return visible SVG');
    assert.strictEqual(vehicleBrakeDetail.resolvedRenderMode, 'DEFAULT');
    assert.strictEqual(vehicleBrakeDetail.standardViewDefinition, 'StandardViewDefinitions::GeneralView');
    for (const expectedText of ['Vehicle', 'vehicle', 'BrakeSystem', 'masterCylinder', 'frontBrakes']) {
      assert(String(vehicleBrakeDetail.svg).includes(expectedText), `Vehicle/BrakeSystem GeneralView SVG is missing ${expectedText}`);
    }

    const evLessonStarter = await generatePlantUml({
      content: EV_LESSON_01_STARTER,
      viewName: 'EV_C01_L01::firstPackageBrowserView',
      layoutOptimization: { mode: 'off' }
    });
    assert.strictEqual(evLessonStarter.ok, true, JSON.stringify(evLessonStarter, null, 2));
    assert.strictEqual(evLessonStarter.kind, 'SVG', 'EV Course 01 Lesson 01 starter BrowserView must return visible SVG');
    assert.strictEqual(evLessonStarter.resolvedRenderMode, 'DEFAULT', 'unmapped BrowserView must use the official default mode');
    assert.strictEqual(evLessonStarter.renderModeSource, 'default');
    assert(String(evLessonStarter.svg).includes('BatteryPack'), 'EV Course 01 Lesson 01 BrowserView must show BatteryPack');

    const interfaceSandbox = await generatePlantUml({
      content: INTERFACE_SANDBOX,
      layoutOptimization: { mode: 'off' }
    });
    assert.strictEqual(interfaceSandbox.ok, true, JSON.stringify(interfaceSandbox, null, 2));
    assert.strictEqual(interfaceSandbox.kind, 'SVG', 'bench template without an explicit view must return visible SVG');
    assert.strictEqual(interfaceSandbox.resolvedRenderMode, 'DEFAULT');
    for (const expectedText of ['Controller', 'Actuator', 'controller', 'actuator']) {
      assert(String(interfaceSandbox.svg).includes(expectedText), `bench template auto view SVG is missing ${expectedText}`);
    }

    console.log('official PlantUML standard view-mode tests passed');
  } finally {
    // validateWorkspace还会启动语义Outline JVM；两者都使用既有restart清理测试子进程，
    // PlantUML后端仍按原路径graceful stop。
    backend.restart();
    outlineBackend.restart();
    await plantUmlBackend.stop();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
