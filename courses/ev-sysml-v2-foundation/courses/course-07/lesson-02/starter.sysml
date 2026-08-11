package EV_C07_L02 {
  private import EV_Program_Baseline::*;
  private import RequirementDerivation::*;

  requirement def VehicleRangeRequirement {
    doc /* 城市工况报告续航应不低于 minRangeKm。 */
    subject vehicle : ElectricVehicle;
    attribute minRangeKm : ScalarValues::Real;
    require constraint { vehicle.reportedPredictionKm >= minRangeKm }
  }

  requirement def BatteryEnergyRequirement {
    doc /* 可用电池能量应不低于 minUsableEnergyKWh。 */
    subject battery : BatteryPack;
    attribute minUsableEnergyKWh : ScalarValues::Real;
    require constraint { battery.usableEnergyKWh >= minUsableEnergyKWh }
  }

  requirement def EnergyConsumptionRequirement {
    doc /* 百公里能耗应不高于 maxEnergyPer100Km。 */
    subject vehicle : ElectricVehicle;
    attribute maxEnergyPer100Km : ScalarValues::Real;
    require constraint { vehicle.energyPer100Km <= maxEnergyPer100Km }
  }

  requirement vehicleRange : VehicleRangeRequirement {
    subject vehicle : ElectricVehicle;
    // TODO 1: 添加 minRangeKm 的 attribute 重定义，目标值为 480.0
  }

  requirement usableBatteryEnergy : BatteryEnergyRequirement {
    subject battery : BatteryPack;
    // TODO 2: 添加 minUsableEnergyKWh 的 attribute 重定义，目标值为 78.0
  }

  requirement energyConsumption : EnergyConsumptionRequirement {
    subject vehicle : ElectricVehicle;
    // TODO 3: 添加 maxEnergyPer100Km 的 attribute 重定义，目标值为 16.0
  }

  // TODO 4: 添加 #derivation connection，连接 original 与两个 derive 端点

  satisfy vehicleRange by evPrototype;
  satisfy usableBatteryEnergy by evPrototype.battery;
  satisfy energyConsumption by evPrototype;

  view def RequirementDerivationView specializes StandardViewDefinitions::GeneralView;
  view requirementDerivationView : RequirementDerivationView {
    expose vehicleRange;
    expose usableBatteryEnergy;
    expose energyConsumption;
    expose evPrototype;
  }
}
