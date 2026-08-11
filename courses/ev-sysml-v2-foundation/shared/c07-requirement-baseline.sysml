package EV_Requirement_Baseline {
  private import EV_Program_Baseline::*;
  private import RequirementDerivation::*;

  requirement def VehicleRangeRequirement {
    doc /* 城市工况报告续航应不低于 minRangeKm，能耗应不高于 maxEnergyPer100Km。 */
    subject vehicle : ElectricVehicle;
    attribute minRangeKm : ScalarValues::Real;
    attribute maxEnergyPer100Km : ScalarValues::Real;
    require constraint rangeCriterion {
      vehicle.reportedPredictionKm >= minRangeKm
    }
    require constraint energyCriterion {
      vehicle.energyPer100Km <= maxEnergyPer100Km
    }
  }

  requirement def BatteryEnergyRequirement {
    doc /* 为支撑整车续航，电池包可用能量应不低于 minUsableEnergyKWh。 */
    subject battery : BatteryPack;
    attribute minUsableEnergyKWh : ScalarValues::Real;
    require constraint {
      battery.usableEnergyKWh >= minUsableEnergyKWh
    }
  }

  requirement def EnergyConsumptionRequirement {
    doc /* 为支撑整车续航，百公里能耗应不高于 maxEnergyPer100Km。 */
    subject vehicle : ElectricVehicle;
    attribute maxEnergyPer100Km : ScalarValues::Real;
    require constraint {
      vehicle.energyPer100Km <= maxEnergyPer100Km
    }
  }

  requirement vehicleRange : VehicleRangeRequirement {
    subject vehicle : ElectricVehicle;
    attribute :>> minRangeKm = 480.0;
    attribute :>> maxEnergyPer100Km = 16.0;
  }

  requirement usableBatteryEnergy : BatteryEnergyRequirement {
    subject battery : BatteryPack;
    attribute :>> minUsableEnergyKWh = 78.0;
  }

  requirement energyConsumption : EnergyConsumptionRequirement {
    subject vehicle : ElectricVehicle;
    attribute :>> maxEnergyPer100Km = 16.0;
  }

  #derivation connection {
    end #original ::> vehicleRange;
    end #derive ::> usableBatteryEnergy;
    end #derive ::> energyConsumption;
  }

  satisfy vehicleRange by evPrototype;
  satisfy usableBatteryEnergy by evPrototype.battery;
  satisfy energyConsumption by evPrototype;

  view def RequirementBaselineView specializes StandardViewDefinitions::GeneralView;
  view requirementBaselineView : RequirementBaselineView {
    expose vehicleRange;
    expose usableBatteryEnergy;
    expose energyConsumption;
    expose evPrototype;
  }
}
