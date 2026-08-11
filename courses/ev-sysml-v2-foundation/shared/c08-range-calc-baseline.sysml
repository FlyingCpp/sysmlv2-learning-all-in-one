package EV_Range_Calc_Baseline {
  private import EV_Program_Baseline::*;

  calc def EstimateRange {
    in usableEnergyKWh : ScalarValues::Real;
    in energyPer100Km : ScalarValues::Real;
    return rawRangeKm : ScalarValues::Real =
      usableEnergyKWh * 100.0 / energyPer100Km;
  }

  calc baselineRangeEstimate : EstimateRange {
    in usableEnergyKWh = evPrototype.battery.usableEnergyKWh;
    in energyPer100Km = evPrototype.energyPer100Km;
    return rawRangeKm;
  }

  view def RangeCalcBaselineView specializes StandardViewDefinitions::GeneralView;
  view rangeCalcBaselineView : RangeCalcBaselineView {
    expose EstimateRange;
    expose baselineRangeEstimate;
    expose evPrototype;
  }
}
