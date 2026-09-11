'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { inspectScene } = require('../packages/sysml-plantuml-service/diagram-layout');
const { compileOfficialValidator } = require('./compile-official-validator');
const { SysmlPlantUmlService } = require('../packages/sysml-plantuml-service/service');

async function main() {
  const url = process.env.LAYOUT_VALIDATOR_URL;
  const service = url ? null : new SysmlPlantUmlService(compileOfficialValidator());
  const render = input => url ? fetch(`${url}/plantuml`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }).then(r => r.json()) : service.render(input);
  const content = fs.readFileSync(path.join(__dirname, 'fixtures/plantuml-view-regressions/drone-interfaces.sysml'), 'utf8');
  try {
    const result = await render({ content, viewName: 'flightControllerInterfacesView' });
    if (process.env.INTERFACES_EVIDENCE) fs.writeFileSync(process.env.INTERFACES_EVIDENCE, JSON.stringify(result, null, 2));
    assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
    assert.equal(result.renderer, 'local-layout');
    assert.equal(result.resolvedRenderMode, 'INTERCONNECTION');
    const scene = result.layoutScene;
    assert.deepEqual(['nodes', 'ports', 'edges'].map(k => scene[k].length), [20, 47, 26]);
    assert.deepEqual(inspectScene(result.diagramDocument, scene).issues, []);
    const roots = scene.nodes.filter(n => !n.parentId);
    assert.deepEqual(roots.map(n => n.name).sort(), ['Drone', 'FlightController']);
    function endpoint(id) {
      const port = scene.ports.find(p => p.id === id);
      const names = [port.name];
      let node = scene.nodes.find(n => n.id === port.ownerId);
      while (node) { names.unshift(node.name); node = scene.nodes.find(n => n.id === node.parentId); }
      return names.join('.');
    }
    // 预期逐条取自附件声明；定义根与用法上下文必须有独立端点，不可合并。
    const internal = [
      ['imu.dataOut', 'mainProcessor.imuIn'], ['barometer.dataOut', 'mainProcessor.baroIn'],
      ['magnetometer.dataOut', 'mainProcessor.magIn'], ['mainProcessor.gnssBus', 'gnssIf'],
      ['mainProcessor.rcBus', 'rcIn'], ['mainProcessor.telemetryBus', 'telemetryIf'],
      ['mainProcessor.gimbalBus', 'gimbalControlIf'], ['mainProcessor.pwmOut', 'motorControlOut'],
      ['powerIn', 'mainProcessor.powerIn']
    ];
    const outer = [
      ['flightController.motorControlOut', 'escs.cmdIn'], ['escs.driveOut', 'motors.driveIn'],
      ['gnssModule.dataOut', 'flightController.gnssIf'], ['rcReceiver.output', 'flightController.rcIn'],
      ['flightController.gimbalControlIf', 'gimbalCamera.controlIn'], ['battery.powerOut', 'powerManagement.batteryIn'],
      ['powerManagement.fcPowerOut', 'flightController.powerIn'], ['powerManagement.escPowerOut', 'escs.powerIn']
    ];
    const expected = [...outer.map(pair => pair.map(p => `Drone.${p}`)),
      ...['Drone.flightController', 'FlightController'].flatMap(prefix => internal.map(pair => pair.map(p => `${prefix}.${p}`)))];
    assert.deepEqual(scene.edges.map(e => [endpoint(e.source), endpoint(e.target)].join(' -> ')).sort(),
      expected.map(pair => pair.join(' -> ')).sort());
    assert(scene.nodes.filter(n => ['motors', 'escs', 'propellers'].includes(n.name)).every(n => n.multiplicity === '[4]'));
    const broken = structuredClone(scene);
    const a = broken.ports.find(p => p.name === 'gnssIf');
    const b = broken.ports.find(p => p.ownerId === a.ownerId && p.name === 'rcIn');
    b.x = a.x; b.y = a.y;
    assert(inspectScene(result.diagramDocument, broken).issues.some(i => i.includes('label-overlap')));
    const invalid = await render({ content: 'package Broken { part def', viewName: 'flightControllerInterfacesView' });
    assert.equal(invalid.ok, false);
    console.log('drone interfaces PASS: two roots, 26 exact connections, 47 ports, geometry and invalid-syntax gates');
  } finally { if (service) await service.stop(); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
