'use strict';

const assert = require('assert');

const API = process.env.LEARNING_API_URL || 'http://localhost:8080';
const VALIDATOR = process.env.LEARNING_VALIDATOR_URL || 'http://localhost:9090';
let authCookie = String(process.env.LEARNING_AUTH_COOKIE || '').trim();
const rotateGuestSessions = !authCookie;
const VALIDATION_REQUESTS_PER_SESSION = 5;
let validationRequestsForSession = 0;

async function main() {
  const health = await getJson(`${VALIDATOR}/health`);
  assert.strictEqual(health.official?.source, 'official-sysml-v2-pilot-2026-04', JSON.stringify(health, null, 2));
  assert.strictEqual(health.fallbackActive, false, JSON.stringify(health, null, 2));
  await expectAnonymousValidationDenied();
  if (!authCookie) authCookie = await createGuestSession();

  await expectPass('generic valid model', `${API}/api/validate`, {
    files: [{ path: 'main.sysml', content: 'package StudentGood { part def Vehicle; part vehicle : Vehicle; }' }]
  });

  await expectStrictFail('missing closing brace syntax error', `${API}/api/validate`, {
    files: [{ path: 'main.sysml', content: 'package StudentBad { part def Vehicle; part vehicle : Vehicle;' }]
  }, { syntaxValid: false, diagnosticIncludes: "expecting '}'", studentHintId: 'syntax.missing-right-brace' });

  await expectStrictFail('undefined type semantic error', `${API}/api/validate`, {
    files: [{ path: 'main.sysml', content: 'package StudentBad { part vehicle : MissingVehicle; }' }]
  }, { semanticValid: false, diagnosticIncludes: "Couldn't resolve reference to Type", studentHintId: 'semantic.unresolved-type' });

  await expectStrictFail('course-like BatteryPack2 undefined type explains the real cause', `${API}/api/validate`, {
    files: [{
      path: 'main.sysml',
      content: 'package EV { part def BatteryPack; part def ElectricVehicle { part battery : BatteryPack2; } }'
    }]
  }, {
    semanticValid: false,
    diagnosticIncludes: 'BatteryPack2',
    studentHintId: 'semantic.unresolved-type',
    studentHintTitleIncludes: 'BatteryPack2 这个类型没有定义',
    studentHintMessageIncludes: 'part battery : BatteryPack2',
    studentHintGoodExampleIncludes: 'part battery : BatteryPack;'
  });

  await expectStrictFail('official port definition semantic rule', `${API}/api/validate`, {
    files: [{
      path: 'main.sysml',
      content: 'package StudentBad { item def ElectricalPower; port def PowerPort { item power : ElectricalPower; } }'
    }]
  }, { semanticValid: false, diagnosticIncludes: 'Owned usages of a port definition', studentHintId: 'semantic.port-owned-usages' });

  await expectStrictFail('single-ended interface semantic error', `${API}/api/validate`, {
    files: [{
      path: 'main.sysml',
      content: 'package StudentBad { item def ElectricalPower; port def PowerPort { ref item power : ElectricalPower; } interface def PowerInterface { end source : PowerPort; } }'
    }]
  }, { semanticValid: false, diagnosticIncludes: 'Must have at least two related elements', studentHintId: 'semantic.interface-ends' });

  await expectStrictFail('flow missing to syntax error', `${API}/api/validate`, {
    files: [{
      path: 'main.sysml',
      content: 'package StudentBad { item def ElectricalPower; port def PowerPort { ref item power : ElectricalPower; } interface def PowerInterface { end source : PowerPort; end target : PowerPort; flow source.power target.power; } }'
    }]
  }, { syntaxValid: false, diagnosticIncludes: "expecting 'to'", studentHintId: 'syntax.flow-to' });

  await expectStrictFail('connect missing feature semantic error', `${API}/api/validate`, {
    files: [{
      path: 'main.sysml',
      content: 'package StudentBad { item def ElectricalPower; port def PowerPort { ref item power : ElectricalPower; } part def BatteryPack { port dcOut : PowerPort; } part def Motor { port powerIn : PowerPort; } part def ElectricVehicle { part battery : BatteryPack; connect battery.dcOut to motor.powerIn; } }'
    }]
  }, { semanticValid: false, diagnosticIncludes: "Couldn't resolve reference to Feature", studentHintId: 'semantic.unresolved-feature' });

  const course01L03 = await getJson(`${API}/api/lessons/course-01-lesson-03`);
  const course01L03Source = fileContent(course01L03, 'main.sysml');
  const course01L03Completed = completeCourse01Lesson03(course01L03Source);
  await expectPass('course-01 requirement trace subject model passes', `${API}/api/lessons/course-01-lesson-03/validate`, lessonPayload(course01L03Completed));
  await expectStrictFail('course-01 duplicate requirement subject binding explains real cause', `${API}/api/lessons/course-01-lesson-03/validate`, lessonPayload(
    course01L03Completed.replace(
      '  requirement usableRange : VehicleNeed;',
      '  requirement usableRange : VehicleNeed {\n    subject vehicle = evPrototype;\n  }'
    )
  ), { semanticValid: false, diagnosticIncludes: 'Cannot override a binding feature value', studentHintId: 'semantic.binding-feature-value-override' });

  const course03 = await getJson(`${API}/api/lessons/course-03-lesson-01`);
  const course03Source = fileContent(course03, 'main.sysml');
  const course03Completed = completeCourse03Lesson01(course03Source);
  await expectPass('course-03 completed model passes', `${API}/api/lessons/course-03-lesson-01/validate`, lessonPayload(course03Completed));
  await expectCourseFail('course-03 wrong wheel multiplicity', `${API}/api/lessons/course-03-lesson-01/validate`, lessonPayload(
    course03Completed.replace('part wheels[4] : Wheel;', 'part wheels[3] : Wheel;')
  ), 'wheels[4]');
  await expectCourseFail('course-03 wrong range target', `${API}/api/lessons/course-03-lesson-01/validate`, lessonPayload(
    course03Completed.replace('attribute targetRangeKm : ScalarValues::Real = 480.0;', 'attribute targetRangeKm : ScalarValues::Real = 500.0;')
  ), '480.0');

  const course03L02 = await getJson(`${API}/api/lessons/course-03-lesson-02`);
  const course03L02Source = fileContent(course03L02, 'main.sysml');
  const course03L02Completed = completeCourse03Lesson02(course03L02Source);
  await expectPass('course-03 battery energy chain passes', `${API}/api/lessons/course-03-lesson-02/validate`, lessonPayload(course03L02Completed));
  await expectPass('course-03 compact expression formatting passes', `${API}/api/lessons/course-03-lesson-02/validate`, lessonPayload(
    course03L02Completed
      .replace('moduleCount * cellsPerModule', 'moduleCount*cellsPerModule')
      .replace('totalEnergyWh / 1000.0', 'totalEnergyWh/1000')
  ));
  await expectCourseFail('course-03 old 50Ah energy chain fails', `${API}/api/lessons/course-03-lesson-02/validate`, lessonPayload(
    course03L02Completed.replace('capacityAh : ScalarValues::Real = 220.0', 'capacityAh : ScalarValues::Real = 50.0')
  ), '220.0');
  await expectStrictFail('course-03 type-name dot attribute chain fails', `${API}/api/lessons/course-03-lesson-02/validate`, lessonPayload(
    course03L02Completed.replace('sum(modules.moduleEnergyWh)', 'totalCellCount * BatteryCell.nominalVoltageV * BatteryCell.capacityAh')
  ), { semanticValid: false, diagnosticIncludes: 'nominalVoltageV' });
  await expectCourseFail('course-03 wrong usable energy bridge fails', `${API}/api/lessons/course-03-lesson-02/validate`, lessonPayload(
    course03L02Completed.replace('totalEnergyWh / 1000.0', '999.0')
  ), 'totalEnergyWh / 1000.0');
  await expectCourseFail('course-03 hard-coded pack energy skips usage rollup', `${API}/api/lessons/course-03-lesson-02/validate`, lessonPayload(
    course03L02Completed.replace('sum(modules.moduleEnergyWh)', 'totalCellCount*3.7*220.0')
  ), 'sum(modules.moduleEnergyWh)');

  const course03L03 = await getJson(`${API}/api/lessons/course-03-lesson-03`);
  const course03L03Source = fileContent(course03L03, 'main.sysml');
  const course03L03Completed = completeCourse03Lesson03(course03L03Source);
  await expectPass('course-03 product variant binding passes', `${API}/api/lessons/course-03-lesson-03/validate`, lessonPayload(course03L03Completed));
  await expectCourseFail('course-03 empty vehicle configs do not select variants', `${API}/api/lessons/course-03-lesson-03/validate`, lessonPayload(
    course03L03Completed
      .replace('part standardEV : Vehicle {\n    part :>> powertrain = standardPowertrain;\n  }', 'part standardEV : Vehicle;')
      .replace('part performanceEV : Vehicle {\n    part :>> powertrain = performancePowertrain;\n  }', 'part performanceEV : Vehicle;')
  ), 'part :>> powertrain = standardPowertrain');

  const course04 = await getJson(`${API}/api/lessons/course-04-lesson-01`);
  const course04Source = fileContent(course04, 'main.sysml');
  const course04Completed = completeCourse04Lesson01(course04Source);
  await expectPass('course-04 completed model passes', `${API}/api/lessons/course-04-lesson-01/validate`, lessonPayload(course04Completed));
  await expectCourseFail('course-04 wrong interface name', `${API}/api/lessons/course-04-lesson-01/validate`, lessonPayload(
    course04Completed
      .replace('interface def BatteryToInverter', 'interface def BatteryToMotor')
      .replace('expose BatteryToInverter;', 'expose BatteryToMotor;')
  ), 'BatteryToInverter');

  const course04L02 = await getJson(`${API}/api/lessons/course-04-lesson-02`);
  const course04L02Source = fileContent(course04L02, 'main.sysml');
  const course04L02Completed = completeCourse04Lesson02(course04L02Source);
  await expectPass('course-04 multi-flow attributes model passes', `${API}/api/lessons/course-04-lesson-02/validate`, lessonPayload(course04L02Completed));
  await expectCourseFail('course-04 hidden attribute name contract stays enforced', `${API}/api/lessons/course-04-lesson-02/validate`, lessonPayload(
    course04L02Completed.replace('attribute voltageV : ScalarValues::Real = 400.0;', 'attribute voltage : ScalarValues::Real = 400.0;')
  ), 'voltageV');

  const course04L03 = await getJson(`${API}/api/lessons/course-04-lesson-03`);
  const course04L03Source = fileContent(course04L03, 'main.sysml');
  const course04L03Completed = completeCourse04Lesson03(course04L03Source);
  await expectPass('course-04 interface binding model passes', `${API}/api/lessons/course-04-lesson-03/validate`, lessonPayload(course04L03Completed));
  await expectPass('course-04 interface binding accepts custom usage names', `${API}/api/lessons/course-04-lesson-03/validate`, lessonPayload(
    course04L03Completed
      .replace('interface torqueCommandLink : ControllerToInverter', 'interface commandLink : ControllerToInverter')
      .replace('interface batteryCoolingLink : BatteryCoolingInterface', 'interface coolantLink : BatteryCoolingInterface')
  ));
  await expectStrictFail('course-04 full-width colon explains the real cause', `${API}/api/lessons/course-04-lesson-03/validate`, lessonPayload(
    course04L03Completed.replace('interface torqueCommandLink :', 'interface torqueCommandLink ：')
  ), { studentHintId: 'syntax.fullwidth-colon' });

  const course07 = await getJson(`${API}/api/lessons/course-07-lesson-03`);
  const course07Source = fileContent(course07, 'main.sysml');
  const course07Completed = completeCourse07Lesson03(course07Source);
  await expectPass('course-07 high-voltage subject model passes', `${API}/api/lessons/course-07-lesson-03/validate`, lessonPayloadFromLesson(course07, course07Completed));
  await expectCourseFail('course-07 SOC boundary regression', `${API}/api/lessons/course-07-lesson-03/validate`, lessonPayloadFromLesson(course07,
    course07Completed.replace('    assume constraint socWindow {\n      startSOCPercent == 10.0 and endSOCPercent == 80.0\n    }\n', '')
  ), 'socWindow');
  await expectStrictFail('course-07 high-voltage subject regression', `${API}/api/lessons/course-07-lesson-03/validate`, lessonPayloadFromLesson(course07,
    regressHighVoltageSubject(course07Completed)
  ), { semanticValid: false, diagnosticIncludes: "Couldn't resolve reference to Element 'system'" });
  const course09Safety = await getJson(`${API}/api/lessons/course-09-lesson-03`);
  const course09SafetySource = fileContent(course09Safety, 'main.sysml');
  const course09SafetyCompleted = completeCourse09Lesson03(course09SafetySource);
  await expectPass('course-09 high-voltage verification model passes', `${API}/api/lessons/course-09-lesson-03/validate`, lessonPayloadFromLesson(course09Safety, course09SafetyCompleted));
  await expectStrictFail('course-09 high-voltage subject regression', `${API}/api/lessons/course-09-lesson-03/validate`, lessonPayloadFromLesson(course09Safety,
    regressHighVoltageSubject(course09SafetyCompleted)
  ), { semanticValid: false, diagnosticIncludes: "Couldn't resolve reference to Element 'system'" });

  const course10 = await getJson(`${API}/api/lessons/course-10-lesson-03`);
  const course10Source = fileContent(course10, 'main.sysml');
  const course10Completed = completeCourse10Lesson03(course10Source);
  await expectPass('course-10 completed model passes', `${API}/api/lessons/course-10-lesson-03/validate`, lessonPayloadFromLesson(course10, course10Completed));
  await expectPass('course-10 final interface evidence accepts custom usage names', `${API}/api/lessons/course-10-lesson-03/validate`, lessonPayloadFromLesson(course10,
    course10Completed
      .replace('interface batteryToInverter : PropulsionPowerInterface', 'interface dcPowerLink : PropulsionPowerInterface')
      .replace('interface inverterToMotor : PropulsionPowerInterface', 'interface motorPowerLink : PropulsionPowerInterface')
  ));
  await expectCourseFail('course-10 wrong analysis name', `${API}/api/lessons/course-10-lesson-03/validate`, lessonPayloadFromLesson(course10,
    course10Completed
      .replace('analysis def RangeAnalysis', 'analysis def AlternateRangeAnalysis')
      .replace('analysis finalRangeAnalysis : RangeAnalysis {', 'analysis finalRangeAnalysis : AlternateRangeAnalysis {')
  ), 'RangeAnalysis');
  await expectCourseFail('course-10 final range subject regression', `${API}/api/lessons/course-10-lesson-03/validate`, lessonPayloadFromLesson(course10,
    course10Completed.replace(
      'requirement finalRange : FinalRangeRequirement {\n    subject vehicle : FinalVehicle;',
      'requirement finalRange : FinalRangeRequirement {\n    subject vehicle : ElectricVehicle;'
    )
  ), 'subject vehicle : FinalVehicle');

  const finalProject = await getJson(`${API}/api/final-project`);
  const finalSource = fileContent(finalProject, 'main.sysml');
  await expectPass('final project starter passes', `${API}/api/final-project/validate`, lessonPayload(finalSource));
  await expectCourseFail('final project wrong satisfy target', `${API}/api/final-project/validate`, lessonPayload(
    finalSource.replace('satisfy finalRange by finalVehicle;', 'part alternateVehicle : ElectricVehicle;\n  satisfy finalRange by alternateVehicle;')
  ), 'finalRange 到 finalVehicle');

  await expectStrictFail('lesson syntax blocks course rules', `${API}/api/lessons/course-03-lesson-01/validate`, lessonPayload(
    course03Source.replace('part def ElectricVehicle {', 'part def ElectricVehicle { unknown stuff')
  ), { syntaxValid: false, diagnosticIncludes: '严格语法/语义校验未通过' });

  console.log('learning diagnostics tests passed');
}

function completeCourse03Lesson01(source) {
  return source
    .replace('    // TODO 1: 增加 Wheel 的 attribute 参数 diameterM 和 massKg。', '    attribute diameterM : ScalarValues::Real = 0.68;\n    attribute massKg : ScalarValues::Real = 24.0;')
    .replace('    // TODO 2: 增加 VehicleBody 的 attribute 参数 dragCoeff 和 massKg。', '    attribute dragCoeff : ScalarValues::Real = 0.26;\n    attribute massKg : ScalarValues::Real = 420.0;')
    .replace('    // TODO 3: 增加 ElectricVehicle 的 attribute 参数 targetRangeKm。', '    attribute targetRangeKm : ScalarValues::Real = 480.0;');
}

function completeCourse01Lesson03(source) {
  return source
    .replace('  // TODO 1: 定义 VehicleNeed 需求类型，并声明 vehicle subject。', '  requirement def VehicleNeed {\n    subject vehicle : ElectricVehicle;\n  }')
    .replace('  // TODO 2: 创建 usableRange 的 requirement usage，subject 保持开放。', '  requirement usableRange : VehicleNeed;')
    .replace('  // TODO 3: 定义 VehicleModelPurpose 分析类型，并声明 vehicle subject。', '  analysis def VehicleModelPurpose {\n    subject vehicle : ElectricVehicle;\n  }')
    .replace('  // TODO 4: 创建 purposeCheck 的 analysis usage，并绑定 subject。', '  analysis purposeCheck : VehicleModelPurpose {\n    subject vehicle = evPrototype;\n  }')
    .replace('  // TODO 5: 用 satisfy 连接 usableRange 和 evPrototype。', '  satisfy usableRange by evPrototype;')
    .replace('    // TODO 6: 添加 VehicleNeed 的 expose 视图条目。', '    expose VehicleNeed;')
    .replace('    // TODO 7: 添加 usableRange 的 expose 视图条目。', '    expose usableRange;')
    .replace('    // TODO 8: 添加 VehicleModelPurpose 的 expose 视图条目。', '    expose VehicleModelPurpose;')
    .replace('    // TODO 9: 添加 purposeCheck 的 expose 视图条目。', '    expose purposeCheck;');
}

function completeCourse03Lesson02(source) {
  return source
    .replace('    // TODO 1: 增加 BatteryModule 的 attribute 参数，并汇总 cells.energyWh。', '    attribute cellCount : ScalarValues::Integer = 12;\n    part cells[12] : BatteryCell;\n    attribute moduleEnergyWh : ScalarValues::Real = sum(cells.energyWh);')
    .replace('    // TODO 2: 增加 BatteryPack 的 attribute 参数，含 usableEnergyKWh，并汇总 modules.moduleEnergyWh。', '    attribute moduleCount : ScalarValues::Integer = 8;\n    attribute cellsPerModule : ScalarValues::Integer = 12;\n    attribute totalCellCount : ScalarValues::Integer = moduleCount * cellsPerModule;\n    part modules[8] : BatteryModule;\n    attribute totalEnergyWh : ScalarValues::Real = sum(modules.moduleEnergyWh);\n    attribute usableEnergyKWh : ScalarValues::Real = totalEnergyWh / 1000.0;')
    .replace('  // TODO 3: 创建 vehicleBattery 的 part usage，作为电池包配置对象。', '  part vehicleBattery : BatteryPack;');
}

function completeCourse03Lesson03(source) {
  return source
    .replace('  // TODO 1: 定义 abstract part def Powertrain。', '  abstract part def Powertrain;')
    .replace('  // TODO 2: 定义 SingleMotorPowertrain 特化 Powertrain，并加入 motor part。', '  part def SingleMotorPowertrain :> Powertrain {\n    part motor : Motor;\n  }')
    .replace('  // TODO 3: 定义 DualMotorPowertrain 特化 Powertrain，并加入 frontMotor、rearMotor。', '  part def DualMotorPowertrain :> Powertrain {\n    part frontMotor : Motor;\n    part rearMotor : Motor;\n  }')
    .replace('    // TODO 4: 添加 powertrain 的 part usage，类型为 Powertrain。', '    part powertrain : Powertrain;')
    .replace('  // TODO 5: 创建两个 Powertrain 配置和两个 EV，并用 part :>> powertrain 绑定。', '  part standardPowertrain : SingleMotorPowertrain;\n  part performancePowertrain : DualMotorPowertrain;\n\n  part standardEV : Vehicle {\n    part :>> powertrain = standardPowertrain;\n  }\n\n  part performanceEV : Vehicle {\n    part :>> powertrain = performancePowertrain;\n  }')
    .replace('    // TODO 6: 添加 SingleMotorPowertrain 的 expose 视图条目。', '    expose SingleMotorPowertrain;')
    .replace('    // TODO 7: 添加 DualMotorPowertrain 的 expose 视图条目。', '    expose DualMotorPowertrain;')
    .replace('    // TODO 8: 添加 standardPowertrain 的 expose 视图条目。', '    expose standardPowertrain;')
    .replace('    // TODO 9: 添加 performancePowertrain 的 expose 视图条目。', '    expose performancePowertrain;')
    .replace('    // TODO 10: 添加 standardEV 的 expose 视图条目。', '    expose standardEV;')
    .replace('    // TODO 11: 添加 performanceEV 的 expose 视图条目。', '    expose performanceEV;');
}

function completeCourse04Lesson01(source) {
  return source
    .replace('    // TODO 1: 添加 ref item，引用通过功率端口交换的 ElectricalPower。', '    ref item power : ElectricalPower;')
    .replace('    // TODO 2: 添加 BatteryPack 的 port usage dcOut。', '    port dcOut : PowerPort;')
    .replace('    // TODO 3: 添加 Inverter 的 port usage dcIn。', '    port dcIn : PowerPort;')
    .replace('    // TODO 4: 添加 flow，声明 source.power 到 target.power 的功率流向。', '    flow source.power to target.power;');
}

function completeCourse04Lesson02(source) {
  return source
    .replace('    // TODO 1: 添加 attribute 参数 voltageV、currentA、maxPowerKW。', '    attribute voltageV : ScalarValues::Real = 400.0;\n    attribute currentA : ScalarValues::Real = 250.0;\n    attribute maxPowerKW : ScalarValues::Real = 100.0;')
    .replace('    // TODO 2: 添加 attribute 参数 requestedTorqueNm、timestampMs、priority。', '    attribute requestedTorqueNm : ScalarValues::Real = 180.0;\n    attribute timestampMs : ScalarValues::Integer = 0;\n    attribute priority : ScalarValues::Integer = 1;')
    .replace('    // TODO 3: 添加 attribute 参数 flowRateLpm、temperatureC、pressureKPa。', '    attribute flowRateLpm : ScalarValues::Real = 12.0;\n    attribute temperatureC : ScalarValues::Real = 35.0;\n    attribute pressureKPa : ScalarValues::Real = 180.0;')
    .replace('    // TODO 4: 添加 ref item，引用通过控制端口交换的 TorqueCommand。', '    ref item command : TorqueCommand;')
    .replace('    // TODO 5: 添加 ref item，引用通过热管理端口交换的 CoolantFlow。', '    ref item coolant : CoolantFlow;');
}

function completeCourse04Lesson03(source) {
  return source
    .replace('    // TODO 1: 添加高压功率 interface connect usage，绑定电池到逆变器端口。', '    interface powerLink : BatteryToInverter connect battery.dcOut to inverter.dcIn;')
    .replace('    // TODO 2: 添加控制命令 interface connect usage，绑定控制器到逆变器端口。', '    interface torqueCommandLink : ControllerToInverter connect controller.commandOut to inverter.commandIn;')
    .replace('    // TODO 3: 添加电池冷却 interface connect usage，绑定冷却回路到电池端口。', '    interface batteryCoolingLink : BatteryCoolingInterface connect cooling.batterySide to battery.thermalIn;');
}

function completeCourse07Lesson03(source) {
  return source
    .replace('    // TODO 1: 添加 socWindow assume constraint，限定 SOC 工况边界', '    assume constraint socWindow {\n      startSOCPercent == 10.0 and endSOCPercent == 80.0\n    }')
    .replace('    // TODO 2: 添加 voltageBoundary assume constraint，限定额定电压', '    assume constraint voltageBoundary {\n      system.nominalVoltageV <= maxNominalVoltageV\n    }')
    .replace('  // TODO 3: 添加 satisfy fastChargeTime by evPrototype', '  satisfy fastChargeTime by evPrototype;')
    .replace('  // TODO 4: 添加 satisfy hvIsolationSafety by evPrototype.hvSystem', '  satisfy hvIsolationSafety by evPrototype.hvSystem;')
    .replace('    // TODO 5: 添加 expose fastChargeTime', '    expose fastChargeTime;')
    .replace('    // TODO 6: 添加 expose hvIsolationSafety', '    expose hvIsolationSafety;');
}

function completeCourse09Lesson03(source) {
  return source
    .replace('    // TODO 1: 添加 VerificationMethod 元数据，方法为 inspect', '    @VerificationMethod { kind = VerificationMethodKind::inspect; }')
    .replace('    // TODO 2: 添加 VerdictKind return，用 PassIf 判定绝缘观测值', '    return verdict : VerdictKind = PassIf(measuredIsolationOhmPerVolt >= requiredIsolationOhmPerVolt);')
    .replace('    // TODO 3: 添加 VerificationMethod 元数据，方法为 demo', '    @VerificationMethod { kind = VerificationMethodKind::demo; }')
    .replace('    // TODO 4: 添加 inconclusive VerdictKind return，记录证据不完整', '    return verdict : VerdictKind = VerdictKind::inconclusive;')
    .replace('    // TODO 5: 添加 expose isolationInspection', '    expose isolationInspection;')
    .replace('    // TODO 6: 添加 expose safeStateDemonstration', '    expose safeStateDemonstration;');
}

function regressHighVoltageSubject(source) {
  return source
    .replaceAll('subject system : HighVoltageSystem;', 'subject vehicle : ElectricVehicle;')
    .replaceAll('system.isolationOhmPerVolt >= minIsolationOhmPerVolt', 'vehicle.hvSystem.isolationOhmPerVolt >= minIsolationOhmPerVolt');
}

function completeCourse10Lesson03(source) {
  return source
    .replace('    // TODO 1: 添加 targetRangeKm 的 attribute 重定义，目标值为 480.0。', '    attribute :>> targetRangeKm = 480.0;')
    .replace('    // TODO 2: 添加 estimatedRangeKm >= targetRangeKm', '    estimatedRangeKm >= targetRangeKm')
    .replace('    // TODO 3: 添加续航计算 return。', '    return rangeKm : ScalarValues::Real = batteryEnergyKWh * 100.0 / energyPer100Km;')
    .replace('      // TODO 4: 返回 calc 的 rangeKm 输出。', '      return rangeKm;')
    .replace('    // TODO 5: 返回 estimatedRangeKm。', '    return estimatedRangeKm : ScalarValues::Real = estimateRange.rangeKm;')
    .replace('    // TODO 6: 添加 assert constraint rangeCheck 绑定。', '    assert constraint rangeCheck : RangeBalance {\n      in estimatedRangeKm = estimateRange.rangeKm;\n      in targetRangeKm = targetRangeKm;\n    }')
    .replace('    // TODO 7: 添加基于 measuredRangeKm >= requiredRangeKm 的 VerdictKind 判定。', '    return verdict : VerdictKind = PassIf(measuredRangeKm >= requiredRangeKm);')
    .replace('    // TODO 8: 添加 requiredRangeKm 的 attribute 重定义绑定。', '    attribute :>> requiredRangeKm = finalRange.targetRangeKm;')
    .replace('    // TODO 9: 添加 predictedRangeKm 的 attribute 重定义绑定。', '    attribute :>> predictedRangeKm = finalRangeAnalysis.estimatedRangeKm;')
    .replace('    // TODO 10: 添加 measuredRangeKm 的 attribute 重定义绑定。', '    attribute :>> measuredRangeKm = finalVehicle.roadTestRangeKm;')
    .replace('  // TODO 11: 添加 satisfy，说明 finalRange 由 finalVehicle 满足。', '  satisfy finalRange by finalVehicle;')
    .replace('    // TODO 12: 添加 finalRangeAnalysis 的 expose 视图条目。', '    expose finalRangeAnalysis;')
    .replace('    // TODO 13: 添加 finalRangeVerification 的 expose 视图条目。', '    expose finalRangeVerification;');
}

async function expectPass(name, url, payload) {
  const result = await postJson(url, payload);
  assert.strictEqual(result.syntaxValid, true, `${name}: syntax failed\n${JSON.stringify(result, null, 2)}`);
  assert.strictEqual(result.semanticValid, true, `${name}: semantic failed\n${JSON.stringify(result, null, 2)}`);
  assert.strictEqual(result.validationCompleteness, 'official', `${name}: not official\n${JSON.stringify(result, null, 2)}`);
  assert.strictEqual(result.fallbackActive, false, `${name}: fallback active\n${JSON.stringify(result, null, 2)}`);
  assert.strictEqual(result.coursePassed, true, `${name}: course failed\n${JSON.stringify(result, null, 2)}`);
}

async function expectStrictFail(name, url, payload, expected) {
  const result = await postJson(url, payload);
  if (expected.syntaxValid === false) assert.strictEqual(result.syntaxValid, false, `${name}: syntax unexpectedly passed\n${JSON.stringify(result, null, 2)}`);
  if (expected.semanticValid === false) assert.strictEqual(result.semanticValid, false, `${name}: semantic unexpectedly passed\n${JSON.stringify(result, null, 2)}`);
  assert.strictEqual(result.coursePassed, false, `${name}: course unexpectedly passed\n${JSON.stringify(result, null, 2)}`);
  assert.strictEqual(result.validationCompleteness, 'official', `${name}: not official\n${JSON.stringify(result, null, 2)}`);
  if (expected.diagnosticIncludes) {
    assert(hasDiagnostic(result, expected.diagnosticIncludes), `${name}: expected diagnostic containing "${expected.diagnosticIncludes}"\n${JSON.stringify(result, null, 2)}`);
  }
  if (expected.studentHintId) {
    assert(hasStudentHint(result, expected.studentHintId), `${name}: expected studentHint.id "${expected.studentHintId}"\n${JSON.stringify(result, null, 2)}`);
  }
  if (expected.studentHintTitleIncludes) {
    assert(hasStudentHintField(result, expected.studentHintId, 'title', expected.studentHintTitleIncludes), `${name}: expected student hint title containing "${expected.studentHintTitleIncludes}"\n${JSON.stringify(result, null, 2)}`);
  }
  if (expected.studentHintMessageIncludes) {
    assert(hasStudentHintField(result, expected.studentHintId, 'message', expected.studentHintMessageIncludes), `${name}: expected student hint message containing "${expected.studentHintMessageIncludes}"\n${JSON.stringify(result, null, 2)}`);
  }
  if (expected.studentHintGoodExampleIncludes) {
    assert(hasStudentHintField(result, expected.studentHintId, 'goodExample', expected.studentHintGoodExampleIncludes), `${name}: expected student hint goodExample containing "${expected.studentHintGoodExampleIncludes}"\n${JSON.stringify(result, null, 2)}`);
  }
}

async function expectCourseFail(name, url, payload, messagePart) {
  const result = await postJson(url, payload);
  assert.strictEqual(result.syntaxValid, true, `${name}: syntax should pass\n${JSON.stringify(result, null, 2)}`);
  assert.strictEqual(result.semanticValid, true, `${name}: semantic should pass\n${JSON.stringify(result, null, 2)}`);
  assert.strictEqual(result.validationCompleteness, 'official', `${name}: not official\n${JSON.stringify(result, null, 2)}`);
  assert.strictEqual(result.coursePassed, false, `${name}: course should fail\n${JSON.stringify(result, null, 2)}`);
  assert(result.diagnostics.some((diagnostic) => diagnostic.source === 'course-rule'), `${name}: missing course-rule diagnostic\n${JSON.stringify(result, null, 2)}`);
  assert(hasDiagnostic(result, messagePart), `${name}: expected course diagnostic containing "${messagePart}"\n${JSON.stringify(result, null, 2)}`);
}

function hasDiagnostic(result, text) {
  return (result.diagnostics || []).some((diagnostic) => String(diagnostic.message || '').includes(text));
}

function hasStudentHint(result, id) {
  return (result.diagnostics || []).some((diagnostic) => diagnostic.studentHint?.id === id);
}

function hasStudentHintField(result, id, field, text) {
  return (result.diagnostics || []).some((diagnostic) => {
    if (id && diagnostic.studentHint?.id !== id) return false;
    return String(diagnostic.studentHint?.[field] || '').includes(text);
  });
}

function lessonPayload(content) {
  return { entryFile: 'main.sysml', files: [{ path: 'main.sysml', content }] };
}

function lessonPayloadFromLesson(entity, mainContent) {
  const files = (entity.workspace?.files || []).map((file) => ({
    path: file.path,
    content: file.path === 'main.sysml' ? mainContent : file.content || '',
    editable: file.editable !== false
  }));
  return { entryFile: entity.workspace?.entryFile || 'main.sysml', files };
}

function fileContent(entity, filePath) {
  const file = entity.workspace?.files?.find((candidate) => candidate.path === filePath);
  assert(file, `Missing ${filePath} in ${entity.id || entity.title}`);
  return file.content;
}

async function getJson(url) {
  const response = await fetch(url, { headers: authHeaders() });
  const text = await response.text();
  if (!response.ok) assert.fail(`${url} returned ${response.status}: ${text}`);
  return JSON.parse(text);
}

async function postJson(url, body) {
  if (isValidationUrl(url) && rotateGuestSessions && validationRequestsForSession >= VALIDATION_REQUESTS_PER_SESSION) {
    authCookie = await createGuestSession();
    validationRequestsForSession = 0;
  }
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  if (!response.ok) assert.fail(`${url} returned ${response.status}: ${text}`);
  if (isValidationUrl(url)) validationRequestsForSession += 1;
  return JSON.parse(text);
}

async function expectAnonymousValidationDenied() {
  const response = await fetch(`${API}/api/validate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ files: [{ path: 'main.sysml', content: 'package AnonymousProbe;' }] })
  });
  const body = await response.json();
  assert.strictEqual(response.status, 401, 'anonymous learning diagnostics validation must be rejected');
  assert.strictEqual(body.code, 'AUTH_REQUIRED', JSON.stringify(body, null, 2));
}

async function createGuestSession() {
  const response = await fetch(`${API}/api/auth/guest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}'
  });
  const text = await response.text();
  if (!response.ok) assert.fail(`${API}/api/auth/guest returned ${response.status}: ${text}`);
  const cookies = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie')].filter(Boolean);
  const cookie = cookies.map((value) => String(value).split(';', 1)[0]).filter(Boolean).join('; ');
  assert(cookie, 'guest login must return a session cookie for authenticated diagnostics tests');
  return cookie;
}

function authHeaders() {
  return authCookie ? { cookie: authCookie } : {};
}

function isValidationUrl(url) {
  return /\/validate(?:\?|$)/u.test(String(url));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
