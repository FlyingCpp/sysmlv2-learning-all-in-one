package EV_C03_L02 {
  private import NumericalFunctions::*;

  part def Wheel {
    attribute diameterM : ScalarValues::Real = 0.65;
    attribute massKg : ScalarValues::Real = 12.0;
  }

  part def VehicleBody {
    attribute dragCoeff : ScalarValues::Real = 0.28;
    attribute massKg : ScalarValues::Real = 350.0;
  }

  part def Motor;
  part def Controller;

  part def BatteryCell {
    attribute nominalVoltageV : ScalarValues::Real = 3.7;
    attribute capacityAh : ScalarValues::Real = 220.0;
    attribute energyWh : ScalarValues::Real = nominalVoltageV * capacityAh;
    attribute massKg : ScalarValues::Real = 5.0;
  }

  part def BatteryModule {
    // TODO 1: 增加 BatteryModule 的 attribute 参数，并汇总 cells.energyWh。
  }

  part def BatteryPack {
    // TODO 2: 增加 BatteryPack 的 attribute 参数，含 usableEnergyKWh，并汇总 modules.moduleEnergyWh。
  }

  part def ElectricVehicle {
    part body : VehicleBody;
    part battery : BatteryPack;
    part motor : Motor;
    part controller : Controller;
    part wheels[4] : Wheel;
    attribute targetRangeKm : ScalarValues::Real = 480.0;
  }

  // TODO 3: 创建 vehicleBattery 的 part usage，作为电池包配置对象。

  view def PackEnergyGridView specializes StandardViewDefinitions::GridView;
  view packEnergyGridView : PackEnergyGridView {
    expose BatteryCell;
    expose BatteryModule;
    expose BatteryPack;
    expose ElectricVehicle;
  }
}
