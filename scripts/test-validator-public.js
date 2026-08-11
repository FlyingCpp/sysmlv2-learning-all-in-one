'use strict';

const assert = require('assert');
const { validateWorkspace } = require('../apps/validator/local-analyzer');
const { _selectEntryFileViewName } = require('../apps/validator/validator');

const validModel = validateWorkspace({
  content: `
    package SynFeldValidatorSmoke {
      part def Vehicle;
      part vehicle : Vehicle;
      view vehicleView : StandardViewDefinitions::GeneralView {
        expose Vehicle;
        expose vehicle;
      }
    }
  `
});

assert.strictEqual(validModel.valid, true, JSON.stringify(validModel.diagnostics, null, 2));
assert(validModel.modelElements.some((element) => element.kind === 'part def' && element.name === 'Vehicle'));
assert(validModel.modelElements.some((element) => element.kind === 'part' && element.name === 'vehicle'));

const invalidModel = validateWorkspace({
  content: `
    package SynFeldValidatorBroken {
      part vehicle : MissingVehicleType;
  `
});

assert.strictEqual(invalidModel.valid, false, 'an unterminated package must fail local validation');
assert(invalidModel.diagnostics.length > 0, 'invalid source must return diagnostics');

const selectedView = _selectEntryFileViewName([{
  path: 'main.sysml',
  content: `
    package SynFeldViewSelection {
      part def Vehicle;
      view vehicleView : StandardViewDefinitions::GeneralView {
        expose Vehicle;
      }
    }
  `
}], 'main.sysml');

assert.strictEqual(selectedView, 'SynFeldViewSelection::vehicleView');
console.log('public validator tests passed');
