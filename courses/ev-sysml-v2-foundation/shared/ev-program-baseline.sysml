package EV_Program_Baseline {
  part def BatteryPack {
    attribute usableEnergyKWh : ScalarValues::Real = 78.0;
  }

  part def HighVoltageSystem {
    attribute nominalVoltageV : ScalarValues::Real = 400.0;
    attribute designIsolationOhmPerVolt : ScalarValues::Real = 620.0;
  }

  part def ElectricVehicle {
    part battery : BatteryPack;
    part hvSystem : HighVoltageSystem;
    attribute energyPer100Km : ScalarValues::Real = 16.0;
    attribute reportedPredictionKm : ScalarValues::Real = 490.0;
    attribute predictedChargeMinutes : ScalarValues::Real = 28.0;
    attribute safeStateCapability : ScalarValues::Boolean = true;
  }

  item def RangeRoadTestEvidence {
    attribute measuredRangeKm : ScalarValues::Real = 488.0;
    attribute configurationRevision : ScalarValues::Integer = 220;
    attribute specimenNumber : ScalarValues::Integer = 7;
  }

  item def SafetyTestEvidence {
    attribute measuredIsolationOhmPerVolt : ScalarValues::Real = 620.0;
    attribute safeStateObserved : ScalarValues::Boolean = false;
    attribute configurationRevision : ScalarValues::Integer = 220;
    attribute specimenNumber : ScalarValues::Integer = 7;
  }

  part evPrototype : ElectricVehicle;
  item rangeRoadTestEvidence : RangeRoadTestEvidence;
  item safetyTestEvidence : SafetyTestEvidence;

  view def ProgramBaselineView specializes StandardViewDefinitions::GeneralView;
  view programBaselineView : ProgramBaselineView {
    expose ElectricVehicle;
    expose evPrototype;
    expose rangeRoadTestEvidence;
    expose safetyTestEvidence;
  }
}
