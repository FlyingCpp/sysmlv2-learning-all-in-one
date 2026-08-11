package EV_C03_L03 {
  private import NumericalFunctions::*;

  part def Wheel {
    attribute diameterM : ScalarValues::Real = 0.65;
    attribute massKg : ScalarValues::Real = 12.0;
  }

  part def VehicleBody {
    attribute dragCoeff : ScalarValues::Real = 0.28;
    attribute massKg : ScalarValues::Real = 350.0;
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
    attribute moduleVoltageV : ScalarValues::Real = sum(cells.nominalVoltageV);
    attribute moduleEnergyWh : ScalarValues::Real = sum(cells.energyWh);
  }

  part def BatteryPack {
    attribute moduleCount : ScalarValues::Integer = 8;
    attribute cellsPerModule : ScalarValues::Integer = 12;
    attribute totalCellCount : ScalarValues::Integer = moduleCount * cellsPerModule;
    part modules[8] : BatteryModule;
    attribute totalEnergyWh : ScalarValues::Real = sum(modules.moduleEnergyWh);
    attribute usableEnergyKWh : ScalarValues::Real = totalEnergyWh / 1000.0;
  }

  part def Motor {
    attribute maxTorqueNm : ScalarValues::Real = 350.0;
    attribute maxPowerKw : ScalarValues::Real = 150.0;
  }

  // TODO 1: 定义 abstract part def Powertrain。

  // TODO 2: 定义 SingleMotorPowertrain 特化 Powertrain，并加入 motor part。

  // TODO 3: 定义 DualMotorPowertrain 特化 Powertrain，并加入 frontMotor、rearMotor。

  part def Vehicle {
    part battery : BatteryPack;
    // TODO 4: 添加 powertrain 的 part usage，类型为 Powertrain。
    attribute targetRangeKm : ScalarValues::Real = 480.0;
  }

  // TODO 5: 创建两个 Powertrain 配置和两个 EV，并用 part :>> powertrain 绑定。

  view def ProductVariantView specializes StandardViewDefinitions::GeneralView;
  view productVariantView : ProductVariantView {
    expose Vehicle;
    expose BatteryPack;
    expose Motor;
    expose Wheel;
    // TODO 6: 添加 SingleMotorPowertrain 的 expose 视图条目。
    // TODO 7: 添加 DualMotorPowertrain 的 expose 视图条目。
    // TODO 8: 添加 standardPowertrain 的 expose 视图条目。
    // TODO 9: 添加 performancePowertrain 的 expose 视图条目。
    // TODO 10: 添加 standardEV 的 expose 视图条目。
    // TODO 11: 添加 performanceEV 的 expose 视图条目。
  }
}
