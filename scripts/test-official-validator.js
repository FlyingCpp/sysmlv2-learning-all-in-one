'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { compileOfficialValidator, resolveOfficialPaths } = require('./compile-official-validator');

const vehicleFixtureDir = path.join(__dirname, '..', 'apps', 'validator', 'fixtures', 'official-sysml-v2-release', 'vehicle');

function readVehicleFixture(fileName) {
  return fs.readFileSync(path.join(vehicleFixtureDir, fileName), 'utf8');
}

function flattenSemanticOutline(outline) {
  const nodes = [];
  const visit = (node) => {
    nodes.push(node);
    for (const child of node.children || []) visit(child);
  };
  for (const root of outline?.roots || []) visit(root);
  return nodes;
}

function assertSemanticOutlineAvailable(result, label) {
  assert(result.semanticOutline, `${label} must include semanticOutline`);
  assert.strictEqual(result.semanticOutline.status, 'available', `${label} must expose an available official semantic outline: ${JSON.stringify(result.semanticOutline, null, 2)}`);
  assert.strictEqual(result.semanticOutline.source, 'official-sysml-v2-pilot-2026-04');
  assert(result.semanticOutline.contentHash, `${label} must include a stable contentHash`);
  assert(Array.isArray(result.semanticOutline.roots) && result.semanticOutline.roots.length > 0, `${label} semantic outline must include roots`);
  return flattenSemanticOutline(result.semanticOutline);
}

function assertOutlineNode(nodes, label, predicate) {
  const matched = nodes.some((node) => predicate(`${node.name || ''} ${node.declaredName || ''} ${node.qualifiedName || ''} ${node.metaclass || ''} ${node.displayKind || ''}`, node));
  assert(matched, `${label} not found in official semantic outline. Sample nodes: ${JSON.stringify(nodes.slice(0, 40).map((node) => ({
    name: node.name,
    declaredName: node.declaredName,
    qualifiedName: node.qualifiedName,
    metaclass: node.metaclass,
    displayKind: node.displayKind
  })), null, 2)}`);
}

async function main() {
  const paths = resolveOfficialPaths();
  if (!fs.existsSync(paths.jarPath) || !fs.existsSync(paths.libraryPath)) {
    console.log('official validator test skipped: official kernel zip is not present in .official-cache and no SYSML_OFFICIAL_JAR/SYSML_LIBRARY_PATH was provided');
    return;
  }

  compileOfficialValidator();
  process.env.SYSML_OFFICIAL_JAR = paths.jarPath;
  process.env.SYSML_LIBRARY_PATH = paths.libraryPath;
  process.env.SYSML_WRAPPER_CLASSES = paths.classesPath;
  process.env.OFFICIAL_VALIDATOR_ENABLED = 'true';
  process.env.OFFICIAL_VALIDATOR_FALLBACK = 'false';
  process.env.OFFICIAL_VALIDATOR_TIMEOUT_MS = process.env.OFFICIAL_VALIDATOR_TIMEOUT_MS || '300000';

  const { validateWorkspace, validatorHealth, OFFICIAL_SOURCE, backend, outlineBackend } = require('../apps/validator/validator');
  const health = validatorHealth();
  assert.strictEqual(health.official.officialAvailable, true, JSON.stringify(health, null, 2));
  assert.strictEqual(health.fallbackActive, false, JSON.stringify(health, null, 2));

  const valid = await validateWorkspace({
    content: 'package OfficialSmoke { part def Vehicle; part car : Vehicle; }'
  });
  assert.strictEqual(valid.source, OFFICIAL_SOURCE, JSON.stringify(valid, null, 2));
  assert.strictEqual(valid.validationCompleteness, 'official', JSON.stringify(valid, null, 2));
  assert.strictEqual(valid.fallbackActive, false, JSON.stringify(valid, null, 2));
  assert.strictEqual(valid.syntaxValid, true, JSON.stringify(valid.diagnostics, null, 2));
  assert.strictEqual(valid.semanticValid, true, JSON.stringify(valid.diagnostics, null, 2));
  assert(valid.modelElements.some((element) => element.kind === 'part def' && element.name === 'Vehicle'));
  const smokeOutline = assertSemanticOutlineAvailable(valid, 'minimal model');
  assertOutlineNode(smokeOutline, 'OfficialSmoke package', (text) => text.includes('OfficialSmoke') && text.includes('Package'));
  assertOutlineNode(smokeOutline, 'Vehicle part definition', (text) => text.includes('Vehicle') && text.includes('PartDefinition'));
  assertOutlineNode(smokeOutline, 'car part usage', (text) => text.includes('car') && text.includes('PartUsage'));

  const validQuotedName = await validateWorkspace({
    content: "package OfficialQuotedName { part def aircraft; part 'C_919' : aircraft; }"
  });
  assert.strictEqual(validQuotedName.source, OFFICIAL_SOURCE, JSON.stringify(validQuotedName, null, 2));
  assert.strictEqual(validQuotedName.syntaxValid, true, JSON.stringify(validQuotedName.diagnostics, null, 2));
  assert.strictEqual(validQuotedName.semanticValid, true, JSON.stringify(validQuotedName.diagnostics, null, 2));
  assert(validQuotedName.modelElements.some((element) => element.kind === 'part' && element.name === 'C_919' && element.typeName === 'aircraft'), JSON.stringify(validQuotedName.modelElements, null, 2));

  const invalid = await validateWorkspace({
    content: 'package OfficialBad { part def Vehicle'
  });
  assert.strictEqual(invalid.source, OFFICIAL_SOURCE, JSON.stringify(invalid, null, 2));
  assert.strictEqual(invalid.fallbackActive, false, JSON.stringify(invalid, null, 2));
  assert.strictEqual(invalid.syntaxValid, false, JSON.stringify(invalid, null, 2));
  assert(invalid.diagnostics.some((diagnostic) => diagnostic.source === OFFICIAL_SOURCE), JSON.stringify(invalid, null, 2));
  assert(invalid.semanticOutline, 'invalid official validation must still include semanticOutline status');
  assert.strictEqual(invalid.semanticOutline.status, 'invalid', JSON.stringify(invalid.semanticOutline, null, 2));
  assert.deepStrictEqual(invalid.semanticOutline.roots, []);

  const validEnergyRollup = await validateWorkspace({
    content: `
package OfficialEnergyRollup {
  private import NumericalFunctions::*;

  part def BatteryCell {
    attribute nominalVoltageV : ScalarValues::Real = 3.7;
    attribute capacityAh : ScalarValues::Real = 220.0;
    attribute energyWh : ScalarValues::Real = nominalVoltageV * capacityAh;
  }

  part def BatteryModule {
    part cells[12] : BatteryCell;
    attribute moduleVoltageV : ScalarValues::Real = sum(cells.nominalVoltageV);
    attribute moduleEnergyWh : ScalarValues::Real = sum(cells.energyWh);
  }

  part def BatteryPack {
    part modules[8] : BatteryModule;
    attribute totalEnergyWh : ScalarValues::Real = sum(modules.moduleEnergyWh);
  }
}`
  });
  assert.strictEqual(validEnergyRollup.source, OFFICIAL_SOURCE, JSON.stringify(validEnergyRollup, null, 2));
  assert.strictEqual(validEnergyRollup.syntaxValid, true, JSON.stringify(validEnergyRollup.diagnostics, null, 2));
  assert.strictEqual(validEnergyRollup.semanticValid, true, JSON.stringify(validEnergyRollup.diagnostics, null, 2));
  assert(validEnergyRollup.modelElements.some((element) => element.kind === 'attribute' && element.name === 'moduleVoltageV' && element.valueExpression === 'sum(cells.nominalVoltageV)'), JSON.stringify(validEnergyRollup.modelElements, null, 2));
  assert(validEnergyRollup.modelElements.some((element) => element.kind === 'attribute' && element.name === 'moduleEnergyWh' && element.valueExpression === 'sum(cells.energyWh)'), JSON.stringify(validEnergyRollup.modelElements, null, 2));
  assert(validEnergyRollup.modelElements.some((element) => element.kind === 'attribute' && element.name === 'totalEnergyWh' && element.valueExpression === 'sum(modules.moduleEnergyWh)'), JSON.stringify(validEnergyRollup.modelElements, null, 2));

  const validCompactExpressionFormatting = await validateWorkspace({
    content: `
package OfficialCompactExpressionFormatting {
  private import NumericalFunctions::*;

  part def BatteryCell {
    attribute nominalVoltageV:ScalarValues::Real=3.7;
    attribute capacityAh:ScalarValues::Real=220;
    attribute energyWh:ScalarValues::Real=nominalVoltageV*capacityAh;
  }

  part def BatteryModule {
    part cells[12] : BatteryCell;
    attribute moduleEnergyWh:ScalarValues::Real=sum(cells.energyWh);
  }

  part def BatteryPack {
    attribute moduleCount:ScalarValues::Integer=8;
    attribute cellsPerModule:ScalarValues::Integer=12;
    attribute totalCellCount:ScalarValues::Integer=moduleCount*cellsPerModule;
    part modules[8] : BatteryModule;
    attribute totalEnergyWh:ScalarValues::Real=sum(modules.moduleEnergyWh);
    attribute usableEnergyKWh:ScalarValues::Real=totalEnergyWh/1000;
  }
}`
  });
  assert.strictEqual(validCompactExpressionFormatting.source, OFFICIAL_SOURCE, JSON.stringify(validCompactExpressionFormatting, null, 2));
  assert.strictEqual(validCompactExpressionFormatting.syntaxValid, true, JSON.stringify(validCompactExpressionFormatting.diagnostics, null, 2));
  assert.strictEqual(validCompactExpressionFormatting.semanticValid, true, JSON.stringify(validCompactExpressionFormatting.diagnostics, null, 2));
  assert(validCompactExpressionFormatting.modelElements.some((element) => element.kind === 'attribute' && element.name === 'totalCellCount' && element.valueExpression === 'moduleCount*cellsPerModule'), JSON.stringify(validCompactExpressionFormatting.modelElements, null, 2));
  assert(validCompactExpressionFormatting.modelElements.some((element) => element.kind === 'attribute' && element.name === 'usableEnergyKWh' && element.valueExpression === 'totalEnergyWh/1000'), JSON.stringify(validCompactExpressionFormatting.modelElements, null, 2));

  const validReferencedMultiplicity = await validateWorkspace({
    content: `
package OfficialReferencedMultiplicity {
  part def BatteryModule;

  part def BatteryPack {
    attribute moduleCount : ScalarValues::Integer = 8;
    part modules[moduleCount] : BatteryModule;
  }
}`
  });
  assert.strictEqual(validReferencedMultiplicity.source, OFFICIAL_SOURCE, JSON.stringify(validReferencedMultiplicity, null, 2));
  assert.strictEqual(validReferencedMultiplicity.syntaxValid, true, JSON.stringify(validReferencedMultiplicity.diagnostics, null, 2));
  assert.strictEqual(validReferencedMultiplicity.semanticValid, true, JSON.stringify(validReferencedMultiplicity.diagnostics, null, 2));
  assert(validReferencedMultiplicity.modelElements.some((element) => element.kind === 'part' && element.name === 'modules' && element.multiplicity === 'moduleCount'), JSON.stringify(validReferencedMultiplicity.modelElements, null, 2));

  const validVehicleVariantSlotBinding = await validateWorkspace({
    content: `
package OfficialVehicleVariantSlotBinding {
  part def Motor;
  abstract part def Powertrain;
  part def SingleMotorPowertrain :> Powertrain { part motor : Motor; }
  part def DualMotorPowertrain :> Powertrain { part frontMotor : Motor; part rearMotor : Motor; }

  part def Vehicle {
    part powertrain : Powertrain;
  }

  part standardPowertrain : SingleMotorPowertrain;
  part performancePowertrain : DualMotorPowertrain;

  part standardEV : Vehicle {
    part :>> powertrain = standardPowertrain;
  }

  part performanceEV : Vehicle {
    part :>> powertrain = performancePowertrain;
  }
}`
  });
  assert.strictEqual(validVehicleVariantSlotBinding.source, OFFICIAL_SOURCE, JSON.stringify(validVehicleVariantSlotBinding, null, 2));
  assert.strictEqual(validVehicleVariantSlotBinding.syntaxValid, true, JSON.stringify(validVehicleVariantSlotBinding.diagnostics, null, 2));
  assert.strictEqual(validVehicleVariantSlotBinding.semanticValid, true, JSON.stringify(validVehicleVariantSlotBinding.diagnostics, null, 2));
  assert(validVehicleVariantSlotBinding.modelElements.some((element) => element.kind === 'part' && element.name === 'powertrain' && element.valueExpression === 'standardPowertrain'), JSON.stringify(validVehicleVariantSlotBinding.modelElements, null, 2));
  assert(validVehicleVariantSlotBinding.modelElements.some((element) => element.kind === 'part' && element.name === 'powertrain' && element.valueExpression === 'performancePowertrain'), JSON.stringify(validVehicleVariantSlotBinding.modelElements, null, 2));

  const validCollectionSizeCount = await validateWorkspace({
    content: `
package OfficialCollectionSizeCount {
  private import CollectionFunctions::*;

  part def BatteryModule;

  part def BatteryPack {
    part modules[8] : BatteryModule;
    attribute moduleCount : ScalarValues::Integer = size(modules);
  }
}`
  });
  assert.strictEqual(validCollectionSizeCount.source, OFFICIAL_SOURCE, JSON.stringify(validCollectionSizeCount, null, 2));
  assert.strictEqual(validCollectionSizeCount.syntaxValid, true, JSON.stringify(validCollectionSizeCount.diagnostics, null, 2));
  assert.strictEqual(validCollectionSizeCount.semanticValid, true, JSON.stringify(validCollectionSizeCount.diagnostics, null, 2));
  assert(validCollectionSizeCount.modelElements.some((element) => element.kind === 'attribute' && element.name === 'moduleCount' && element.valueExpression === 'size(modules)'), JSON.stringify(validCollectionSizeCount.modelElements, null, 2));

  const invalidTypeNameDotLookup = await validateWorkspace({
    content: `
package OfficialBadEnergyRollup {
  part def BatteryCell {
    attribute nominalVoltageV : ScalarValues::Real = 3.7;
    attribute capacityAh : ScalarValues::Real = 220.0;
  }

  part def BatteryPack {
    attribute totalCellCount : ScalarValues::Integer = 96;
    attribute totalEnergyWh : ScalarValues::Real =
      totalCellCount * BatteryCell.nominalVoltageV * BatteryCell.capacityAh;
  }
}`
  });
  assert.strictEqual(invalidTypeNameDotLookup.source, OFFICIAL_SOURCE, JSON.stringify(invalidTypeNameDotLookup, null, 2));
  assert.strictEqual(invalidTypeNameDotLookup.syntaxValid, true, JSON.stringify(invalidTypeNameDotLookup, null, 2));
  assert.strictEqual(invalidTypeNameDotLookup.semanticValid, false, JSON.stringify(invalidTypeNameDotLookup, null, 2));
  assert(invalidTypeNameDotLookup.diagnostics.some((diagnostic) => String(diagnostic.message || '').includes('nominalVoltageV')), JSON.stringify(invalidTypeNameDotLookup, null, 2));
  assert(invalidTypeNameDotLookup.diagnostics.some((diagnostic) => String(diagnostic.message || '').includes('Must be a valid feature')), JSON.stringify(invalidTypeNameDotLookup, null, 2));

  const validSatisfySubjectBinding = await validateWorkspace({
    content: `
package OfficialRequirementSubjectBinding {
  part def ElectricVehicle;
  part evPrototype : ElectricVehicle;

  requirement def VehicleNeed {
    subject vehicle : ElectricVehicle;
  }

  requirement usableRange : VehicleNeed;
  satisfy usableRange by evPrototype;
}`
  });
  assert.strictEqual(validSatisfySubjectBinding.source, OFFICIAL_SOURCE, JSON.stringify(validSatisfySubjectBinding, null, 2));
  assert.strictEqual(validSatisfySubjectBinding.syntaxValid, true, JSON.stringify(validSatisfySubjectBinding.diagnostics, null, 2));
  assert.strictEqual(validSatisfySubjectBinding.semanticValid, true, JSON.stringify(validSatisfySubjectBinding.diagnostics, null, 2));

  const invalidDuplicateSubjectBinding = await validateWorkspace({
    content: `
package OfficialBadRequirementSubjectBinding {
  part def ElectricVehicle;
  part evPrototype : ElectricVehicle;

  requirement def VehicleNeed {
    subject vehicle : ElectricVehicle;
  }

  requirement usableRange : VehicleNeed {
    subject vehicle = evPrototype;
  }

  satisfy usableRange by evPrototype;
}`
  });
  assert.strictEqual(invalidDuplicateSubjectBinding.source, OFFICIAL_SOURCE, JSON.stringify(invalidDuplicateSubjectBinding, null, 2));
  assert.strictEqual(invalidDuplicateSubjectBinding.syntaxValid, true, JSON.stringify(invalidDuplicateSubjectBinding, null, 2));
  assert.strictEqual(invalidDuplicateSubjectBinding.semanticValid, false, JSON.stringify(invalidDuplicateSubjectBinding, null, 2));
  assert(invalidDuplicateSubjectBinding.diagnostics.some((diagnostic) => String(diagnostic.message || '').includes('Cannot override a binding feature value')), JSON.stringify(invalidDuplicateSubjectBinding, null, 2));

  const validCustomInterfaceUsageNames = await validateWorkspace({
    content: `
package OfficialCustomInterfaceNames {
  item def ElectricalPower;
  item def TorqueCommand;
  item def CoolantFlow;

  port def PowerPort { ref item power : ElectricalPower; }
  port def CommandPort { ref item command : TorqueCommand; }
  port def ThermalPort { ref item coolant : CoolantFlow; }

  part def BatteryPack {
    port dcOut : PowerPort;
    port thermalIn : ThermalPort;
  }

  part def Inverter {
    port dcIn : PowerPort;
    port commandIn : CommandPort;
  }

  part def VehicleController {
    port commandOut : CommandPort;
  }

  part def CoolingLoop {
    port batterySide : ThermalPort;
  }

  interface def BatteryToInverter {
    end source : PowerPort;
    end target : PowerPort;
    flow source.power to target.power;
  }

  interface def ControllerToInverter {
    end source : CommandPort;
    end target : CommandPort;
    flow source.command to target.command;
  }

  interface def BatteryCoolingInterface {
    end source : ThermalPort;
    end target : ThermalPort;
    flow source.coolant to target.coolant;
  }

  part def ElectricVehicle {
    part battery : BatteryPack;
    part inverter : Inverter;
    part controller : VehicleController;
    part cooling : CoolingLoop;

    interface powerLink : BatteryToInverter connect battery.dcOut to inverter.dcIn;
    interface commandLink : ControllerToInverter connect controller.commandOut to inverter.commandIn;
    interface coolantLink : BatteryCoolingInterface connect cooling.batterySide to battery.thermalIn;
  }
}`
  });
  assert.strictEqual(validCustomInterfaceUsageNames.source, OFFICIAL_SOURCE, JSON.stringify(validCustomInterfaceUsageNames, null, 2));
  assert.strictEqual(validCustomInterfaceUsageNames.syntaxValid, true, JSON.stringify(validCustomInterfaceUsageNames.diagnostics, null, 2));
  assert.strictEqual(validCustomInterfaceUsageNames.semanticValid, true, JSON.stringify(validCustomInterfaceUsageNames.diagnostics, null, 2));
  assert(validCustomInterfaceUsageNames.modelElements.some((element) => element.kind === 'interface' && element.name === 'commandLink' && element.typeName === 'ControllerToInverter'), JSON.stringify(validCustomInterfaceUsageNames.modelElements, null, 2));
  assert(validCustomInterfaceUsageNames.modelElements.some((element) => element.kind === 'interface' && element.name === 'coolantLink' && element.typeName === 'BatteryCoolingInterface'), JSON.stringify(validCustomInterfaceUsageNames.modelElements, null, 2));

  const vehicleDefinitions = await validateWorkspace({
    files: [{ path: 'VehicleDefinitions.sysml', content: readVehicleFixture('VehicleDefinitions.sysml') }],
    entryFile: 'VehicleDefinitions.sysml'
  });
  assert.strictEqual(vehicleDefinitions.syntaxValid, true, JSON.stringify(vehicleDefinitions.diagnostics, null, 2));
  assert.strictEqual(vehicleDefinitions.semanticValid, true, JSON.stringify(vehicleDefinitions.diagnostics, null, 2));
  const vehicleDefinitionsOutline = assertSemanticOutlineAvailable(vehicleDefinitions, 'VehicleDefinitions fixture');
  assertOutlineNode(vehicleDefinitionsOutline, 'VehicleDefinitions package', (text) => text.includes('VehicleDefinitions') && text.includes('Package'));
  assertOutlineNode(vehicleDefinitionsOutline, 'Vehicle part def', (text) => text.includes('Vehicle') && text.includes('PartDefinition'));
  assertOutlineNode(vehicleDefinitionsOutline, 'port definition', (text) => text.includes('PortDefinition'));
  assertOutlineNode(vehicleDefinitionsOutline, 'interface definition', (text) => text.includes('InterfaceDefinition'));

  const vehicleUsages = await validateWorkspace({
    files: [
      { path: 'VehicleDefinitions.sysml', content: readVehicleFixture('VehicleDefinitions.sysml') },
      { path: 'VehicleUsages.sysml', content: readVehicleFixture('VehicleUsages.sysml') }
    ],
    entryFile: 'VehicleUsages.sysml'
  });
  assert.strictEqual(vehicleUsages.syntaxValid, true, JSON.stringify(vehicleUsages.diagnostics, null, 2));
  assert.strictEqual(vehicleUsages.semanticValid, true, JSON.stringify(vehicleUsages.diagnostics, null, 2));
  const vehicleUsagesOutline = assertSemanticOutlineAvailable(vehicleUsages, 'VehicleUsages fixture');
  assertOutlineNode(vehicleUsagesOutline, 'VehicleUsages package', (text) => text.includes('VehicleUsages') && text.includes('Package'));
  assertOutlineNode(vehicleUsagesOutline, 'VehicleDefinitions public import', (text) => text.includes('VehicleDefinitions') && text.includes('Import'));
  assertOutlineNode(vehicleUsagesOutline, 'vehicle usage', (text) => text.includes('vehicle_C1') && text.includes('PartUsage'));
  assertOutlineNode(vehicleUsagesOutline, 'nested part usage', (text) => text.includes('frontAxleAssembly') && text.includes('PartUsage'));
  assertOutlineNode(vehicleUsagesOutline, 'subsetting or redefinition relation', (text) => text.includes('Subsetting') || text.includes('Redefinition'));

  const simpleVehicleModel = await validateWorkspace({
    files: [{ path: 'SimpleVehicleModel.sysml', content: readVehicleFixture('SimpleVehicleModel.sysml') }],
    entryFile: 'SimpleVehicleModel.sysml'
  });
  assert.strictEqual(simpleVehicleModel.syntaxValid, true, JSON.stringify(simpleVehicleModel.diagnostics, null, 2));
  assert.strictEqual(simpleVehicleModel.semanticValid, true, JSON.stringify(simpleVehicleModel.diagnostics, null, 2));
  const simpleVehicleOutline = assertSemanticOutlineAvailable(simpleVehicleModel, 'SimpleVehicleModel fixture');
  assertOutlineNode(simpleVehicleOutline, 'SimpleVehicleModel package', (text) => text.includes('SimpleVehicleModel') && text.includes('Package'));
  assertOutlineNode(simpleVehicleOutline, 'Definitions package', (text) => text.includes('Definitions') && text.includes('Package'));
  const definitionPackages = simpleVehicleOutline.filter((node) => String(node.qualifiedName || node.name || '').includes('Definitions') && String(node.metaclass || node.displayKind || '').includes('Package'));
  assert(definitionPackages.length >= 3, `SimpleVehicleModel must expose multiple Definitions subpackages: ${JSON.stringify(definitionPackages, null, 2)}`);

  await backend.stop();
  await outlineBackend.stop();
  console.log('official validator tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
