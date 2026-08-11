package EV_C10_Baseline {
  private import NumericalFunctions::*;

  item def ElectricalPower {
    attribute voltageV : ScalarValues::Real = 400.0;
    attribute currentA : ScalarValues::Real = 250.0;
    attribute continuousPowerKW : ScalarValues::Real = 100.0;
  }

  item def TorqueCommand {
    attribute requestedTorqueNm : ScalarValues::Real = 180.0;
  }

  port def PowerPort {
    ref item power : ElectricalPower;
  }

  port def CommandPort {
    ref item command : TorqueCommand;
  }

  part def BatteryCell {
    attribute nominalVoltageV : ScalarValues::Real = 3.7;
    attribute capacityAh : ScalarValues::Real = 220.0;
    attribute energyWh : ScalarValues::Real = nominalVoltageV * capacityAh;
    attribute massKg : ScalarValues::Real = 5.0;
  }

  part def BatteryModule {
    attribute cellCount : ScalarValues::Integer = 12;
    part cells[12] : BatteryCell;
    attribute moduleEnergyWh : ScalarValues::Real = sum(cells.energyWh);
  }

  part def BatteryPack {
    attribute moduleCount : ScalarValues::Integer = 8;
    attribute cellsPerModule : ScalarValues::Integer = 12;
    attribute totalCellCount : ScalarValues::Integer = moduleCount * cellsPerModule;
    part modules[8] : BatteryModule;
    attribute totalEnergyWh : ScalarValues::Real = sum(modules.moduleEnergyWh);
    attribute usableEnergyKWh : ScalarValues::Real = totalEnergyWh / 1000.0;
    port dcOut : PowerPort;
  }

  part def Inverter {
    port dcIn : PowerPort;
    port acOut : PowerPort;
    port commandIn : CommandPort;
  }

  part def Motor {
    attribute maxTorqueNm : ScalarValues::Real = 350.0;
    attribute peakPowerKw : ScalarValues::Real = 150.0;
    attribute efficiency : ScalarValues::Real = 0.93;
  }

  part def Wheel {
    attribute diameterM : ScalarValues::Real = 0.65;
    attribute massKg : ScalarValues::Real = 12.0;
  }

  part def VehicleController {
    port commandOut : CommandPort;
  }

  interface def PropulsionPowerInterface {
    end source : PowerPort;
    end target : PowerPort;
    flow source.power to target.power;
  }

  part def ElectricVehicle {
    part battery : BatteryPack;
    part inverter : Inverter;
    part motor : Motor;
    part controller : VehicleController;
    part wheels[4] : Wheel;
    attribute energyPer100Km : ScalarValues::Real = 16.0;
    attribute estimatedRangeKm : ScalarValues::Real = 490.0;
    attribute roadTestRangeKm : ScalarValues::Real = 488.0;
  }

  requirement def RangeRequirement {
    doc /* 整车续航里程应不低于 targetRangeKm，并能追踪到设计、分析和验证证据。 */
    subject vehicle : ElectricVehicle;
    attribute targetRangeKm : ScalarValues::Real;
    require constraint { vehicle.estimatedRangeKm >= targetRangeKm }
  }

  view def BaselineReuseView specializes StandardViewDefinitions::GeneralView;
  view baselineReuseView : BaselineReuseView {
    expose ElectricVehicle;
    expose BatteryPack;
    expose Inverter;
    expose Motor;
    expose RangeRequirement;
  }
}
